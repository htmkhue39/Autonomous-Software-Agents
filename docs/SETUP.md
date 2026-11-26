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

Edit `.env` and set `HOST`, `TOKEN_BUBBLE`, `TOKEN_MILKTEA`, `OLLAMA_MODEL`, and `LLM_MODE`. Set `PLANNER` only to override its default (`online`); the benchmark runner and the course validator set it for each run themselves. The two token values must refer to **distinct players** on the same game server. Do not copy the original ZIP's `.env` into a publicly shared directory.

If you need fresh local tokens, `AGENT=bubble TOKEN_BUBBLE= npm run observe` (and similarly `AGENT=milktea TOKEN_MILKTEA= npm run observe`) prints a server-issued token. **Caution:** this legacy diagnostic script also tries movement and pickup, so run it only in your own throwaway local game. Prefer game-server-provided credential issuance if available. Store each token privately and reconnect using it to avoid duplicate player identities.

## 4. Prepare Ollama

Install Ollama and make the model configured by `OLLAMA_MODEL` available. The model used in our local experiments was `qwen3.5:4b-q4_K_M`. Check the installed tag with `ollama list`; pull it if missing. Start the Ollama service if it is not running, and verify `http://127.0.0.1:11434` is accessible. Use `LLM_MODE=json` for the tested Qwen configuration.

## 5. Manual agents

**BDI without the planner:**

```bash
AGENT=bubble PLANNER=disabled npm start
```

**BDI with the online PDDL planner (the default):**

```bash
AGENT=bubble npm start
```

Each pickup intention is a whole trip, as on page 12 of the course slides: walk to the parcel, pick it up, walk to the delivery tile, put it down. When an intention starts, the Plan Library looks for a plan in its archive. The archive keeps plans by the places they connect (the tile the agent starts on, the parcel's tile, the delivery tile, and how many parcels the agent carries), so a plan made once is used again whenever the same trip comes back. When the archive has no plan that still works, the agent starts walking at once with A* and asks the online solver in the background; it never waits for the solver. A plan that arrives while the agent is still on its path takes over the walk, and is archived either way. The solver is reached through `@unitn-asa/pddl-client` and requires internet access.

| Variable | Default | Meaning |
|---|---|---|
| `PLANNER` | `online` | `online` asks the course's online solver; `disabled` uses A* only. When unset, `MOVER=astar` means `disabled` and `MOVER=pddl` means `online`. |
| `PDDL_TIMEOUT_MS` | `10000` | how long to wait for one solver call; the online solver took 3 to 7 s in our tests |
| `PDDL_BREAKER_FAILURES` | `3` | failed solver calls in a row before the solver is skipped for a while |
| `PDDL_BREAKER_COOLDOWN_MS` | `60000` | how long the solver is skipped; then one call is tried again |
| `PDDL_MAX_CONCURRENT` | `2` | the most solver requests running at once; a request that timed out counts until it settles (60 s at most). A trip that comes again while its request runs waits for that request. |
| `PLAN_ARCHIVE_SIZE` | `500` | the most plans the archive keeps; the least recently used is dropped first |

What to look for in the logs:

- `pddl_call`, then `pddl_success` (with `durationMs` and `actions`) or `pddl_failure` (with `reason`): one solver call.
- `plan_archive_hit` and `plan_archive_miss`, with the `key`: whether the archive had a plan for the trip.
- `pddl_plan_used`, with `from: 'archive'` or `'solver'`: a PDDL plan was handed to the walk. `pddl_plan_replaced`, with the `reason` (`blocked` or `shorter`): A* then took over from it. `pddl_plan_unused`, with the `reason` (`intention ended`, `walk finished` or `off the plan path`): a plan came but A* had already done the walk.
- `pddl_breaker_open`, `pddl_breaker_half_open` and `pddl_breaker_closed`: the circuit breaker. A skipped call is logged as `planner_fallback`.

A `planner_fallback` or a `pddl_plan_unused` does not show that a PDDL plan drove the agent. Count `pddl_plan_used` less `pddl_plan_replaced` for the walks a PDDL plan drove to the end.

**LLM standalone:**

```bash
AGENT=milktea PLANNER=disabled LLM_MODE=json npm run start:llm -- \
  --objective "Collect and deliver at least one parcel."
```

**Two-agent cooperation:** use two terminals concurrently:

```bash
AGENT=bubble PLANNER=disabled COORDINATION_ENABLED=true npm start
```

```bash
AGENT=milktea PLANNER=disabled LLM_MODE=json COORDINATION_ENABLED=true \
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
