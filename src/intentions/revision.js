import { Intention } from './intention.js';
import { listOptions } from '../deliberation/options.js';

/**
 * @typedef {import('../beliefs/index.js').Beliefs} Beliefs
 * @typedef {import('../types.js').Option} Option
 * @typedef {import('../plans/library.js').Plan} Plan
 */

/**
 * Something the loop reports about an intention:
 * - 'commit': the agent starts working on this option.
 * - 'drop':   the agent stops it early, because a better option appeared
 *             or its parcel is gone.
 * - 'done':   the plan finished and the option was achieved.
 * - 'failed': the plan ended without achieving the option.
 * @typedef {Object} RevisionEvent
 * @property {'commit' | 'drop' | 'done' | 'failed'} kind
 * @property {Option} option
 * @property {string} [reason]  why it was dropped or failed
 */

/**
 * Decides whether the agent should stop its current option and start the
 * candidate instead (design.md section 3). The rules, in order:
 * 1. No candidate: keep the current option.
 * 2. No current option (the agent is idle): take the candidate.
 * 3. The candidate is the current option itself: keep it.
 * 4. Different priorities: the higher priority wins.
 * 5. Same priority: switch only if the candidate is worth more than
 *    `margin` times the current value AND at least 1 point more. The
 *    1-point rule stops the agent from hopping between options worth 0.
 * @param {Option | undefined} current  its utility must be up to date
 * @param {Option | undefined} candidate
 * @param {number} margin  e.g. 1.2 means the candidate must be 20% better
 */
export function shouldSwitch(current, candidate, margin) {
  if (!candidate) return false;
  if (!current) return true;
  if (candidate.id === current.id) return false;
  if (candidate.priority !== current.priority) return candidate.priority > current.priority;
  return candidate.utility > current.utility * margin && candidate.utility >= current.utility + 1;
}

/**
 * The option to work on next: the highest priority, and among those the
 * highest utility.
 * @param {Option[]} options
 * @returns {Option | undefined}
 */
export function bestOf(options) {
  return options.reduce((/** @type {Option | undefined} */ best, o) =>
    !best || o.priority > best.priority || (o.priority === best.priority && o.utility > best.utility) ? o : best, undefined);
}

/**
 * The agent loop (design.md section 3). It picks the best option, runs its
 * plan until the plan ends, and starts again.
 *
 * Whenever the beliefs change, the current intention is checked again
 * (see `revise`): it is stopped if a clearly better option exists, or, for
 * a pickup, if its parcel can no longer be picked up.
 */
export class IntentionRevision {
  /** @type {Intention | undefined} */
  current;
  #halted = false;
  /** @type {(() => void)[]} */
  #waiting = [];

  /**
   * @param {Object} setup
   * @param {Beliefs} setup.beliefs
   * @param {Partial<Record<Option['type'], Plan>>} setup.plans
   * @param {number} setup.margin  see `shouldSwitch`
   * @param {() => Option[]} [setup.options]  returns the current options;
   *   `listOptions` by default
   * @param {number} [setup.idleMs]  when there is nothing to do, look again
   *   after this long even if no message arrived. Needed because a refused
   *   move stops being avoided after a while, and no message says so.
   * @param {(event: RevisionEvent) => void} [setup.onEvent]  called for
   *   every event, e.g. to log it
   */
  constructor({ beliefs, plans, margin, options = () => listOptions(beliefs), idleMs = 1000, onEvent = () => {} }) {
    this.beliefs = beliefs;
    this.plans = plans;
    this.margin = margin;
    this.options = options;
    this.idleMs = idleMs;
    this.onEvent = onEvent;
    beliefs.onChange(() => {
      this.revise();
      this.#wakeUp();
    });
  }

  /** Runs until `halt()` is called. Resolves when the last intention has ended. */
  async run() {
    while (!this.#halted) {
      const best = this.beliefs.ready ? bestOf(this.options()) : undefined;
      if (!best) {
        await this.#nextChange();
        continue;
      }
      const intention = new Intention(best, this.plans);
      this.current = intention;
      this.onEvent({ kind: 'commit', option: best });
      const achieved = await intention.achieve();
      this.current = undefined;
      if (achieved) this.onEvent({ kind: 'done', option: best });
      else if (!intention.stopped) this.onEvent({ kind: 'failed', option: best, reason: intention.failure });
      // After a failure, wait for something to change before trying again,
      // otherwise the same option would fail again at once.
      if (achieved || intention.stopped) await new Promise(resolve => setImmediate(resolve));
      else await this.#nextChange();
    }
  }

  /** Stops the current intention and ends the loop. */
  halt() {
    this.#halted = true;
    this.current?.stop();
    this.#wakeUp();
  }

  /**
   * Scores the current intention again with the latest beliefs and stops it
   * if it is no longer worth doing.
   */
  revise() {
    const intention = this.current;
    if (!intention || intention.stopped) return;
    const { option } = intention;
    // The parcel was just picked up on the way: the pickup is done, keep it.
    if (option.type === 'pickup' && this.#carrying(option.parcelId)) return;
    const options = this.options();
    const fresh = options.find(o => o.id === option.id);
    // A pickup that is no longer offered (parcel taken, gone, unreachable or
    // another agent will get there first) is stopped at once. The switching
    // rule would keep it, since it is worth 0 just like exploring.
    if (option.type === 'pickup' && !fresh) return this.#drop(intention, 'parcel no longer available');
    const best = bestOf(options);
    if (shouldSwitch(fresh ?? { ...option, utility: 0 }, best, this.margin)) {
      this.#drop(intention, `${best?.id} is better`);
    }
  }

  /**
   * Whether the agent itself is carrying this parcel.
   * @param {string | undefined} parcelId
   */
  #carrying(parcelId) {
    const me = this.beliefs.me;
    return !!me && this.beliefs.parcels.carriedBy(me.id, this.beliefs.now()).some(p => p.id === parcelId);
  }

  /** @param {Intention} intention @param {string} reason */
  #drop(intention, reason) {
    intention.stop();
    this.onEvent({ kind: 'drop', option: intention.option, reason });
  }

  /** Resolves at the next change in the beliefs, or after `idleMs`, whichever comes first. */
  #nextChange() {
    if (this.#halted) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.#waiting = this.#waiting.filter(w => w !== done);
        resolve(undefined);
      };
      const timer = setTimeout(done, this.idleMs);
      this.#waiting.push(done);
    });
  }

  /** Ends every `#nextChange` wait now. */
  #wakeUp() {
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const done of waiting) done();
  }
}
