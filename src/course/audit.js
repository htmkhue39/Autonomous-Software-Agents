/**
 * Source-grounded checklist based on the uploaded 2026–27 ASA project slides
 * (7-F-Project-Presentation.pdf pp.2–9) and syllabus-eng27.pdf.
 * Evidence paths show implementation/test locations, NOT an official pass.
 */
export const COURSE_REQUIREMENTS = Object.freeze([
  { id:'P1-01', title:'Beliefs from sensing and belief revision', status:'local_evidence', evidence:['src/beliefs/index.js','src/beliefs/parcels.js','test/beliefs.test.js'], validation:'Verify stale/contradictory observations on Challenge 1 scenarios' },
  { id:'P1-02', title:'Goals, intentions and intention revision', status:'local_evidence', evidence:['src/intentions/agent.js','src/intentions/revision.js','test/intentions.test.js'], validation:'Verify intention changes in predefined Challenge 1 runs' },
  { id:'P1-03', title:'Predefined plan library and action execution', status:'local_evidence', evidence:['src/plans/library.js','test/plans.test.js'], validation:'Observe pickup, delivery and recovery plans executing live' },
  { id:'P1-04', title:'Call an external automated planner for activated intentions', status:'requires_live_check', evidence:['src/planning/pddl/solve.js','src/plans/moveTo.js','test/pddl.test.js'], validation:'Run MOVER=pddl and capture real pddl_call / pddl_success after intention activation. Check at-goal edge cases against examiner wording.' },
  { id:'P1-05', title:'Replanning and safe failure handling', status:'local_evidence', evidence:['src/plans/moveTo.js','src/intentions/agent.js','test/stage1-stability.test.js'], validation:'Exercise changed paths and failed navigation in Challenge 1' },
  { id:'P1-06', title:'Official predefined Challenge 1 validation', status:'pending_official', evidence:['scripts/summarize-run.js'], validation:'Obtain and run instructor-provided Challenge 1 scenarios' },
  { id:'P2-01', title:'Second autonomous LLM-based software agent', status:'local_evidence', evidence:['src/llm-agent.js','src/llm/game/runtime.js','test/llm-game.test.js'], validation:'Run bubble and milktea simultaneously with distinct game identities' },
  { id:'P2-02', title:'Natural-language objectives including changed/replaced goals', status:'requires_live_check', evidence:['src/llm/game/objectives.js','src/course/objective-inbox.js','test/stage4b-integration.test.js'], validation:'Demonstrate local stdin objective replacement. Confirm official instructor objective transport before final integration.' },
  { id:'P2-03', title:'Dynamic LLM memory: objective, observations and tool catalog', status:'local_evidence', evidence:['src/llm/memory.js','src/llm/game/observations.js','test/llm-memory.test.js'], validation:'Inspect current memory after observations, peer message and objective replacement' },
  { id:'P2-04', title:'LLM planning, execution and iterative replanning', status:'local_evidence', evidence:['src/llm/agent.js','src/llm/game/tools.js','test/llm-agent.test.js'], validation:'Demonstrate tool action, observations and replanning' },
  { id:'P2-05', title:'Course-provided extended tool catalog/server', status:'pending_official', evidence:['src/course/mcp-http.js','src/course/catalog.js','test/stage4b-integration.test.js'], validation:'Obtain the instructor tool-server specification, token, exact schemas and approved tools. Verify real discovery/invocation.' },
  { id:'P2-06', title:'BDI–LLM belief exchange and coordination', status:'local_evidence', evidence:['src/coordination/controller.js','src/coordination/protocol.js','test/coordination.test.js'], validation:'Show live shared beliefs, claims, arbitration and evacuation' },
  { id:'P2-07', title:'Official predefined Challenge 2 validation', status:'pending_official', evidence:['src/benchmark/runner.js','src/benchmark/ablation.js'], validation:'Run instructor-provided Challenge 2 scenarios and save official results' },
  { id:'SUB-01', title:'JavaScript source code', status:'local_evidence', evidence:['src/index.js','src/llm-agent.js','package.json'], validation:'Create submission snapshot, exclude private .env and logs' },
  { id:'SUB-02', title:'Report no longer than 10 pages', status:'not_started', evidence:[], validation:'Write <=10-page final report after course integration results' },
  { id:'SUB-03', title:'Oral presentation and submission deadline', status:'pending_official', evidence:[], validation:'Prepare demo/presentation; verify instructor announcement, deadline at least one week ahead of exam' },
]);

/** @param {{exists:(path:string)=>boolean}} options */
export function auditRequirements({ exists }) {
  const requirements = COURSE_REQUIREMENTS.map(req => ({ ...req, evidence: req.evidence.map(path => ({ path, present: exists(path) })) }));
  return {
    source: ['7-F-Project-Presentation.pdf: course project pp.2–9', 'syllabus-eng27.pdf: project assessment/MCP laboratory'],
    warning: 'Source-file presence and local tests are not equivalent to official challenge validation. No course API endpoint, token or tool contract is supplied by the slides.',
    totals: Object.fromEntries([...new Set(requirements.map(r => r.status))].map(status => [status, requirements.filter(r => r.status === status).length])),
    requirements,
  };
}

/** @param {ReturnType<typeof auditRequirements>} audit */
export function auditMarkdown(audit) {
  return `# Stage 4A — ASA course requirements audit\n\n**Sources:** 7-F-Project-Presentation.pdf (project slides), syllabus-eng27.pdf (2026–27).\n\n**Important:** ${audit.warning}\n\n| ID | Requirement | Status | Code/test evidence | Required final validation |\n|---|---|---|---|---|\n` + audit.requirements.map(r => `| ${r.id} | ${r.title} | ${r.status} | ${r.evidence.map(e => `${e.present ? '✓' : 'MISSING'} \`${e.path}\``).join('; ') || 'Not yet produced'} | ${r.validation} |`).join('\n') + '\n\n## Outstanding course-interface information\n\nThe uploaded project slides promise a token-authenticated LLM server, an extended tool catalog available on a server, natural-language objectives, and instructor-run Challenge 1/2 scenarios. They do **not** give endpoint URLs, authentication headers, model identifiers, schema details, transport format for objective changes, scenario fixtures, or submission date. The optional OpenAI-compatible and MCP adapters are **conditional integrations**, not a validated official connection.\n';
}

/** @param {Record<string,string|undefined>} env */
export function courseIntegrationChecklist(env) {
  const llmType = (env.LLM_PROVIDER || 'ollama').toLowerCase();
  return {
    selectedLlmProvider: llmType,
    openAiCompatibleConfigured: llmType === 'openai_compatible' && !!env.COURSE_LLM_BASE_URL && !!env.COURSE_LLM_TOKEN && !!env.COURSE_LLM_MODEL && env.LLM_MODE === 'json',
    mcpCatalogConfigured: !!env.COURSE_MCP_URL && !!env.COURSE_MCP_TOKEN && !!env.COURSE_TOOL_ALLOWLIST,
    objectiveSource: env.LLM_OBJECTIVE_SOURCE || 'cli',
    officialEndpointVerified: false,
    officialChallengeScenariosVerified: false,
    note: 'Local configuration only. The instructor API and Challenge 1/2 environment remain to be verified; no token values are printed.',
  };
}
