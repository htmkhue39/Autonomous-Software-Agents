import 'dotenv/config';
import { OllamaProvider } from '../src/llm/providers/ollama.js';
import { WorkingMemory } from '../src/llm/memory.js';
import { createDemoTools } from '../src/llm/tools/demo.js';
import { PlanActLoop } from '../src/llm/agent.js';

const mode = process.argv.includes('--json') ? 'json' : 'native';
if ((process.env.LLM_PROVIDER ?? 'ollama').toLowerCase() !== 'ollama') {
  throw new Error('Only LLM_PROVIDER=ollama is implemented in Stage 2A; course provider awaits official API specifications');
}
const provider = new OllamaProvider({
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  model: process.env.OLLAMA_MODEL || 'qwen3.5:4b-q4_K_M',
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 120000),
  think: process.env.OLLAMA_THINK === 'true',
});
const memory = new WorkingMemory();
const tools = createDemoTools();
const events = [];
const loop = new PlanActLoop({ provider, memory, tools, mode, maxSteps: 8,
  verifyCompletion: (_summary, context) => context && memory.events.some(e => e.kind === 'tool_result' && e.details && /** @type {any} */ (e.details).name === 'read_demo_parcels' && /** @type {any} */ (e.details).ok),
  log: (name, data) => { events.push({ name, data }); console.log(`[${name}]`, JSON.stringify(data)); },
});
console.log(`Running local Ollama Stage 2A smoke test (${mode}). No Deliveroo game connection.`);
const result = await loop.run('Use read_demo_parcels to check the toy parcels, then report how many are available. Do not guess.');
console.log('Stage 2A result:', JSON.stringify({ status: result.status, reason: result.reason, summary: result.summary, metrics: result.metrics }, null, 2));
if (result.status !== 'completed' || result.metrics.successfulTools < 1) {
  console.error('Smoke test did not verify actual tool use. Try: npm run llm:smoke:json, or inspect model/API response.');
  process.exitCode = 1;
}
