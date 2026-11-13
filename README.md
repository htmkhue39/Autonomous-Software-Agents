# Autonomous-Software-Agents

## Stage 4A + 4B — Course requirements audit and opt-in integration (current)

The latest implementation adds `npm run course:audit` (a sourced requirement/evidence
matrix) and `npm run course:smoke` (offline mock of a token-authenticated
OpenAI-compatible LLM and an allowlisted MCP Streamable HTTP tool catalog).
It also adds a **local-only** `LLM_OBJECTIVE_SOURCE=stdin` NDJSON objective
replacement channel, with safe-boundary cancellation and uncertain-outcome
quarantine. See [`docs/stage4a4b_course_integration.md`](docs/stage4a4b_course_integration.md).

**The official instructor LLM/tool endpoints, schemas, and objective transport
have not been provided in the uploaded slides. These optional adapters have
not been verified against the official course infrastructure.** Existing
Ollama/Deliveroo gameplay and Stage 3C.3 benchmark defaults remain unchanged.

BDI and LLM multi-agent project for the University of Trento [Deliveroo.js](https://github.com/unitn-ASA/Deliveroo.js) course.

## Stage 2C — two-agent cooperation (new)

**Base:** Stage 2B.1. **Default remains standalone** (`COORDINATION_ENABLED=false`). Enable coordination explicitly on **both** players and run `bubble` and `milktea` in separate terminals. The agents broadcast bounded, versioned SDK messages, share age-stamped parcel beliefs, announce intentions, and honor short parcel claims with route-aware conflict resolution. The LLM sees teammate state and its pickup tools validate claims before acting; the BDI option generator considers peer claims. This is not an extra central agent.

See **[Stage 2C macOS run guide](docs/stage2c_local_testing.md)** and **[Stage 2C verification report](docs/stage2c_test_report.md)**.

```bash
# Two independent terminals, same Stage 2C folder (keep your private .env):
AGENT=bubble MOVER=astar COORDINATION_ENABLED=true npm start
AGENT=milktea MOVER=astar COORDINATION_ENABLED=true npm run start:llm -- --objective "Deliver 3 parcels"
# With log files saved, summarize shared coordination evidence:
npm run summarize:coop -- logs/bubble-stage2c.log logs/milktea-stage2c.log
```

Automated verification is not a substitute for a live two-agent game test on your Mac. Standalone A* and PDDL modes remain available, and the course's unpublished LLM API/tool-server/objective interface are still unimplemented.

## Stage 2B — Independent LLM game agent (implemented, with a verified Stage 2B.1 live delivery)

**Baseline:** exact completed Stage 2A ZIP; Stage 1.1 BDI code is preserved. Stage 2B adds a separate player **`milktea`** using Ollama/Qwen, game-aware dynamic memory, seven allowlisted SDK-backed game tools, A* navigation and the existing PlanLibrary for pickup/delivery, action timeouts, and independently verified objective completion.

**Start with [Stage 2B local testing](docs/stage2b_local_testing.md)**. On your Mac, start the official game server with `GAME_NAME=oval_counterclockwise npm start`, keep Ollama running, and store a separate private `TOKEN_MILKTEA` in `.env`.

```bash
npm ci
npm test
npm run typecheck
HOST=http://localhost:8080 AGENT=milktea MOVER=astar npm run start:llm -- --objective "Collect and deliver at least one parcel."
# or native-model fallback, explicitly:
HOST=http://localhost:8080 AGENT=milktea LLM_MODE=json npm run start:llm -- --objective "Collect and deliver at least one parcel."
```

**Historical Stage 2B check:** 144/144 tests passed in the previous delivery environment. The user subsequently ran **Stage 2B.1 on their Mac**, and `milktea` completed a verified delivery objective (one parcel, score +4). This confirms the standalone LLM path on their machine, not two-agent cooperation or tournament performance. **Stage 2C added the coordination layer; its live two-agent run is still pending.**

## Stage 2A — LLM foundation (implemented)

Stage 2A adds an independent **Ollama HTTP provider**, **dynamic bounded memory**, a **strict allowlisted tool registry**, and a bounded **Plan–Act–Observe–Replan loop** with native Ollama tool calls and schema-guided JSON fallback. The code includes a harmless deterministic demo tool catalog and a live-local smoke test.

**Read [Stage 2A macOS local testing](docs/stage2a_local_testing.md).** Start with `npm run llm:smoke` and, if necessary, `npm run llm:smoke:json`. The Stage 2A demo itself has no Deliveroo.js connection. Stage 2B now contains a separate game identity and curated local game tools, but the course-provided tool catalog remains unavailable. The user has independently verified the Stage 2A native Ollama smoke test on their Mac.

**Verification in delivery environment:** 130/130 Node tests passed, strict JS typecheck passed, and a simulated HTTP Ollama interaction passed. **No real local Ollama/Qwen call was performed in this environment.**

## Stage 1.1 status

The current source contains the BDI agent, official SDK wrapper, beliefs, A* navigation, intention controller, predefined plans and external PDDL planning. This update stabilizes **pickup acknowledgment/sensing reconciliation**, preserves active delivery and valid exploration commitments, cools down failed goals, and logs navigation failures. The expected-reward utility stays unchanged.

**Automated verification on the newly modified source:** 105/105 tests passed; strict JavaScript typecheck passed in an isolated environment. **The team's previous version** was observed scoring in the local game and successfully using the real external PDDL solver. The Stage 1.1 A* and PDDL modes have since been demonstrated locally by the user; they remain the frozen baseline for Stage 2B.

**Start with [Stage 1.1 macOS local testing](docs/stage1_1_local_testing.md).** Use your existing private `.env`; no credential files or dependencies are shipped in the ZIP. The second LLM player and Stage 2C coordination have now been implemented. Real two-agent verification, the unpublished course integrations, and strategy benchmarking remain open.

## Project structure

```text
src/
  index.js                 autonomous BDI entry point (npm start)
  llm-agent.js             independent Ollama game player (npm run start:llm)
  client.js                official Deliveroo.js SDK wrapper
  config.js                environment and initial policy configuration
  beliefs/                 map, parcels, other agents, game clock
  deliberation/            pickup/delivery/explore options and expected utility
  planning/
    astar.js               route estimation and explicit fallback
    pddl/problem.js        PDDL movement domain/problem + plan validator
    pddl/solve.js          external course PDDL-client adapter
  plans/
    action-gate.js         prevents overlapping SDK actions
    moveTo.js              safe navigation, replanning and cancellation
    library.js             predefined pickup/deliver/explore plans
  intentions/
    revision.js            goal replacement policy
    agent.js               autonomous BDI control loop
  metrics/log.js           one JSON log record per event
  llm/
    providers/ollama.js    HTTP Ollama chat adapter (no new npm dependencies)
    memory.js              bounded objective/observation/tool memory
    validation.js          strict supported JSON-schema argument validator
    tools/registry.js      allowlisted tools with cancellation/timeout handling
    tools/demo.js          harmless local demo actions (not game actions)
    agent.js               bounded structured planning + tool loop
    game/                  Stage 2B observations, objectives, tools, runtime
  observe.js               legacy diagnostic script
  follow-path.js           legacy diagnostic script
  pickup-deliver.js        legacy diagnostic script
test/                      Node.js unit and deterministic integration tests
docs/                      requirements, design, implementation roadmap
```

## Local testing

Use **[docs/stage1_1_local_testing.md](docs/stage1_1_local_testing.md)** for verified macOS/zsh commands, setup of the official game server and admin viewer, separate agent token, A*/PDDL smoke tests, the 3-minute round, expected logs, the summary command and troubleshooting. Do not overwrite your existing `.env` with the template when upgrading.

Example (with server running, local token in `.env` and Node 22.x):

```bash
npm ci
npm test
npm run typecheck
mkdir -p logs
HOST=http://localhost:8080 MOVER=astar npm start 2>&1 | tee logs/astar-stage11.log
# Ctrl+C when finished
npm run summarize -- logs/astar-stage11.log
```

Then test PDDL separately with `MOVER=pddl` and confirm an actual `pddl_success` followed by movement; fallbacks alone do not establish external planning success.

## Other commands

| Command | Description |
| --- | --- |
| `npm start` | Runs autonomous BDI agent continuously |
| `npm test` | Runs unit and fake-client integration tests |
| `npm run typecheck` | Strict JSDoc/TypeScript validation |
| `npm run summarize -- logs/file.log` | Summarizes structured runtime events |
| `npm run llm:smoke` | Tests local Ollama native tool calling with demo tools (no game) |
| `npm run llm:smoke:json` | Tests schema-guided JSON fallback with the same demo tools |
| `npm run start:llm -- --objective "Deliver 1 parcel"` | Runs second `milktea` game agent (requires local server + Ollama) |
| `npm run summarize:llm -- logs/file.log` | Summarizes structured Stage 2B outcomes |
| `npm run observe` | Prints a diagnostic sample of server events and a new token |
| `npm run path` | Runs old fixed-path movement demo |
| `npm run deliver` | Runs old one-shot pickup/delivery demo |

The final course submission still requires **live Stage 2C two-player verification**, final Challenge 2 integrations, and evaluation, as documented in `docs/project_requirement.md` and `docs/implementation_plan.md`.

**Official course integration remains pending:** no instructor LLM token, tool-server catalog, or Challenge 2 objective transport has been provided yet. We keep provider/tool adapters replaceable rather than inventing those contracts.


### Stage 2B.1: real gameplay recovery patch

The new optional `collect_and_deliver` LLM tool performs a confirmed pickup
and a delivery using the existing game plans **without another Qwen call
between them**. This reduces latency-related parcel expiration. The native
LLM loop also makes one bounded corrective request when Qwen replies with
prose instead of a function call, and reports game action error messages.
See `docs/stage2b_local_testing.md` for the macOS verification procedure.

## Stage 2C.1 — Reliability patch (current)

Stage 2C.1 builds on Stage 2C without changing the standalone BDI or LLM agent architecture:

- Congestion-aware, cancellation-safe navigation (a static-path diagnosis is **never** permission to walk through an occupied tile).
- Route-and-decay-aware parcel feasibility and improved LLM target cooldown/inventory feedback.
- Less redundant STATUS/BELIEF traffic; immediate intention changes and claim renewals remain.
- Clear LLM invalid-request vs failed-game-action metrics.

For exact Mac commands, regression tests and known limitations, see [`docs/stage2c1_local_testing.md`](docs/stage2c1_local_testing.md) and [`docs/stage2c1_test_report.md`](docs/stage2c1_test_report.md).


## Stage 2C.2 — Dynamic LLM parcel targeting (current)

This release builds on Stage 2C.1 and preserves the BDI utility, external PDDL,
congestion recovery, and optional two-agent coordination. It adds an allowlisted
`collect_best_and_deliver({strategy:"highest_expected_reward"})` tool: Qwen
chooses the **strategy** while the executor chooses a recently observed,
reachable, viable, unclaimed parcel **at tool execution time**, then attempts
pickup + delivery without another model call. It can explore once when no
eligible parcel is known. Exact-ID tools remain supported. An `outcome_unknown`
SDK action is never blindly retried.

**Verified here:** 190/190 simulated tests, strict JavaScript typecheck and
syntax checks. **Not yet verified:** real Stage 2C.2 two-agent gameplay on the
user's Mac or improvement in Tournament score. See
[`docs/stage2c2_local_testing.md`](docs/stage2c2_local_testing.md) and
[`docs/stage2c2_test_report.md`](docs/stage2c2_test_report.md).


## Stage 2C.2.1 — Safe coordination-yield handling (current)

A live `milktea`/`bubble` test showed `coordination_yield` after 247 ms,
followed by `navigation_cancelled` **before pickup dispatch**. Previously the
LLM tool misclassified this as `outcome_unknown` and blocked the objective.
Stage 2C.2.1 distinguishes a peer-won claim with a known-safe navigation
cancellation from an ambiguous SDK action. The dynamic tool may select another
parcel after the safe conflict, still bounded by its existing retry limit.
A timeout, unknown SDK result, or cancellation after pickup dispatch **still
blocks automatic retry** and requires state reconciliation.

See [`docs/stage2c2_1_local_testing.md`](docs/stage2c2_1_local_testing.md)
and [`docs/stage2c2_1_test_report.md`](docs/stage2c2_1_test_report.md).

## Stage 2C.2.2 — Deterministic objective completion (current)

A live cooperative Stage 2C.2.1 run delivered **5 parcels** against the goal
`Deliver 3 parcels`, but the LLM loop returned `stalled/no_tool_calls` because
Qwen never explicitly called `finish_objective`. Stage 2C.2.2 corrects this:

- The independent `milktea` game runtime opts in to **automatic completion
  verification** against real delivery and score evidence after tool results.
  No additional LLM call is needed after the game proves the objective met.
- Game observations and `get_game_state` now expose `objectiveProgress`, with
  `target`, verified `current`, `remaining`, and cumulative game evidence. The
  count is **not** the number of currently visible parcels.
- The general-purpose Stage 2A `PlanActLoop` keeps automatic completion **off
  by default**, preserving its explicit completion contract for demo tools.
- `finish_objective` remains available. Unsupported local objective criteria
  remain blocked rather than being accepted based on model prose.
- `llm_objective_auto_verified` appears in logs and cooperation summaries.

This patch does **not** modify the BDI architecture, A*/PDDL, navigation,
parcel selection, communication, or coordination arbitration. For macOS steps,
see [`docs/stage2c2_2_local_testing.md`](docs/stage2c2_2_local_testing.md).
Live gameplay with this version remains to be verified on the user's Mac.

## Stage 3A — Repeatable local performance benchmarking

Stage 2C.2.2 is the frozen functional baseline (three consecutive JSON-mode
objective completions on the user's Mac). Stage 3A adds a separate fixed-
wall-clock benchmark runner; BDI/LLM reasoning and coordination algorithms
remain unchanged. It launches a **fresh official game server** for each trial
and compares A (BDI), B (BDI + independent LLM), and C (BDI + cooperating LLM).

```bash
# In the agent project, while the manual Deliveroo.js server is STOPPED:
npm run benchmark -- --server-dir "/ABSOLUTE/PATH/TO/Deliveroo.js" --runs 1 --duration 45
# After a successful smoke test:
npm run benchmark -- --server-dir "/ABSOLUTE/PATH/TO/Deliveroo.js" --runs 5 --duration 180
```

See **[Stage 3A benchmarking guide](docs/stage3a_local_benchmark.md)**.
Results go under Git-ignored `benchmark-results/`. Scores are **last SDK-
observed values, not official Tournament scores**; benchmark seeds are not
controlled. The continuous LLM mode is opt-in and cannot silently retry an
uncertain SDK action.

## Stage 3A.1 — Benchmark diagnostics and reliability

The upgraded fixed-duration benchmark rejects timing overruns, records model/tool/SDK/navigation latency, TCP health, readiness skew, source revisions and confidence intervals, while keeping the gameplay algorithms unchanged. See [Stage 3A.1 Mac instructions](docs/stage3a1_local_benchmark.md).

```bash
caffeinate -i npm run benchmark -- --server-dir "/ABSOLUTE/PATH/TO/Deliveroo.js" --runs 1 --duration 45
```

Results include `comparisons.json`; old Stage 3A manifests can be retrospectively audited with `npm run benchmark:summary -- benchmark-results/<old-run>`. Scores remain agent-observed (not official Tournament), and RNG seeds are not controlled.

## Stage 3C.2 — Delivery-lane evacuation (experimental)

Cooperative agent `milktea` now moves off a shared delivery tile **after a confirmed putdown**, before its next LLM decision. The bounded staging planner avoids occupied tiles and forbidden one-way moves and prefers non-chokepoint space. It does not change `bubble` or the cooperative parcel-claim protocol. Known evacuation failures never undo confirmed delivery; uncertain SDK moves remain fail-closed.

Default: enabled for cooperative C, disabled for independent B. To run an ablation on C without altering code, set `LLM_DELIVERY_EVACUATION=false` or `true` as a command prefix. Leave it unset for ordinary B-vs-C experiments. The effective setting is recorded in the `llm_game_startup` event and `llmDeliveryEvacuationEnabled` CSV column. New metrics include evacuation attempts and successes, teammate-caused congestion timeouts, and observed/censored delivery-tile dwell time. See [`docs/stage3c2_local_testing.md`](docs/stage3c2_local_testing.md) for commands and limitations.

## Stage 3C.3 — Randomized evacuation ablation (frozen agents)

Stage 3C.3 adds a balanced, order-randomized C0 (cooperative, evacuation **off**) versus C1 (cooperative, evacuation **on**) experiment. No decision logic changes. Each condition runs the same number of independent 180-second trials, with game restarts and a recorded scheduling seed. **This seed controls trial order only; Deliveroo.js game-world RNG is not verified or controlled.** Scores are agent-observed, not official Tournament scores.

```bash
# 45-second integration smoke test (2 trials total)
caffeinate -i npm run benchmark:ablation -- \
  --server-dir "/ABSOLUTE/PATH/TO/Deliveroo.js" \
  --runs 1 --duration 45 --schedule-seed 42

# 10 trials/condition (20 rounds total)
caffeinate -i npm run benchmark:ablation -- \
  --server-dir "/ABSOLUTE/PATH/TO/Deliveroo.js" \
  --runs 10 --duration 180 --mover astar --schedule-seed 20261112
```

Results go into Git-ignored `ablation-results/`, including per-round logs, condition-tagged CSV, unpaired Welch comparisons, a Markdown report and an SVG score chart. Trial validity checks independently verify the **effective** evacuation setting from agent logs; a mismatch is invalid. See [Stage 3C.3 instructions](docs/stage3c3_ablation.md).

## Stage 4C — Local end-to-end course-readiness validation

After `npm ci`, `npm test` and `npm run typecheck`, run `npm run course:failure-tests`
for **offline simulated fault/safety regressions**. The four local **live** Deliveroo.js
scenarios use a fresh server per run and check specific JSONL evidence:

```bash
caffeinate -i npm run course:validate -- \
  --server-dir "/Users/ntvan/Documents/sem 1/Agent/Deliveroo.js" \
  --scenarios bdi_pddl,llm_objective,cooperation,objective_replace \
  --duration 180
```

Output: `course-validation-results/<timestamp>/report.md`, `scenarios.csv`,
`manifest.json`, and per-scenario logs and JSON results. **Official Challenge
1/2 evaluation is NOT provided by this tool.** See
[Stage 4C validation guide](docs/stage4c_live_validation.md) for all
prerequisites, evidence assertions, safety caveats, and failure diagnostics.
