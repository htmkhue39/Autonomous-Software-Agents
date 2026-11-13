import { ToolRegistry } from './registry.js';

/**
 * Isolated Stage 2A demo tools. No game actions are exposed here, and nothing
 * is allowed to read files, execute shell commands or contact remote servers.
 */
export function createDemoTools() {
  const tools = new ToolRegistry();
  tools.register({
    name: 'read_demo_parcels', description: 'Read the deterministic toy parcel count for the local tool-call smoke test.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    execute: () => ({ count: 2, parcels: ['toy-p1', 'toy-p2'] }),
  });
  tools.register({
    name: 'calculate_demo_total', description: 'Compute the total parcel count from the numeric count obtained from read_demo_parcels.',
    parameters: { type: 'object', additionalProperties: false, required: ['count'], properties: { count: { type: 'integer', minimum: 0, maximum: 100 } } },
    execute: ({ count }) => ({ total: count }),
  });
  return tools;
}
