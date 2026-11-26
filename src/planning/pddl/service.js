import { courseSolver } from './solve.js';
import { decodePlan } from './problem.js';

/**
 * Asks the course's online solver for the plan of one intention and checks
 * the answer. The solver is slow (about 4 s a call) and sometimes down, so
 * every call has a timeout, and a circuit breaker stops calling it for a
 * while after several failures in a row:
 *
 * - Only real failures count: a timeout, a network or solver error, or a plan
 *   that does not pass the check. Calls that are never made do not count.
 * - After `breakerFailures` failures in a row the breaker opens, and the
 *   solver is skipped for `breakerCooldownMs`.
 * - After that, one call is let through. If it works the breaker closes; if
 *   not, it opens again for another cooldown. While that call runs, other
 *   calls are skipped.
 *
 * At most `maxConcurrent` requests run at once; a call beyond that is
 * skipped, and the agent goes on with A*. A request that timed out still
 * polls the solver in the background (the course client cannot cancel it),
 * so it keeps its place until it settles, or for `zombieMs` at most, so that
 * such requests cannot pile up.
 *
 * `plan` never throws; its answer says whether a plan came back, the call
 * failed, or it was skipped.
 */
export class PlannerService {
  /**
   * @param {{ solve?: (domain: string, problem: string) => Promise<unknown>, timeoutMs?: number,
   *   breakerFailures?: number, breakerCooldownMs?: number, maxConcurrent?: number, zombieMs?: number,
   *   now?: () => number, log?: (event: string, details: object) => void }} [settings]
   */
  constructor({ solve = courseSolver, timeoutMs = 10_000, breakerFailures = 3, breakerCooldownMs = 60_000,
    maxConcurrent = 2, zombieMs = 60_000, now = Date.now, log = () => {} } = {}) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.zombieMs = zombieMs;
    /** How many requests are still running, those that timed out included. */
    this.running = 0;
    this.solve = solve;
    this.timeoutMs = timeoutMs;
    this.breakerFailures = Math.max(1, breakerFailures);
    this.breakerCooldownMs = breakerCooldownMs;
    this.now = now;
    this.log = log;
    /** How many calls failed in a row. */
    this.failures = 0;
    /** @type {number | null} when the breaker last opened, or null while it is closed */
    this.openedAt = null;
    /** Whether the one call allowed after a cooldown is running. */
    this.trialRunning = false;
  }

  /**
   * Count a request as running until it settles, or for zombieMs at most.
   * @param {Promise<unknown>} request
   */
  #holdPlace(request) {
    this.running++;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      this.running--;
      clearTimeout(timer);
    };
    const timer = setTimeout(release, this.zombieMs);
    timer.unref?.();
    request.then(release, release);
  }

  /** @returns {'closed' | 'open' | 'half-open'} */
  get breaker() {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.breakerCooldownMs ? 'half-open' : 'open';
  }

  /**
   * @param {import('../../types.js').ProblemSpec} spec
   * @returns {Promise<{ status: 'ok', plan: import('../../types.js').DecodedPlan, durationMs: number }
   *   | { status: 'skipped', reason: string } | { status: 'failed', reason: string }>}
   */
  async plan(spec) {
    const state = this.breaker;
    if (state === 'open' || (state === 'half-open' && this.trialRunning)) {
      const reason = 'circuit breaker open';
      this.log('planner_fallback', { reason, fallback: 'astar', goal: spec.goal.kind });
      return { status: 'skipped', reason };
    }
    if (this.running >= this.maxConcurrent) {
      const reason = 'solver busy';
      this.log('planner_fallback', { reason, fallback: 'astar', goal: spec.goal.kind, running: this.running });
      return { status: 'skipped', reason };
    }
    const trial = state === 'half-open';
    if (trial) {
      this.trialRunning = true;
      this.log('pddl_breaker_half_open', {});
    }
    const began = Date.now();
    this.log('pddl_call', { goal: spec.goal.kind, from: spec.from, tiles: spec.tiles, edges: spec.edges.size, carried: spec.carried });
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const request = Promise.resolve().then(() => this.solve(spec.domain, spec.problem));
    this.#holdPlace(request);
    try {
      const answer = await Promise.race([
        request,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('External solver timeout')), this.timeoutMs); }),
      ]);
      const plan = decodePlan(answer, spec);
      const durationMs = Date.now() - began;
      this.log('pddl_success', { goal: spec.goal.kind, actions: plan.steps.length, durationMs });
      this.failures = 0;
      if (this.openedAt !== null) {
        this.openedAt = null;
        this.log('pddl_breaker_closed', {});
      }
      return { status: 'ok', plan, durationMs };
    } catch (error) {
      const reason = String(error instanceof Error ? error.message : error);
      this.log('pddl_failure', { goal: spec.goal.kind, reason, durationMs: Date.now() - began });
      this.failures++;
      if (trial || this.failures >= this.breakerFailures) {
        this.openedAt = this.now();
        this.log('pddl_breaker_open', { failures: this.failures, cooldownMs: this.breakerCooldownMs });
      }
      return { status: 'failed', reason };
    } finally {
      clearTimeout(timer);
      if (trial) this.trialRunning = false;
    }
  }
}
