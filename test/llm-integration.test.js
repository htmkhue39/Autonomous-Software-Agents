// @ts-nocheck -- local HTTP fake-Ollama integration fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OllamaProvider } from '../src/llm/providers/ollama.js';
import { PlanActLoop } from '../src/llm/agent.js';
import { WorkingMemory } from '../src/llm/memory.js';
import { createDemoTools } from '../src/llm/tools/demo.js';

test('complete Stage 2A loop works over HTTP against a fake Ollama service', async () => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    assert.equal(req.url, '/api/chat');
    assert.equal(request.stream, false);
    const responses = [
      { content: JSON.stringify({ summary: 'Inspect toy parcels', steps: [{ tool: 'read_demo_parcels', reason: 'Read, do not guess' }] }) },
      { content: '', tool_calls: [{ type: 'function', function: { name: 'read_demo_parcels', arguments: {} } }] },
      { content: '', tool_calls: [{ type: 'function', function: { name: 'finish_objective', arguments: { status: 'completed', summary: 'Two toy parcels' } } }] },
    ];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: { role: 'assistant', ...responses[requests++] }, total_duration: 1000000 }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const memory = new WorkingMemory();
    const loop = new PlanActLoop({
      provider: new OllamaProvider({ baseUrl: `http://127.0.0.1:${port}` }),
      memory, tools: createDemoTools(), verifyCompletion: () => true,
    });
    const result = await loop.run('Read toy parcels and report count');
    assert.equal(result.status, 'completed');
    assert.equal(result.metrics.llmCalls, 3);
    assert.equal(result.metrics.successfulTools, 1);
    assert.equal(requests, 3);
  } finally {
    server.close(); await once(server, 'close');
  }
});
