/**
 * @typedef {import('../types.js').Option} Option
 * @typedef {import('../types.js').StopSignal} StopSignal
 * @typedef {import('../plans/library.js').Plan} Plan
 */

/**
 * The option the agent is working on now (design.md section 3). It runs the
 * plan that matches the option's type, and it can be stopped while the plan
 * is running.
 */
export class Intention {
  /** @type {StopSignal} */
  #signal = { stopped: false };
  /** @type {string | undefined} why the intention failed; unset until it fails */
  failure;

  /**
   * @param {Option} option
   * @param {Partial<Record<Option['type'], Plan>>} plans
   */
  constructor(option, plans) {
    this.option = option;
    this.plans = plans;
  }

  get stopped() {
    return this.#signal.stopped;
  }

  /** Asks the plan to stop. The plan checks this before each step. */
  stop() {
    this.#signal.stopped = true;
  }

  /**
   * Runs the plan. It never throws: if there is no plan for this type, the
   * plan throws, or the plan ends without achieving the option, it returns
   * false and puts the reason in `failure`.
   * @returns {Promise<boolean>} true when the option was achieved
   */
  async achieve() {
    const plan = this.plans[this.option.type];
    if (!plan) return this.#fail(`no plan for ${this.option.type}`);
    try {
      if (await plan(this.option, this.#signal)) return true;
      return this.#fail(this.stopped ? 'stopped' : 'not achieved');
    } catch (error) {
      return this.#fail(`plan crashed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** @param {string} reason */
  #fail(reason) {
    this.failure = reason;
    return false;
  }
}
