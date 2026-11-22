import { validate } from './validation.js';

/** @typedef {import('./memory.js').WorkingMemory} WorkingMemory */
/** @typedef {import('./tools/registry.js').ToolRegistry} ToolRegistry */
/** @typedef {{role:string,content?:string,tool_calls?:any[],tool_name?:string}} LlmMessage */
/** @typedef {{message:LlmMessage,usage?:{promptTokens:number,completionTokens:number},durationMs?:number}} ChatResponse */
/** @typedef {{chat:(request:{messages:LlmMessage[],tools?:any[],format?:string|object,signal?:AbortSignal})=>Promise<ChatResponse>}} LlmProvider */

/** @type {import('./validation.js').SimpleSchema} */
const STEP_SCHEMA = ({ type: 'object', additionalProperties: false, required: ['tool', 'reason'],
  properties: { tool: { type: 'string', minLength: 1, maxLength: 64 }, reason: { type: 'string', maxLength: 400 } },
});
/** @type {import('./validation.js').SimpleSchema} */
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'steps'],
  properties: { summary: { type: 'string', minLength: 1, maxLength: 400 },
    steps: { type: 'array', minItems: 1, maxItems: 6, items: STEP_SCHEMA } },
};
// JSON-mode decision uses a dedicated loose arguments schema in the API: a
// schema cannot know tool-specific properties ahead of time. Runtime validation
// always uses the selected tool's strict registered parameter schema.
const JSON_ACTION_FORMAT = {
  type: 'object', additionalProperties: false, required: ['action', 'tool', 'arguments', 'status', 'summary'],
  properties: {
    action: { type: 'string', enum: ['tool', 'finish'] },
    tool: { type: 'string' },
    arguments: { type: 'object' },
    status: { type: 'string', enum: ['completed', 'blocked'] },
    summary: { type: 'string' },
  },
};

const FINISH_TOOL = {
  type: 'function', function: {
    name: 'finish_objective', description: 'Report that an objective is achieved or blocked. Do not claim completion until real tools have provided evidence.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['status', 'summary'],
      properties: { status: { type: 'string', enum: ['completed', 'blocked'] }, summary: { type: 'string', minLength: 1, maxLength: 600 } },
    },
  },
};

const PLAN_SYSTEM = `You are the planning component of an autonomous software agent. Produce a short, structured plan for the objective using ONLY the registered tool names. The plan is advisory, not permission to execute. Do not invent tools or game observations. Every step needs tool and reason. No private reasoning transcript.`;
const ACT_SYSTEM = `You are a bounded autonomous software agent. Use only the supplied function tools. The plan is advisory; revise it after tool results and observations. If cooperation details are present, account for teammate intentions and parcel claims; choose unclaimed alternatives. Do not invent successful actions or stale information. Never call a tool for which you have no evidence or valid arguments. The objectiveProgress field, when present, records VERIFIED cumulative progress for the current goal, NOT the number of parcels currently visible. For ordinary delivery objectives PREFER collect_best_and_deliver({strategy:"highest_expected_reward"}) immediately: it dynamically selects a fresh unclaimed parcel WHEN THE TOOL RUNS, and picks up/delivers without more LLM inference. Do NOT choose parcel IDs from old conversation messages or stale snapshots as if still available. Use exact-ID collect_and_deliver(parcel_id) ONLY when a specific parcel is required. If dynamic collection reports no_viable_target, explore/wait for new observations. Parcel disappearance is normal, not proof the objective is impossible. Always respond using tool calls, NOT free-form prose. The game runtime automatically terminates supported objectives when verified game evidence meets the target. Otherwise, use finish_objective(status,summary) to explicitly report completion or blockage. Status 'completed' requires evidence from an executed tool. Never assume that natural-language claims prove completion.`;
const ACT_JSON_SYSTEM = `You are a bounded autonomous software agent. Treat objectiveProgress, when present, as verified CUMULATIVE progress toward the current goal, not currently visible parcels. For ordinary delivery objectives PREFER collect_best_and_deliver({strategy:"highest_expected_reward"}): select fresh viable parcels AT EXECUTION TIME instead of selecting an ID from a stale snapshot. Do not reuse parcel IDs from old messages. Use exact-ID collect_and_deliver only for explicit specific parcel goals. If no_viable_target, explore/wait for new observations. Parcel disappearance requires selecting another parcel, not stopping. If cooperation details are present, avoid teammate-claimed parcels and inspect get_cooperation_state when uncertain. Return one JSON action at a time using the schema. Set action='tool' with a registered tool name and strict JSON arguments; status='blocked', summary=''. The game runtime automatically stops when supported objectives are verified complete; otherwise, to end, set action='finish', tool='', arguments={}, status='completed' or 'blocked' and a grounded summary. Update your decision from tool results and current memory. Never claim completion without evidence from an executed tool.`;

