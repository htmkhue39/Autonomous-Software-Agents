/** Offline-only contract smoke test for optional course integration adapters. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAiCompatibleProvider } from '../src/llm/providers/openai-compatible.js';
import { McpHttpClient } from '../src/course/mcp-http.js';
import { attachMcpCatalog } from '../src/course/catalog.js';
import { ToolRegistry } from '../src/llm/tools/registry.js';

const server = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer fake-smoke-token') { res.writeHead(401).end(); return; }
  /** @type {string} */ let raw = '';
  for await (const chunk of req) raw += chunk;
  const payload = JSON.parse(raw);
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/chat/completions') {
    res.end(JSON.stringify({ choices:[{message:{role:'assistant',content:'{"summary":"Mock plan","steps":[{"tool":"course_lookup","reason":"inspect"}]}'}}],usage:{prompt_tokens:8,completion_tokens:10} }));
    return;
  }
  if (req.url === '/mcp') {
    if (payload.method === 'notifications/initialized') { res.writeHead(202);res.end();return; }
    const answer = payload.method === 'initialize' ? {protocolVersion:'2025-06-18',capabilities:{tools:{}}}
      : payload.method === 'tools/list' ? {tools:[{name:'lookup',description:'Read-only mock tool',inputSchema:{type:'object',additionalProperties:false,required:['key'],properties:{key:{type:'string'}}}}]}
        : payload.method === 'tools/call' ? {content:[{type:'text',text:`mock:${payload.params.arguments.key}`}]} : null;
    if (!answer) {res.writeHead(400).end();return;}
    res.end(JSON.stringify({jsonrpc:'2.0',id:payload.id,result:answer})); return;
  }
  res.writeHead(404).end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Unexpected HTTP server address');
  const base = `http://127.0.0.1:${addr.port}`;
  const provider = new OpenAiCompatibleProvider({baseUrl:base+'/v1',apiKey:'fake-smoke-token',model:'mock-model'});
  const reply = await provider.chat({messages:[{role:'user',content:'Make a plan'}],format:'json'});
  if (!JSON.parse(reply.message.content).steps?.length) throw new Error('Mock model plan failed');
  const catalog = new McpHttpClient({url:base+'/mcp',token:'fake-smoke-token'});
  const registry = new ToolRegistry();
  const info = await attachMcpCatalog({registry,client:catalog,allowlist:['lookup']});
  const invoked = await registry.invoke({name:'course_lookup',arguments:{key:'ok'}});
  if (!invoked.ok || invoked.data?.[0]?.text !== 'mock:ok') throw new Error('Mock MCP tool invocation failed');
  console.log('Stage 4B LOCAL MOCK: OpenAI-compatible LLM + MCP discovery/invocation PASSED');
  console.log(`Catalog tools registered: ${info.enabled.join(', ')}`);
  console.log('No instructor endpoint/tool catalog tested. No real game action performed.');
} finally {
  server.close(); await once(server, 'close');
}
