// @ts-nocheck -- deterministic test fixtures; production source remains strictly checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OllamaProvider } from '../src/llm/providers/ollama.js';

function makeProvider(fetchImpl) { return new OllamaProvider({ model: 'qwen3.5:4b-q4_K_M', fetchImpl }); }

test('Ollama provider sends HTTP chat request, schema and tools without streaming', async () => {
  const inputs = [];
  const provider = makeProvider(async (url, request) => {
    inputs.push({ url, request, body: JSON.parse(request.body) });
    return { ok: true, json: async () => ({ message: { role: 'assistant', content: '{"ok":true}' }, prompt_eval_count: 11, eval_count: 4, total_duration: 1200000000 }) };
  });
  const result = await provider.chat({ messages: [{ role: 'user', content: 'test' }], tools: [{ type: 'function' }], format: 'json' });
  assert.equal(inputs[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(inputs[0].body.stream, false);
  assert.equal(inputs[0].body.think, false);
  assert.equal(inputs[0].body.model, 'qwen3.5:4b-q4_K_M');
  assert.equal(inputs[0].body.format, 'json');
  assert.equal(result.usage.promptTokens, 11);
  assert.equal(result.durationMs, 1200);
});
test('Ollama provider returns native tool calls and protects against malformed responses', async () => {
  const call = { type: 'function', function: { name: 'read_demo_parcels', arguments: {} } };
  const result = await makeProvider(async () => ({ ok: true, json: async () => ({ message: { role: 'assistant', content: '', tool_calls: [call] } }) })).chat({ messages: [{ role: 'user', content: 'inspect' }] });
  assert.deepEqual(result.message.tool_calls, [call]);
  await assert.rejects(makeProvider(async () => ({ ok: false, status: 401 })).chat({ messages: [{ role: 'user', content: 'x' }] }), /HTTP 401/);
  await assert.rejects(makeProvider(async () => ({ ok: true, json: async () => ({ message: {} }) })).chat({ messages: [{ role: 'user', content: 'x' }] }), /invalid chat message/);
});
test('Ollama provider posts to real local HTTP server using fetch', async () => {
  const server = createServer(async (req, res) => {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/api/chat');
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).stream, false);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { role: 'assistant', content: 'hello' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const { port } = server.address();
    const result = await new OllamaProvider({ baseUrl: `http://127.0.0.1:${port}` }).chat({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(result.message.content, 'hello');
  } finally { server.close(); await once(server, 'close'); }
});