/** @param {unknown} value */
function parseJson(value) {
  if (typeof value !== 'string') throw new Error('Model response must contain JSON text');
  try { return JSON.parse(value); } catch { throw new Error('Model returned invalid structured JSON'); }
}

/** Keep tool results from overflowing the model's context. */
function compactJson(/** @type {unknown} */ value, /** @type {number} */ maxLength = 3500) {
  const json = JSON.stringify(value);
  if (json === undefined) return JSON.stringify({ note: 'unserializable_result' });
  return json.length <= maxLength ? json : JSON.stringify({ truncated: true, preview: json.slice(0, maxLength - 150) });
}

/** Bounded planning and tool loop; stage 2A uses only fake/local tools. */
export class PlanActLoop {
  /** @param {{provider:LlmProvider,memory:WorkingMemory,tools:ToolRegistry,mode?:'native'|'json',maxSteps?:number,maxToolCalls?:number,planAttempts?:number,toolTimeoutMs?:number,log?:(event:string,details:object)=>void,observe?:()=>Promise<unknown>|unknown,verifyCompletion?:(summary:string,context:unknown)=>Promise<boolean>|boolean,autoVerifyCompletion?:boolean}} options */
  constructor({ provider, memory, tools, mode = 'native', maxSteps = 8, maxToolCalls = 12, planAttempts = 2, toolTimeoutMs = 10_000,
    log = () => {}, observe, verifyCompletion, autoVerifyCompletion = false }) {
    if (!['native', 'json'].includes(mode)) throw new Error('Unknown LLM action mode');
    if (![maxSteps, maxToolCalls, planAttempts].every(v => Number.isInteger(v) && v >= 1) || !Number.isFinite(toolTimeoutMs) || toolTimeoutMs <= 0) throw new Error('Invalid LLM loop limits');
    if (autoVerifyCompletion && typeof verifyCompletion !== 'function') throw new Error('Automatic completion requires an evidence verifier');
    this.provider = provider; this.memory = memory; this.tools = tools;
    this.mode = mode; this.maxSteps = maxSteps; this.maxToolCalls = maxToolCalls;
    this.planAttempts = planAttempts; this.toolTimeoutMs = toolTimeoutMs; this.log = log; this.observe = observe; this.verifyCompletion = verifyCompletion;
    this.autoVerifyCompletion = autoVerifyCompletion;
    /** @type {AbortController|null} */ this.currentController = null;
  }

  /** Time model requests without recording prompts, replies or credentials. */
  /** @param {Parameters<LlmProvider['chat']>[0]} request @param {'plan'|'act'} phase */
  async monitoredChat(request, phase) {
    const started = performance.now();
    try {
      const response = await this.provider.chat(request);
      this.log('llm_model_result', { phase, ok: true,
        durationMs: Math.round(performance.now() - started),
        providerDurationMs: Number.isFinite(response.durationMs) ? response.durationMs : null,
        promptTokens: response.usage?.promptTokens ?? null,
        completionTokens: response.usage?.completionTokens ?? null });
      return response;
    } catch (error) {
      this.log('llm_model_result', { phase, ok: false,
        durationMs: Math.round(performance.now() - started),
        failureKind: /timed out/i.test(error instanceof Error ? error.message : String(error)) ? 'provider_timeout'
          : request.signal?.aborted ? 'external_abort' : 'provider_error' });
      throw error;
    }
  }

  /** Cancel ongoing model request/tool invocation and supersede the objective. */
  /** @param {string} objective */
  replaceObjective(objective) {
    this.currentController?.abort();
    this.memory.setObjective(objective);
  }

