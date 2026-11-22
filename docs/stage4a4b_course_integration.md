# Stage 4A + 4B — Course compliance and integration boundary

**Baseline:** Stage 3C.3; BDI, A*, external PDDL, independent Ollama LLM agent,
cooperation and traffic-evacuation algorithms are unchanged.

## Source-derived requirements

The uploaded `7-F-Project-Presentation.pdf` (2026–27 project slides) requires
(1) a BDI agent with belief/intention revision, predefined plans and an
**external planner invoked when an intention is activated**; (2) a **second
LLM-based agent** using dynamic memory, natural-language objectives, tool
catalog, planning, execution and replanning, and cooperation; and (3) official
Challenge 1/2 simulation validation. Slide 8 describes an LLM service
accessible by API/token and an extended tool catalog accessible from a server.
The `syllabus-eng27.pdf` also discusses MCP in the lab. Submission requires
JavaScript source, a <=10-page report and oral presentation; the exact deadline
is not supplied in the slides.

**Neither uploaded document includes the official API URLs, access tokens,
concrete model IDs, tool schemas, objective transport contract, challenge
scenario files, or exact submission date.** Do not invent these details.

## Stage 4A: inspect the requirement matrix

```bash
npm ci
npm test
npm run typecheck
npm run course:audit
```

Read `course-audit/requirements.md` and `integration-checklist.json`. Source
paths and automated tests are evidence of implementation, **not** automatic
approval under Challenge 1/2. In particular, PDDL-backed navigation is
available and was tested locally, but the instructor must confirm what the
phrase "planner when an intention is activated" means for intentions whose
current position already satisfies the navigation goal.

## Stage 4B: local contract smoke test (no real game needed)

```bash
npm run course:smoke
```

This spins up a **fake local HTTP server**, exercises an opt-in
OpenAI-compatible chat-completions adapter with a fake bearer token, then
runs an MCP 2025-06-18 Streamable HTTP initialize/tools/list/tools/call flow
with an explicitly allowlisted toy tool. It **does not contact** the instructor,
use a real token, or execute Deliveroo game actions.

### Optional external LLM adapter (only if the real service is compatible)

Set the following in your **private `.env`**, using only values officially
provided to your team:

```dotenv
LLM_PROVIDER=openai_compatible
LLM_MODE=json
COURSE_LLM_BASE_URL=https://REPLACE-WITH-OFFICIAL-HOST/v1
COURSE_LLM_MODEL=REPLACE-WITH-AUTHORIZED-MODEL
COURSE_LLM_TOKEN=REPLACE-WITH-PRIVATE-TOKEN
```

This adapter expects OpenAI-style `POST /chat/completions` under the configured
base URL, bearer authentication, `choices[0].message.content`, and JSON-mode
responses. **The course slides do not promise this exact wire protocol.** If
the official API differs, adapt `src/llm/providers/openai-compatible.js`
based on official documentation before selecting it. The existing local
`LLM_PROVIDER=ollama` behavior is unchanged.

### Optional tool-catalog bridge (only if MCP Streamable HTTP is offered)

```dotenv
COURSE_MCP_URL=https://REPLACE-WITH-OFFICIAL-HOST/mcp
COURSE_MCP_TOKEN=REPLACE-WITH-PRIVATE-TOKEN
COURSE_TOOL_ALLOWLIST=tool_one,tool_two
COURSE_MCP_TIMEOUT_MS=15000
```

The MCP bridge performs initialization and discovery on startup. Only tools
named in `COURSE_TOOL_ALLOWLIST` are exposed to the LLM, with a `course_`
prefix. A discovered tool must match the strict JSON-schema subset supported
by our existing `ToolRegistry`; otherwise startup fails closed. Remote tool
transport failures are reported as **uncertain outcomes** and are never
blindly retried. Only call approved tools after reviewing their side effects.

The current minimal HTTP bridge supports finite JSON/SSE replies and
2025-06-18 initialization. It does not implement unsolicited server requests,
legacy HTTP+SSE, streaming subscriptions, or every MCP extension. It should be
verified against the exact official server. If the instructor distributes a
full MCP SDK client or a different protocol, use that specification rather than
claiming this adapter is already official.

### Local objective replacement demo (not official challenge transport)

With the Deliveroo.js server and `bubble` already running, open a new terminal
for `milktea` in the project directory:

```bash
AGENT=milktea HOST=http://localhost:8080 \
  COORDINATION_ENABLED=true LLM_MODE=json \
  LLM_OBJECTIVE_SOURCE=stdin npm run start:llm
```

Type one JSON object per line, pressing Enter after each:

```json
{"type":"objective","id":"goal1","objective":"Deliver 2 parcels"}
{"type":"objective","id":"goal2","objective":"Deliver 3 parcels"}
```

New goals supersede queued older goals, but the executor waits for a safe
checkpoint before cancelling an active objective. If a game action remains
unresolved for 30 seconds, or an uncertain action outcome is reported, the
inbox **quarantines the next objective** instead of issuing a risky action.
You may press `Ctrl+D` to close the input and wait for the remaining safe
objective to finish, or `Ctrl+C` to stop. Check `course_objective_*` and
`game_objective_result` events in structured logs.

The instructor's real objective delivery/modify/replace mechanism remains
**unknown**. The NDJSON channel is a **local simulation fixture**, not a claim
of compliance with that external interface.

## Remaining official integration checklist

| Item | State | Evidence required |
|---|---|---|
| Official LLM endpoint/auth/model/format | **Pending** | Instructor URL, token format, API docs; live verified request |
| Course tool catalog contract | **Pending** | MCP URL or alternative protocol, approved tool names/schemas; live list and call |
| Objective change channel | **Pending** | Transport event schema, acknowledgment and cancellation policy; live replacement |
| Challenge 1 predefined simulation | **Pending** | Official scenario, logged external PDDL call/success, official evaluation |
| Challenge 2 predefined simulation | **Pending** | Official objective/tool integration, 2-agent evaluation |
| Submission deadline | **Pending** | Instructor announcement, at least one week before exam |

## Safety and reproducibility

- Do not commit `.env`, tokens, raw JWTs or private logs. Run `git ls-files .env`
  and check that it prints nothing.
- Reuse separate game JWTs for `bubble` and `milktea`. Course LLM and MCP bearer
  tokens are **different credentials**, never put them in game token fields.
- The Stage 3C.3 ablation experiment remains a frozen benchmark, using Ollama
  and local tools. Switching to a remote model/tool catalog changes the
  experimental setup and requires new measurements.
- PDDL uses the `@unitn-asa/pddl-client` online planner; A* alone does not prove
  the required external-planner integration.
- The 2026–27 tool slides explain MCP generally, but do not assert the course
  tool-server protocol. See the [MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
  for the protocol supported by the optional bridge.

## Implementation files

- `src/course/audit.js`, `scripts/audit-course.js`: 4A matrix and requirements check.
- `src/llm/providers/openai-compatible.js`: optional token-authenticated provider.
- `src/course/mcp-http.js`, `src/course/catalog.js`: optional MCP discovery + safe allowlist.
- `src/course/objective-inbox.js`: serialized local objective replacement.
- `src/llm-agent.js`: opt-in startup wiring; default Ollama behavior unchanged.
- `scripts/course-adapter-smoke.js`: fake-server integration smoke.
- `test/stage4b-integration.test.js`: protocol and safety regressions.
