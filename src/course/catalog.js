import { ToolFailure } from '../llm/tools/registry.js';

/**
 * Attach only explicitly authorized MCP tools. No implicit trust of a server-
 * supplied name/schema, and no unreviewed remote side effects. A failed/aborted
 * call is classified outcome_unknown because the remote server might have
 * executed it. The LLM loop must not automatically retry it.
 *
 * @param {{registry:import('../llm/tools/registry.js').ToolRegistry,
 *  client:{listTools:(signal?:AbortSignal)=>Promise<any[]>,callTool:(name:string,args:object,signal?:AbortSignal)=>Promise<any>},
 *  allowlist:string[],log?:(event:string,details:object)=>void,signal?:AbortSignal}} options
 */
export async function attachMcpCatalog({ registry, client, allowlist, log = () => {}, signal }) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) throw new Error('Course MCP allowlist must specify explicit tool names');
  if (allowlist.some(name => !/^[A-Za-z0-9_-]{1,64}$/.test(name))) throw new Error('Invalid MCP allowlist name');
  const allowed = new Set(allowlist);
  const tools = await client.listTools(signal);
  const enabled = [];
  const rejected = [];
  for (const source of tools) {
    if (!allowed.has(source?.name)) continue;
    const name = `course_${source.name.replace(/-/g, '_').toLowerCase()}`;
    try {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error('Invalid prefixed name');
      // ToolRegistry performs strict supported JSON-schema validation.
      registry.register({ name, description: String(source.description || `Course tool ${source.name}`).slice(0, 700),
        parameters: source.inputSchema,
        execute: async (args, { signal: callSignal }) => {
          try {
            const result = await client.callTool(source.name, args, callSignal);
            if (result?.isError) throw new ToolFailure('outcome_unknown', 'Remote tool reported an error; reconcile state before retry');
            return result?.structuredContent ?? result?.content ?? result;
          } catch (error) {
            if (error instanceof ToolFailure) throw error;
            throw new ToolFailure('outcome_unknown', 'Remote tool outcome unknown; do not retry without verification');
          }
        },
      });
      enabled.push(name);
    } catch { rejected.push(String(source?.name ?? 'unnamed')); }
  }
  const missing = allowlist.filter(name => !tools.some(tool => tool.name === name));
  log('course_mcp_catalog', { discovered: tools.length, enabled, rejected, missing });
  if (missing.length || rejected.length) throw new Error('Course tool catalog did not match the approved allowlist/schema');
  return { discovered: tools.length, enabled };
}
