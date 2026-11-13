/**
 * HTTP-only Ollama provider. No new npm dependency. Implements a minimal
 * provider.chat({ messages, tools?, format?, signal? }) contract and does not
 * depend on Deliveroo.js or the BDI runtime.
 */

/** @typedef {{ role:string, content?:string, tool_calls?:any[], tool_name?:string }} LlmMessage */
/** @typedef {{ messages:LlmMessage[], tools?:any[], format?:string|object, signal?:AbortSignal }} ChatRequest */
/** @typedef {{ message:LlmMessage, usage:{promptTokens:number,completionTokens:number}, durationMs:number }} ChatResponse */

export class OllamaProvider {
  /** @param {{baseUrl?:string, model?:string, timeoutMs?:number, think?:boolean, temperature?:number, fetchImpl?:typeof fetch}} [options] */
  constructor({ baseUrl = 'http://127.0.0.1:11434', model = 'qwen3.5:4b-q4_K_M',
    timeoutMs = 120_000, think = false, temperature = 0, fetchImpl = fetch } = {}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Ollama URL must use HTTP(S)');
    if (!model || typeof model !== 'string') throw new Error('Ollama model is required');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Ollama timeout must be positive');
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.think = think;
    this.temperature = temperature;
    this.fetchImpl = fetchImpl;
  }

  /** @param {ChatRequest} request  @returns {Promise<ChatResponse>} */
  async chat({ messages, tools, format, signal }) {
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('chat requires messages');
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    /** @type {Response} */
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: combinedSignal,
        body: JSON.stringify({ model: this.model, messages, ...(tools ? { tools } : {}),
          ...(format ? { format } : {}), stream: false, think: this.think,
          options: { temperature: this.temperature } }),
      });
    } catch (error) {
      if (combinedSignal.aborted) throw new Error(signal?.aborted ? 'LLM request cancelled' : 'LLM request timed out');
      throw new Error(`Ollama unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`Ollama API failed (HTTP ${response.status})`);
    /** @type {any} */
    let payload;
    try { payload = await response.json(); } catch { throw new Error('Ollama returned invalid JSON'); }
    if (!payload || !payload.message || typeof payload.message !== 'object' ||
      (typeof payload.message.content !== 'string' && !Array.isArray(payload.message.tool_calls))) {
      throw new Error('Ollama returned an invalid chat message');
    }
    if (payload.message.tool_calls && !Array.isArray(payload.message.tool_calls)) throw new Error('Ollama tool_calls must be an array');
    return {
      message: { role: 'assistant', content: payload.message.content ?? '',
        ...(payload.message.tool_calls ? { tool_calls: payload.message.tool_calls } : {}) },
      usage: { promptTokens: Number(payload.prompt_eval_count ?? 0), completionTokens: Number(payload.eval_count ?? 0) },
      durationMs: Number(payload.total_duration ?? 0) / 1e6,
    };
  }
}
