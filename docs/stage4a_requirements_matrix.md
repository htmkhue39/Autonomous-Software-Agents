# Stage 4A — ASA course requirements audit

**Sources:** 7-F-Project-Presentation.pdf (project slides), syllabus-eng27.pdf (2026–27).

**Important:** Source-file presence and local tests are not equivalent to official challenge validation. No course API endpoint, token or tool contract is supplied by the slides.

| ID | Requirement | Status | Code/test evidence | Required final validation |
|---|---|---|---|---|
| P1-01 | Beliefs from sensing and belief revision | local_evidence | ✓ `src/beliefs/index.js`; ✓ `src/beliefs/parcels.js`; ✓ `test/beliefs.test.js` | Verify stale/contradictory observations on Challenge 1 scenarios |
| P1-02 | Goals, intentions and intention revision | local_evidence | ✓ `src/intentions/agent.js`; ✓ `src/intentions/revision.js`; ✓ `test/intentions.test.js` | Verify intention changes in predefined Challenge 1 runs |
| P1-03 | Predefined plan library and action execution | local_evidence | ✓ `src/plans/library.js`; ✓ `test/plans.test.js` | Observe pickup, delivery and recovery plans executing live |
| P1-04 | Call an external automated planner for activated intentions | requires_live_check | ✓ `src/planning/pddl/solve.js`; ✓ `src/plans/moveTo.js`; ✓ `test/pddl.test.js` | Run MOVER=pddl and capture real pddl_call / pddl_success after intention activation. Check at-goal edge cases against examiner wording. |
| P1-05 | Replanning and safe failure handling | local_evidence | ✓ `src/plans/moveTo.js`; ✓ `src/intentions/agent.js`; ✓ `test/stage1-stability.test.js` | Exercise changed paths and failed navigation in Challenge 1 |
| P1-06 | Official predefined Challenge 1 validation | pending_official | ✓ `scripts/summarize-run.js` | Obtain and run instructor-provided Challenge 1 scenarios |
| P2-01 | Second autonomous LLM-based software agent | local_evidence | ✓ `src/llm-agent.js`; ✓ `src/llm/game/runtime.js`; ✓ `test/llm-game.test.js` | Run bubble and milktea simultaneously with distinct game identities |
| P2-02 | Natural-language objectives including changed/replaced goals | requires_live_check | ✓ `src/llm/game/objectives.js`; ✓ `src/course/objective-inbox.js`; ✓ `test/stage4b-integration.test.js` | Demonstrate local stdin objective replacement. Confirm official instructor objective transport before final integration. |
| P2-03 | Dynamic LLM memory: objective, observations and tool catalog | local_evidence | ✓ `src/llm/memory.js`; ✓ `src/llm/game/observations.js`; ✓ `test/llm-memory.test.js` | Inspect current memory after observations, peer message and objective replacement |
| P2-04 | LLM planning, execution and iterative replanning | local_evidence | ✓ `src/llm/agent.js`; ✓ `src/llm/game/tools.js`; ✓ `test/llm-agent.test.js` | Demonstrate tool action, observations and replanning |
| P2-05 | Course-provided extended tool catalog/server | pending_official | ✓ `src/course/mcp-http.js`; ✓ `src/course/catalog.js`; ✓ `test/stage4b-integration.test.js` | Obtain the instructor tool-server specification, token, exact schemas and approved tools. Verify real discovery/invocation. |
| P2-06 | BDI–LLM belief exchange and coordination | local_evidence | ✓ `src/coordination/controller.js`; ✓ `src/coordination/protocol.js`; ✓ `test/coordination.test.js` | Show live shared beliefs, claims, arbitration and evacuation |
| P2-07 | Official predefined Challenge 2 validation | pending_official | ✓ `src/benchmark/runner.js`; ✓ `src/benchmark/ablation.js` | Run instructor-provided Challenge 2 scenarios and save official results |
| SUB-01 | JavaScript source code | local_evidence | ✓ `src/index.js`; ✓ `src/llm-agent.js`; ✓ `package.json` | Create submission snapshot, exclude private .env and logs |
| SUB-02 | Report no longer than 10 pages | not_started | Not yet produced | Write <=10-page final report after course integration results |
| SUB-03 | Oral presentation and submission deadline | pending_official | Not yet produced | Prepare demo/presentation; verify instructor announcement, deadline at least one week ahead of exam |

## Outstanding course-interface information

The uploaded project slides promise a token-authenticated LLM server, an extended tool catalog available on a server, natural-language objectives, and instructor-run Challenge 1/2 scenarios. They do **not** give endpoint URLs, authentication headers, model identifiers, schema details, transport format for objective changes, scenario fixtures, or submission date. The optional OpenAI-compatible and MCP adapters are **conditional integrations**, not a validated official connection.
