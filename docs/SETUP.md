# Installation and reproducibility (macOS/Linux)

This guide describes a **local Deliveroo.js environment**, not the professor's unpublished private evaluator. Use Node.js **22.x**, a separate game-server checkout, and a working Ollama installation. Do not publish login tokens or your `.env`.

## 1. Install dependencies

```bash
node --version              # expected: v22.x
npm ci
npm test
npm run typecheck
npm run release:check
```

`npm ci` requires access to the npm registry or a complete npm cache. `npm run typecheck` uses a pinned TypeScript **5.8.3** compiler via `npx` (which also requires npm access the first time). Neither dependency installation nor online PDDL can be validated offline. All unit tests can run offline once dependencies are installed.

## 2. Start a local game server

Clone the course [Deliveroo.js](https://github.com/unitn-ASA/Deliveroo.js) separately; this repository does **not** embed the server. In a dedicated terminal:

```bash
cd "/path/to/Deliveroo.js"
npm ci
GAME_NAME=oval_counterclockwise npm start
```

The expected local address is `http://localhost:8080`. Open the game viewer if desired. Keep this server running only for **manual** agent gameplay. The benchmark and course validator each launch/stop their own game server; close your manual server before using those commands.

## 3. Create private configuration

```bash
cp .env.example .env
```

Edit `.env` and set `HOST`, `TOKEN_BUBBLE`, `TOKEN_MILKTEA`, `MOVER`, `OLLAMA_MODEL`, and `LLM_MODE`. The two token values must refer to **distinct players** on the same game server. Do not copy the original ZIP's `.env` into a publicly shared directory.

If you need fresh local tokens, `AGENT=bubble TOKEN_BUBBLE= npm run observe` (and similarly `AGENT=milktea TOKEN_MILKTEA= npm run observe`) prints a server-issued token. **Caution:** this legacy diagnostic script also tries movement and pickup, so run it only in your own throwaway local game. Prefer game-server-provided credential issuance if available. Store each token privately and reconnect using it to avoid duplicate player identities.

## 4. Prepare Ollama

Install Ollama and make the model configured by `OLLAMA_MODEL` available. The model used in our local experiments was `qwen3.5:4b-q4_K_M`. Check the installed tag with `ollama list`; pull it if missing. Start the Ollama service if it is not running, and verify `http://127.0.0.1:11434` is accessible. Use `LLM_MODE=json` for the tested Qwen configuration.

## 5. Manual agents

**BDI standalone:**

```bash
AGENT=bubble MOVER=astar npm start
```

**BDI with external PDDL:**

```bash
AGENT=bubble MOVER=pddl npm start
```

Inspect the agent JSONL logs/terminal for `pddl_call` and `pddl_success`. A `planner_fallback` to A* does not demonstrate a successful external PDDL call. The solver is reached through `@unitn-asa/pddl-client` and requires internet access.

**BDI with the PDDL task planner:**

```bash
AGENT=bubble MOVER=astar TASK_PLANNER=pddl npm start
```

With two parcels or more involved, the agent asks the external solver for the order of pickups and deliveries, while A* still finds each walk. The settings are:

| Variable | Default | Meaning |
|---|---|---|
| `TASK_PLANNER` | `off` | `pddl` turns the task planner on; `off` keeps the agent's own choices |
| `TASK_PLANNER_MAX_PARCELS` | `5` | the most free parcels in one task problem, the nearest first |
| `TASK_PLANNER_FOLLOW` | `always` | `always` carries out every valid plan as the planner returned it; `better` only one worth at least the agent's own choice |
| `TASK_PLANNER_TIMEOUT_MS` | `10000` | how long to wait for a plan before going on without it; the online solver took about 6-7 s per call in our tests |

Look for `pddl_task_call`, then `pddl_task_success` or `pddl_task_failure` (with `reason`), each with `durationMs`, and `pddl_task_choice`, which shows whether the plan was followed (`adopted`), what it was worth (`planFirstTrip`) against the agent's own choice (`netGainUtility`), and how many moves it takes (`planMoves`) against the fewest any order would take (`optimalMoves`). Intentions taken from the plan are logged with `source: 'pddl_task'`.

**LLM standalone:**

```bash
AGENT=milktea MOVER=astar LLM_MODE=json npm run start:llm -- \
  --objective "Collect and deliver at least one parcel."
```

**Two-agent cooperation:** use two terminals concurrently:

```bash
AGENT=bubble MOVER=astar COORDINATION_ENABLED=true npm start
```

```bash
AGENT=milktea MOVER=astar LLM_MODE=json COORDINATION_ENABLED=true \
  npm run start:llm -- --objective "Deliver 3 parcels"
```

Cooperative post-delivery evacuation is enabled by default for `milktea` when coordination is true. It can be explicitly set to `false` or `true` for ablation trials.

## 6. Live local evaluation (automatic server lifecycle)

Stop the manually started Deliveroo.js server first. For **functional** evidence:

```bash
npm run course:validate -- \
  --server-dir "/path/to/Deliveroo.js" \
  --scenarios bdi_pddl,llm_objective,cooperation,objective_replace \
  --duration 180
```

For **performance** evidence:

```bash
npm run benchmark:ablation -- \
  --server-dir "/path/to/Deliveroo.js" \
  --runs 10 --duration 180 --mover astar --schedule-seed 20261112
```

The course validation scenario duration is a *maximum* observation window and not a fixed-length score competition. The ablation uses fixed-duration rounds, fresh servers, and a randomized C0/C1 order, **not** paired/controlled game seeds. Runtime logs may contain identifiers and should not be shared without review.

## 7. Common failures

| Symptom | Likely cause / next step |
| --- | --- |
| `npm ci` fails or hangs | Check registry DNS/network; do not treat a test run with copied `node_modules` as a fresh install |
| PDDL `planner_fallback` | Online solver unreachable or invalid plan; inspect `pddl_failure`; do not claim PDDL passed |
| LLM connection error | Ensure Ollama serves the exact `OLLAMA_MODEL` and uses the configured base URL |
| Unexpected duplicate agent | Confirm separate `TOKEN_BUBBLE` / `TOKEN_MILKTEA` and no duplicate manual sessions |
| Runner refuses to start | Stop any existing game server on `localhost:8080` |
| C0/C1 scores vary | Different random game worlds and LLM timing; use many trials and retain all results |
| `release:check` flags tracked runtime results | Run `git rm -r --cached --ignore-unmatch course-validation-results benchmark-results ablation-results course-audit`; this untracks files without deleting local copies |

## 8. Optional interfaces, not officially verified

The external OpenAI-compatible model adapter (`LLM_PROVIDER=openai_compatible`, `COURSE_LLM_*`), MCP Streamable HTTP catalog (`COURSE_MCP_URL`, approved allowlist), and local stdin NDJSON objective-replacement channel (`LLM_OBJECTIVE_SOURCE=stdin`) were tested against local mocks or local gameplay, **not** the instructor's unpublished remote contracts. Avoid claiming official compatibility until real service details are provided and verified.
