/**
 * Minimal, opt-in MCP 2025-06-18 Streamable HTTP client for tool discovery
 * and calls. Supports JSON and finite SSE replies. Does not claim compatibility
 * with the unpublished course tool server; full protocol features (server->
 * client requests, legacy transport, refresh notifications) are not implemented.
 */
const VERSION = '2025-06-18';
export class McpHttpClient {
  /** @param {{url:string,token:string,timeoutMs?:number,fetchImpl?:typeof fetch}} options */
  constructor({ url, token, timeoutMs = 15_000, fetchImpl = fetch }) {
    if (!url || !token) throw new Error('MCP URL and access token are required');
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
      throw new Error('MCP URL must be HTTP(S) without embedded credentials');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid MCP timeout');
    this.url = parsed.toString(); this.token = token; this.timeoutMs = timeoutMs; this.fetchImpl = fetchImpl;
    this.sessionId = ''; this.initialized = false; this.nextId = 0;
  }
  /** @param {unknown} payload @param {AbortSignal|undefined} [signal] */
  async post(payload, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetchImpl(this.url, { method: 'POST', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': VERSION, Authorization: `Bearer ${this.token}`,
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}) }, body: JSON.stringify(payload) });
    } catch (error) {
      if (combined.aborted) throw new Error(signal?.aborted ? 'MCP request cancelled; outcome unknown' : 'MCP request timed out; outcome unknown');
      throw new Error(`MCP transport error; outcome unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}; tool result unknown`);
    const id = response.headers?.get?.('mcp-session-id');
    if (id) this.sessionId = id;
    if (/** @type {any} */(payload)?.id === undefined) return null; // notification
    const contentType = response.headers?.get?.('content-type') ?? 'application/json';
    /** @type {any} */ let reply;
    if (contentType.includes('text/event-stream')) {
      // Bounded finite event stream only; unsupported server-initiated requests
      // must not be treated as tool results.
      const body = await response.text();
      if (body.length > 1_000_000) throw new Error('MCP response too large');
      const events = body.split(/\r?\n\r?\n/).flatMap(block => {
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(x => x.slice(5).trim()).join('\n');
        if (!data) return [];
        try { return [JSON.parse(data)]; } catch { return []; }
      });
      reply = events.find(item => item.id === /** @type {any} */(payload).id);
    } else {
      try { reply = await response.json(); } catch { throw new Error('MCP returned invalid JSON'); }
    }
    if (!reply || reply.jsonrpc !== '2.0' || reply.id !== /** @type {any} */(payload).id)
      throw new Error('MCP response ID mismatch or unsupported message');
    if (reply.error) throw new Error(`MCP JSON-RPC error ${reply.error.code}: ${String(reply.error.message).slice(0,160)}`);
    return reply.result;
  }
  /** @param {string} method @param {object} params @param {AbortSignal|undefined} [signal] */
  request(method, params, signal) { return this.post({ jsonrpc: '2.0', id: ++this.nextId, method, params }, signal); }
  /** @param {AbortSignal|undefined} [signal] */
  async initialize(signal) {
    if (this.initialized) return;
    const result = await this.request('initialize', { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'asa-milktea', version: '1.0.0' } }, signal);
    if (!result || result.protocolVersion !== VERSION) throw new Error('MCP protocol version unsupported by server');
    await this.post({ jsonrpc:'2.0', method:'notifications/initialized' }, signal);
    this.initialized = true;
  }
  /** @param {AbortSignal|undefined} [signal] */
  async listTools(signal) {
    await this.initialize(signal);
    /** @type {any[]} */ const tools = [];
    /** @type {string|undefined} */ let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, signal);
      if (!Array.isArray(result?.tools)) throw new Error('MCP catalog has no tools array');
      tools.push(...result.tools);
      if (tools.length > 100) throw new Error('MCP catalog limit exceeded');
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) return tools;
    }
    throw new Error('MCP catalog pagination limit exceeded');
  }
  /** @param {string} name @param {object} args @param {AbortSignal|undefined} [signal] */
  async callTool(name, args, signal) {
    if (!this.initialized) throw new Error('MCP tools must be discovered before invocation');
    return this.request('tools/call', { name, arguments: args }, signal);
  }
}
