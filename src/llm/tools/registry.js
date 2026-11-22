import { ValidationError, checkSchema, validate } from '../validation.js';

/** Explicit, machine-readable failure from an allowed tool. */
export class ToolFailure extends Error {
  /** @param {'game_action_failed'|'outcome_unknown'|'not_ready'|'coordination_conflict'} code
   * @param {string} message
   * @param {{precondition?:boolean,reason?:string,alternatives?:{id:string,expectedDeliveryReward:number}[]}} [details]
   */
  constructor(code, message, details = {}) {
    super(message); this.name = 'ToolFailure'; this.code = code;
    this.precondition = details.precondition === true;
    this.reason = details.reason ?? null;
    this.alternatives = details.alternatives?.slice(0, 3) ?? [];
  }
}

/** @typedef {import('../validation.js').SimpleSchema} SimpleSchema */
/** @typedef {{name:string, description:string, parameters:SimpleSchema, execute:(args:any, context:{signal?:AbortSignal})=>Promise<unknown>|unknown}} ToolDefinition */

/** Exact allowlist of executable tools. No dynamic imports, eval, or shell execution. */
export class ToolRegistry {
  constructor() { /** @type {Map<string,ToolDefinition>} */ this.definitions = new Map(); this.activeCalls = 0; this.hasUncertainOutcome = false; }

  /** @param {ToolDefinition} definition */
  register(definition) {
    if (!definition || !/^[a-z][a-z0-9_]{0,63}$/.test(definition.name)) throw new Error('Invalid tool name');
    if (definition.name === 'finish_objective') throw new Error('finish_objective is reserved for the LLM loop');
    if (!definition.description || typeof definition.description !== 'string') throw new Error('Tool description is required');
    if (typeof definition.execute !== 'function') throw new Error('Tool execute function is required');
    if (this.definitions.has(definition.name)) throw new Error(`Duplicate tool: ${definition.name}`);
    checkSchema(definition.parameters);
    if (definition.parameters.type !== 'object') throw new Error('Tool arguments must use an object schema');
    this.definitions.set(definition.name, definition);
    return this;
  }

  /** @returns {any[]} */
  getSpecs() {
    return [...this.definitions.values()].map(({ name, description, parameters }) => ({
      type: 'function', function: { name, description, parameters: structuredClone(parameters) },
    }));
  }

  /**
   * @param {{name:unknown,arguments:unknown}} call
   * @param {{signal?:AbortSignal,timeoutMs?:number}} [context]
   */
  async invoke(call, context = {}) {
    const name = typeof call?.name === 'string' ? call.name : '';
    const tool = this.definitions.get(name);
    if (!tool) return { ok: false, error: { code: 'unknown_tool', message: `Tool not allowed: ${name}` } };
    if (context.signal?.aborted) return { ok: false, error: { code: 'cancelled', message: 'Tool execution cancelled before dispatch' } };
    /** @type {unknown} */
    let input;
    try {
      input = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      validate(input, tool.parameters);
    } catch (error) {
      if (error instanceof ValidationError || error instanceof SyntaxError) {
        return { ok: false, error: { code: 'invalid_arguments', message: error.message } };
      }
      return { ok: false, error: { code: 'invalid_arguments', message: 'Invalid tool arguments' } };
    }
    const timeoutMs = context.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Tool timeout must be positive');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.signal?.addEventListener('abort', onAbort, { once: true });
    if (context.signal?.aborted) controller.abort();
    // Abort is advisory for an in-flight side effect. A timeout returns an
    // *unknown outcome*; the LLM loop must not blindly retry the same action.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; onAbort(); }, timeoutMs);
    this.activeCalls++;
    try {
      const run = Promise.resolve().then(() => {
        if (controller.signal.aborted) return { type: 'cancelled_before_dispatch' };
        return Promise.resolve().then(() => tool.execute(structuredClone(input), { signal: controller.signal }))
          .then(data => ({ type: 'success', data }), error => ({ type: 'error', error }));
      });
      const abort = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve({ type: 'aborted' }), { once: true }));
      const result = /** @type {any} */ (await Promise.race([run, abort]));
      if (result.type === 'cancelled_before_dispatch') return { ok: false, error: { code: 'cancelled', message: 'Tool cancelled before dispatch' } };
      if (result.type === 'aborted' || controller.signal.aborted) {
        this.hasUncertainOutcome = true;
        return { ok: false, error: { code: 'outcome_unknown', message: 'Tool timed out/cancelled after dispatch; reconcile state before retry',
          timeoutOrigin: timedOut ? 'tool_registry_deadline' : 'external_abort', precondition: false, reason: undefined, alternatives: undefined } };
      }
      if (result.type === 'error' && result.error instanceof ToolFailure && result.error.code === 'outcome_unknown') this.hasUncertainOutcome = true;
      if (result.type === 'error') return { ok: false, error: {
        code: result.error instanceof ToolFailure ? result.error.code : 'tool_error',
        message: result.error instanceof Error ? result.error.message : 'Tool failed',
        ...(result.error instanceof ToolFailure && result.error.precondition ? { precondition: true,
          reason: result.error.reason,
          alternatives: result.error.alternatives } : {}),
      } };
      return { ok: true, data: result.data ?? null };
    } finally {
      this.activeCalls--;
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
    }
  }
}
