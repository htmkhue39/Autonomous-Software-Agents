import { buildNavigationProblem, decodeNavigationPlan } from './problem.js';
import { decodeTaskPlan } from './task-problem.js';

/** The external course planner; import on demand so pure-unit tests work offline.
 * @param {string} domain
 * @param {string} problem
 */
export async function courseSolver(domain, problem) {
  const { onlineSolver } = await import('@unitn-asa/pddl-client');
  return onlineSolver(domain, problem);
}

/**
 * @param {import('../../beliefs/map.js').GridMap} map
 * @param {import('../../types.js').Position} from
 * @param {import('../../types.js').Position} to
 * @param {import('../../types.js').PathOptions} options
 * @param {{ solve?: typeof courseSolver, timeoutMs?: number, log?: (event:string, details:object)=>void }} [settings]
 */
export async function solveNavigation(map, from, to, options, { solve = courseSolver, timeoutMs = 5000, log = () => {} } = {}) {
  if (from.x === to.x && from.y === to.y) return [];
  const spec = buildNavigationProblem(map, from, to, options);
  if (!spec) throw new Error('PDDL problem has no valid start/goal');
  const began = Date.now();
  log('pddl_call', { from, to });
  let timer;
  try {
    const plan = await Promise.race([
      Promise.resolve().then(() => solve(spec.domain, spec.problem)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('External solver timeout')), timeoutMs); }),
    ]);
    const moves = decodeNavigationPlan(plan, map, from, to, options);
    log('pddl_success', { from, to, moves: moves.length, durationMs: Date.now() - began });
    return moves;
  } catch (error) {
    log('pddl_failure', { from, to, reason: String(error instanceof Error ? error.message : error), durationMs: Date.now() - began });
    throw error;
  } finally { clearTimeout(timer); }
}

/**
 * Ask the solver for a task plan and decode it (see task-problem.js). The
 * call is logged as 'pddl_task_call', and its end as 'pddl_task_success' or
 * 'pddl_task_failure' with the reason, each with the time it took. A timeout,
 * an error or a plan that fails decoding all throw, so that the caller falls
 * back to its own choice.
 * @param {import('./task-problem.js').TaskSpec} spec
 * @param {{ solve?: typeof courseSolver, timeoutMs?: number, log?: (event:string, details:object)=>void }} [settings]
 * @returns {Promise<import('./task-problem.js').Task[]>}
 */
export async function solveTasks(spec, { solve = courseSolver, timeoutMs = 3000, log = () => {} } = {}) {
  const began = Date.now();
  const size = { parcels: spec.parcels.size, carried: spec.carried.size, places: spec.locations.size, slots: spec.slots.length };
  log('pddl_task_call', size);
  let timer;
  try {
    const plan = await Promise.race([
      Promise.resolve().then(() => solve(spec.domain, spec.problem)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('External solver timeout')), timeoutMs); }),
    ]);
    const tasks = decodeTaskPlan(plan, spec);
    log('pddl_task_success', { ...size, actions: tasks.length, durationMs: Date.now() - began });
    return tasks;
  } catch (error) {
    log('pddl_task_failure', { ...size, reason: String(error instanceof Error ? error.message : error), durationMs: Date.now() - began });
    throw error;
  } finally { clearTimeout(timer); }
}