  stop() { this.currentController?.abort(); }

  /** @param {string} objective @param {{observation?:unknown,signal?:AbortSignal}} [options] */
  async run(objective, { observation, signal } = {}) {
    if (this.currentController) throw new Error('LLM loop already running');
    this.memory.setObjective(objective);
    if (observation !== undefined) this.memory.updateObservation(observation);
    const version = this.memory.objectiveVersion;
    const controller = new AbortController();
    this.currentController = controller;
    const runSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const metrics = { llmCalls: 0, toolCalls: 0, successfulTools: 0, invalidTools: 0,
      invalidToolCalls: 0, preconditionRejections: 0, failedGameActions: 0, uncertainOutcomes: 0, replans: 0 };
    const finish = (/** @type {string} */ status, /** @type {string} */ reason, /** @type {string} */ summary = '') =>
      ({ status, reason, summary, metrics: { ...metrics }, memory: this.memory.snapshot() });
    /**
     * Stage 2C.2.2: do not require a model-generated finish_objective after
     * the game has already proved success. Default is OFF for general tools.
     * @param {string} source
     */
    const verifiedResult = async (source) => {
      if (!this.autoVerifyCompletion) return null;
      const verified = await this.verifyCompletion?.('', this.memory.snapshot());
      if (runSignal.aborted || this.memory.objectiveVersion !== version) return finish('cancelled', 'objective_replaced_or_cancelled');
      if (verified !== true) return null;
      this.log('llm_objective_auto_verified', { source });
      return finish('completed', 'verified', 'Objective satisfied by verified game progress');
    };
    try {
      const alreadyComplete = await verifiedResult('initial_state');
      if (alreadyComplete) return alreadyComplete;
      // Plan with structured JSON and a strict allowlist. Retry malformed plans
      // once with feedback; never execute unvalidated plans.
      const names = this.tools.getSpecs().map(t => t.function.name);
      if (!names.length) return finish('blocked', 'no_tools_registered');
      /** @type {{summary:string,steps:{tool:string,reason:string}[]}|null} */
      let plan = null;
      for (let attempt = 0; attempt < this.planAttempts; attempt++) {
        if (runSignal.aborted || this.memory.objectiveVersion !== version) return finish('cancelled', 'objective_replaced_or_cancelled');
        const user = JSON.stringify({ memory: this.memory.snapshot(), availableTools: names, instruction: attempt ? 'Previous plan was invalid; use ONLY allowed tool names and schema.' : 'Plan this objective.' });
        metrics.llmCalls++;
        this.log('llm_model_call', { phase: 'plan' });
        const response = await this.monitoredChat({ messages: [{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: user }], format: PLAN_SCHEMA, signal: runSignal }, 'plan');
        if (runSignal.aborted || this.memory.objectiveVersion !== version) return finish('cancelled', 'objective_replaced_or_cancelled');
        try {
          const parsed = parseJson(response.message.content);
          validate(parsed, /** @type {import('./validation.js').SimpleSchema} */ (PLAN_SCHEMA));
          if (!parsed.steps.every((/** @type {{tool:string}} */ step) => names.includes(step.tool))) throw new Error('Plan named a tool outside the allowlist');
          plan = parsed;
          break;
        } catch (error) {
          this.log('llm_plan_invalid', { attempt: attempt + 1, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (!plan) return finish('blocked', 'invalid_plan');
      this.memory.setPlan(plan);
      this.log('llm_plan', { summary: plan.summary, steps: plan.steps.map(s => s.tool) });

      /** @type {LlmMessage[]} */
      const history = [
        { role: 'system', content: this.mode === 'native' ? ACT_SYSTEM : ACT_JSON_SYSTEM },
        { role: 'user', content: JSON.stringify({ objective, plan, memory: this.memory.snapshot(), allowedTools: this.tools.getSpecs() }) },
      ];
      let emptyNativeReplies = 0;
      for (let i = 0; i < this.maxSteps; i++) {
        if (runSignal.aborted || this.memory.objectiveVersion !== version) return finish('cancelled', 'objective_replaced_or_cancelled');
        const completedBeforeDecision = await verifiedResult('before_decision');
        if (completedBeforeDecision) return completedBeforeDecision;
        metrics.llmCalls++;
        this.log('llm_model_call', { phase: 'act' });
        const reply = await this.monitoredChat({ messages: history, signal: runSignal,
          ...(this.mode === 'native' ? { tools: [...this.tools.getSpecs(), FINISH_TOOL] } : { format: JSON_ACTION_FORMAT }) }, 'act');
        if (runSignal.aborted || this.memory.objectiveVersion !== version) return finish('cancelled', 'objective_replaced_or_cancelled');
        const completedDuringDecision = await verifiedResult('after_model_response');
        if (completedDuringDecision) return completedDuringDecision;

        /** @type {{name:string,arguments:unknown}[]} */
        let calls = [];
        if (this.mode === 'native') {
          if (!Array.isArray(reply.message.tool_calls) || reply.message.tool_calls.length === 0) {
            emptyNativeReplies++;
            this.log('llm_no_tool_calls', { attempt: emptyNativeReplies, excerpt: (reply.message.content ?? '').slice(0, 240) });
            // Never count prose as an objective-completion signal. Allow a
            // bounded corrective turn, particularly after a dynamic failure.
            if (emptyNativeReplies >= 2 || i + 1 >= this.maxSteps) return finish('stalled', 'no_tool_calls', reply.message.content ?? '');
            if (this.observe) this.memory.updateObservation(await this.observe());
            history.push({ role: 'assistant', content: reply.message.content ?? '' },
              { role: 'user', content: compactJson({ updatedMemory: this.memory.snapshot(),
                instruction: 'The objective has NOT been verified. Prose is not an action. For ordinary delivery goals call collect_best_and_deliver({strategy:"highest_expected_reward"}) to choose a fresh parcel at tool execution time; alternatively inspect or explore. Do not repeat old parcel IDs. Finish as blocked only if truly impossible.' }) });
            continue;
          }
          emptyNativeReplies = 0;
          calls = reply.message.tool_calls.map((/** @type {any} */ c) => ({ name: c?.function?.name ?? '', arguments: c?.function?.arguments }));
          history.push({ role: 'assistant', content: reply.message.content ?? '', tool_calls: reply.message.tool_calls });
        } else {
          let decision;
          try {
            decision = parseJson(reply.message.content);
            if (!decision || !['tool', 'finish'].includes(decision.action) || typeof decision.tool !== 'string' ||
              !decision.arguments || typeof decision.arguments !== 'object' || Array.isArray(decision.arguments) ||
              !['completed', 'blocked'].includes(decision.status) || typeof decision.summary !== 'string') throw new Error('Invalid JSON action');
          } catch (error) {
            metrics.invalidTools++; metrics.invalidToolCalls++;
            history.push({ role: 'assistant', content: reply.message.content ?? '' }, { role: 'user', content: 'Invalid JSON action. Follow the required action schema and tool argument schemas.' });
            this.log('llm_action_invalid', { reason: error instanceof Error ? error.message : String(error) });
            continue;
          }
          history.push({ role: 'assistant', content: reply.message.content ?? '' });
          calls = decision.action === 'finish' ? [{ name: 'finish_objective', arguments: { status: decision.status, summary: decision.summary } }] : [{ name: decision.tool, arguments: decision.arguments }];
        }
        for (const call of calls) {
          if (runSignal.aborted || this.memory.objectiveVersion !== version) return finish('cancelled', 'objective_replaced_or_cancelled');
          if (call.name === 'finish_objective') {
            /** @type {{status:'completed'|'blocked',summary:string}} */
            let args;
            try {
              const raw = typeof call.arguments === 'string' ? parseJson(call.arguments) : call.arguments;
              validate(raw, /** @type {import('./validation.js').SimpleSchema} */ (FINISH_TOOL.function.parameters));
              args = raw;
            }
            catch { metrics.invalidTools++; metrics.invalidToolCalls++; history.push({ role: 'tool', tool_name: 'finish_objective', content: JSON.stringify({ ok:false, error: 'Invalid finish arguments' }) }); continue; }
            if (args.status === 'blocked') return finish('blocked', 'model_reported_blocked', args.summary);
            if (metrics.successfulTools === 0) {
              metrics.invalidTools++; metrics.invalidToolCalls++;
              history.push({ role: this.mode === 'native' ? 'tool' : 'user', tool_name: 'finish_objective', content: 'Completion rejected: execute and verify a real tool first.' });
              continue;
            }
            const verified = this.verifyCompletion ? await this.verifyCompletion(args.summary, this.memory.snapshot()) : null;
            if (runSignal.aborted || this.memory.objectiveVersion !== version) return finish('cancelled', 'objective_replaced_or_cancelled');
            if (verified === false) {
              history.push({ role: this.mode === 'native' ? 'tool' : 'user', tool_name: 'finish_objective', content: 'Objective verification failed; inspect the latest observations and replan.' });
              metrics.replans++;
              continue;
            }
            return finish(verified === true ? 'completed' : 'reported_completed', verified === true ? 'verified' : 'requires_external_verification', args.summary);
          }
          if (metrics.toolCalls >= this.maxToolCalls) return finish('limit_reached', 'max_tool_calls');
          metrics.toolCalls++;
          const toolStarted = performance.now();
          const result = await this.tools.invoke(call, { signal: runSignal, timeoutMs: this.toolTimeoutMs });
          const toolDurationMs = Math.round(performance.now() - toolStarted);
          if (runSignal.aborted || this.memory.objectiveVersion !== version) return finish('cancelled', 'objective_replaced_or_cancelled');
          if (result.ok) metrics.successfulTools++;
          else {
            metrics.invalidTools++; // legacy aggregate for comparison with Stage 2C
            if (['unknown_tool', 'invalid_arguments'].includes(result.error?.code)) metrics.invalidToolCalls++;
            else if (result.error?.precondition === true) metrics.preconditionRejections++;
            else if (result.error?.code === 'outcome_unknown') metrics.uncertainOutcomes++;
            else metrics.failedGameActions++;
          }
          this.memory.record('tool_result', { name: call.name, ...result });
          this.log('llm_tool_result', { name: call.name, ok: result.ok, durationMs: toolDurationMs,
            ...(result.error?.timeoutOrigin ? { timeoutOrigin: result.error.timeoutOrigin } : {}), ...(result.ok ? {} : { errorCode: result.error?.code, errorMessage: result.error?.message?.slice(0, 300),
            ...(result.error?.precondition ? { precondition: true, rejectionReason: result.error.reason } : {}) }) });
          history.push({ role: this.mode === 'native' ? 'tool' : 'user',
            ...(this.mode === 'native' ? { tool_name: call.name } : {}),
            content: compactJson({ tool: call.name, ...result }) });
          if (this.observe && result.error?.code !== 'outcome_unknown') {
            this.memory.updateObservation(await this.observe());
            if (runSignal.aborted || this.memory.objectiveVersion !== version) return finish('cancelled', 'objective_replaced_or_cancelled');
          }
          // Stop as soon as authoritative score/delivery evidence meets the
          // objective, including when Qwen would otherwise reply with prose.
          const completedAfterTool = await verifiedResult(`tool:${call.name}`);
          if (completedAfterTool) return completedAfterTool;
          // Important for JSON fallback and for large changing worlds: give
          // current memory to the model, not just the original observation.
          if (!result.ok && result.error?.code === 'outcome_unknown') return finish('blocked', 'uncertain_tool_outcome');
          if (!result.ok) metrics.replans++;
        }
        history.push({ role: 'user', content: compactJson({ updatedMemory: this.memory.snapshot(), instruction: 'Review the tool outcomes and latest observations. Do not reuse stale parcel IDs from previous messages. For ordinary deliveries prefer collect_best_and_deliver({strategy:"highest_expected_reward"}). If no viable target, explore. Only finish completed when verified. Do not invent results.' }) });
      }
      return finish('limit_reached', 'max_steps');
    } catch (error) {
      if (runSignal.aborted || this.memory.objectiveVersion !== version) return finish('cancelled', 'objective_replaced_or_cancelled');
      this.log('llm_error', { message: error instanceof Error ? error.message : String(error) });
      return finish('error', error instanceof Error ? error.message : String(error));
    } finally {
      this.currentController = null;
    }
  }
}
