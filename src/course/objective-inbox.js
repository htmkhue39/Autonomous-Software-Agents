import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Serialized, latest-wins objective updates. The old run is interrupted only
 * at a checkpoint with no active tool/SDK action. An uncertain outcome halts
 * further objectives until authoritative reconciliation outside this module.
 * This is a LOCAL NDJSON demonstration channel, not an instructor API claim.
 */
export class ObjectiveInbox {
  /** @param {{runObjective:(goal:string,options:{signal:AbortSignal})=>Promise<any>,
   *  stopCurrent:()=>void,isActionBusy:()=>boolean,log?:(event:string,details:object)=>void,
   *  pollMs?:number,maxDeferredMs?:number}} options */
  constructor({ runObjective, stopCurrent, isActionBusy, log = () => {}, pollMs = 50, maxDeferredMs = 30_000 }) {
    if (![runObjective, stopCurrent, isActionBusy].every(x => typeof x === 'function')) throw new Error('ObjectiveInbox needs runtime hooks');
    this.runObjective = runObjective; this.stopCurrent = stopCurrent; this.isActionBusy = isActionBusy;
    if (!Number.isFinite(maxDeferredMs) || maxDeferredMs <= 0) throw new Error('Invalid deferred-action timeout');
    this.log = log; this.pollMs = pollMs; this.maxDeferredMs = maxDeferredMs; this.pendingAt = 0;
    /** @type {{id:string,objective:string}|null} */ this.pending = null;
    /** @type {AbortController|null} */ this.controller = null;
    /** @type {Promise<void>|null} */ this.active = null;
    this.closed = false; this.quarantined = false; this.nextSequence = 0;
    /** @type {Set<string>} */ this.ids = new Set();
  }

  /** @param {{id?:string,objective:string}} message */
  submit(message) {
    if (this.closed || this.quarantined) throw new Error('Objective inbox closed or quarantined');
    if (!message || typeof message.objective !== 'string' || !message.objective.trim() || message.objective.length > 2000)
      throw new Error('Objective must contain 1–2000 characters');
    const id = message.id ?? `local-${++this.nextSequence}`;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid objective ID');
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    const task = { id, objective: message.objective.trim() };
    if (!this.active) this.#launch(task);
    else {
      const replaced = this.pending?.id ?? null;
      this.pending = task; this.pendingAt = Date.now();
      this.log('course_objective_queued', { id, supersedes: replaced, reason: 'await_safe_boundary' });
    }
    return true;
  }

  /** @param {{id:string,objective:string}} task */
  #launch(task) {
    if (this.closed || this.quarantined) return;
    const controller = new AbortController(); this.controller = controller;
    this.log('course_objective_started', { id: task.id, objective: task.objective });
    this.active = (async () => {
      /** @type {any} */ let result;
      try { result = await this.runObjective(task.objective, { signal: controller.signal }); }
      catch (error) { result = { status: 'error', reason: error instanceof Error ? error.message : String(error) }; }
      this.log('course_objective_finished', { id: task.id, status: result?.status, reason: result?.reason });
      if (result?.reason === 'uncertain_tool_outcome' || this.isActionBusy()) {
        this.quarantined = true;
        this.log('course_objective_quarantined', { id: task.id, reason: result?.reason === 'uncertain_tool_outcome' ? 'uncertain_tool_outcome' : 'unsettled_sdk_action' });
      }
    })().finally(() => {
      this.controller = null; this.active = null;
      if (!this.closed && !this.quarantined && this.pending) {
        const next = this.pending; this.pending = null; this.#launch(next);
      }
    });
    // When a newer objective arrives, cancel at the first safe checkpoint.
    void this.#watchPending(controller);
  }

  /** @param {AbortController} controller */
  async #watchPending(controller) {
    while (!this.closed && !this.quarantined && !controller.signal.aborted && this.controller === controller) {
      if (this.pending && this.isActionBusy() && Date.now() - this.pendingAt > this.maxDeferredMs) {
        this.quarantined = true;
        this.log('course_objective_quarantined', { id: this.pending.id, reason: 'unsafe_action_did_not_settle' });
        controller.abort(); this.stopCurrent();
        return;
      }
      if (this.pending && !this.isActionBusy()) {
        controller.abort(); this.stopCurrent();
        this.log('course_objective_replacement_requested', { nextId: this.pending.id });
        return;
      }
      await sleep(this.pollMs);
    }
  }

  /** Wait until the queue settles or throw on unresolved action safety. */
  async drain() {
    while (this.active) await this.active;
    if (this.quarantined) throw new Error('Objective replacement blocked: game action outcome requires reconciliation');
  }

  stop() { this.closed = true; this.pending = null; this.controller?.abort(); this.stopCurrent(); }
}

/** @param {string} text */
export function parseObjectiveLine(text) {
  if (text.length > 4096) throw new Error('Objective message too large');
  /** @type {any} */ let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Objective update must be one JSON object per line'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    (parsed.type !== undefined && parsed.type !== 'objective') ||
    typeof parsed.objective !== 'string' ||
    (parsed.id !== undefined && typeof parsed.id !== 'string')) throw new Error('Invalid objective update');
  return { id: parsed.id, objective: parsed.objective };
}
