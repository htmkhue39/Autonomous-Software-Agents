/**
 * Serialize all game-changing actions. If an SDK promise exceeds its deadline,
 * DO NOT start another action until the original promise settles. A timeout
 * means UNKNOWN, not failure: never blindly retry a move or pickup.
 */
export class ActionGate {
  /** @type {Promise<unknown> | null} */
  #pending = null;
  /** @param {{ timeoutMs?: number }} [options] */
  constructor({ timeoutMs = 8000 } = {}) {
    this.timeoutMs = timeoutMs;
  }
  get busy() { return this.#pending !== null; }

  /**
   * @template T
   * @param {string} kind
   * @param {() => Promise<T>} invoke
   * @returns {Promise<{status:'ok', value:T} | {status:'unknown', reason:string} | {status:'busy'}>}
   */
  async call(kind, invoke) {
    if (this.busy) return { status: 'busy' };
    // Attach a rejection handler immediately so even a late failure is handled.
    const op = Promise.resolve().then(invoke).then(
      value => ({ status: /** @type {const} */ ('ok'), value }),
      error => ({ status: /** @type {const} */ ('unknown'), reason: String(error?.message ?? error) }),
    );
    this.#pending = op;
    void op.then(() => { if (this.#pending === op) this.#pending = null; });
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) return op;
    let timer;
    try {
      return await Promise.race([
        op,
        new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'unknown', reason: `${kind} exceeded ${this.timeoutMs}ms; outcome must be reconciled` }), this.timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
}
