/**
 * Opt-in OpenAI-compatible chat-completions adapter. This is NOT an assertion
 * that the unpublished instructor API uses this protocol. JSON action mode is
 * required because our native tool-result history has no provider tool_call_id.
 */
/** @typedef {import('../agent.js').LlmMessage} LlmMessage */

export class OpenAiCompatibleProvider {
  /** @param {{baseUrl:string,apiKey:string,model:string,timeoutMs?:number,fetchImpl?:typeof fetch}} options */
  constructor({ baseUrl, apiKey, model, timeoutMs = 120_000, fetchImpl = fetch }) {
    if (!baseUrl || !apiKey || !model) throw new Error('OpenAI-compatible API needs URL, token, and model');
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('LLM base URL must be HTTP(S) without embedded credentials, query, or fragment');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid LLM timeout');
    this.endpoint = `${url.toString().replace(/\/$/, '')}/chat/completions`;
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /** @param {{messages:LlmMessage[],tools?:any[],format?:string|object,signal?:AbortSignal}} request */
  async chat({ messages, tools, format, signal }) {
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('chat requires messages');
    // Restrict this portable adapter to JSON mode; do not invent tool_call_id links.
    if (tools?.length || messages.some(x => x.role === 'tool' || x.tool_calls?.length))
      throw new Error('OpenAI-compatible provider currently supports LLM_MODE=json only');
    const responseFormat = typeof format === 'object' && format
      ? { type: 'json_schema', json_schema: { name: 'asa_action', strict: false, schema: format } }
      : format === 'json' ? { type: 'json_object' } : undefined;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages: messages.map(m => ({ role: m.role, content: m.content ?? '' })),
          ...(responseFormat ? { response_format: responseFormat } : {}), stream: false, temperature: 0 }),
      });
    } catch (error) {
      if (combined.aborted) throw new Error(signal?.aborted ? 'LLM request cancelled' : 'LLM request timed out');
      throw new Error(`LLM provider unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`LLM provider HTTP ${response.status}`);
    /** @type {any} */ let body;
    try { body = await response.json(); } catch { throw new Error('LLM provider returned invalid JSON'); }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('LLM provider response missing text content');
    return { message: { role: 'assistant', content }, usage: {
      promptTokens: Number(body?.usage?.prompt_tokens ?? 0), completionTokens: Number(body?.usage?.completion_tokens ?? 0) },
      durationMs: 0 };
  }
}
