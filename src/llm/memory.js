/** Compact, replaceable LLM context. It does not claim that old observations are still true. */
export class WorkingMemory {
  /** @param {{maxEvents?:number, observationTtlMs?:number, maxTextLength?:number, now?:()=>number}} [options] */
  constructor({ maxEvents = 12, observationTtlMs = 15_000, maxTextLength = 1200, now = Date.now } = {}) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || !Number.isFinite(observationTtlMs) || observationTtlMs < 0) throw new Error('Invalid memory bounds');
    this.maxEvents = maxEvents;
    this.observationTtlMs = observationTtlMs;
    this.maxTextLength = maxTextLength;
    this.now = now;
    this.objective = '';
    this.objectiveVersion = 0;
    /** @type {{data:unknown,at:number}|null} */ this.observation = null;
    /** @type {{steps:{tool:string,reason:string}[],summary:string}|null} */ this.plan = null;
    /** @type {{kind:string,at:number,details:unknown}[]} */ this.events = [];
  }

  /** @param {unknown} value */
  #bounded(value) {
    const raw = JSON.stringify(value);
    if (raw === undefined) throw new Error('Memory values must be JSON serializable');
    // Store a valid JSON value; truncate large strings, never arbitrarily cut JSON syntax.
    if (raw.length > this.maxTextLength) return { truncated: true, preview: raw.slice(0, this.maxTextLength) };
    return JSON.parse(raw);
  }

  /** @param {string} objective */
  setObjective(objective) {
    if (typeof objective !== 'string' || !objective.trim()) throw new Error('Objective must be nonempty');
    this.objective = objective.trim().slice(0, this.maxTextLength);
    this.objectiveVersion++;
    this.plan = null;
    this.events = []; // Do not blend past objective tool outcomes into the new goal.
  }

  /** @param {unknown} observation */
  updateObservation(observation) {
    this.observation = { data: this.#bounded(observation), at: this.now() };
  }

  /** @param {{steps:{tool:string,reason:string}[],summary:string}} plan */
  setPlan(plan) { this.plan = structuredClone(plan); }

  /** @param {string} kind @param {unknown} details */
  record(kind, details) {
    this.events.push({ kind, at: this.now(), details: this.#bounded(details) });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }

  /** @returns {{objective:string,objectiveVersion:number,observation:unknown,observationAgeMs:number|null,plan:unknown,events:unknown[]}} */
  snapshot() {
    const age = this.observation ? Math.max(0, this.now() - this.observation.at) : null;
    return {
      objective: this.objective, objectiveVersion: this.objectiveVersion,
      observation: age !== null && age <= this.observationTtlMs ? structuredClone(this.observation?.data) : null,
      observationAgeMs: age,
      plan: structuredClone(this.plan), events: structuredClone(this.events),
    };
  }
}
