# System design

This file records **how we choose to satisfy** [project_requirement.md](project_requirement.md) and why. It describes the baseline to build first and the alternative policies to test afterwards. The build sequence is in [implementation_plan.md](implementation_plan.md).

## 1. Development strategy

**First achieve complete, reliable course compliance; then run controlled experiments and select the best performing configuration.** Do not change an existing working module merely to follow another project's directory structure.

Three operating modes help keep experiments honest:

1. **Part 1 baseline:** BDI with predefined plans and A* route support, for early integration testing.
2. **Part 1 compliant:** BDI with external PDDL planning **invoked at intention activation**, plus predefined plan support and logged fallbacks.
3. **Part 2 compliant:** the working BDI agent plus a second, tool-using LLM-based game agent that communicates and coordinates with it.

The first mode alone is **not** the final Part 1 deliverable. A* is retained because it already works, provides fast distance estimates, and makes a useful comparator.

## 2. High-level architecture

```text
                         Deliveroo.js server
                     official SDK + game events
                       /                   \
            separate game identity     separate game identity
                    |                         |
                BDI Agent                LLM Agent
          beliefs / options / I        own game observations
          intention revision           dynamic objective memory
          plan library / PDDL          LLM reasoning + replanning
          action execution             bounded tool execution
                    |                         |
                    +--- SDK messages <------>+
                         beliefs, intentions,
                         task claims, outcomes

          Reused (but not shared mutable state):
          SDK wrapper, map/navigation helpers, action runner,
          structured logs, configuration utilities, tests
```

Each agent owns its **own** belief state, objective/intentions and SDK connection. Code can be reused by composition; game identity and mutable mental state must not be accidentally shared. The LLM is not just a terminal attached to Agent 1. Both agents must be capable of useful actions and of communicating decisions.

## 3. Existing baseline — preserve it

These paths exist in the current source tree and have unit tests:

| Responsibility | Existing file(s) | Design decision |
|---|---|---|
| SDK integration | `src/client.js` | Keep this as the game-facing wrapper; extend messaging/action methods as needed. |
| Environment/configuration | `src/config.js`, `.env.example` | Preserve per-agent token handling (`AGENT`, `TOKEN_<NAME>`), expand only for new options. |
| Data types | `src/types.js`, `types/sdk.d.ts` | Extend JSDoc contracts rather than migrate the whole codebase to TypeScript. |
| Game clock / map / parcels / agents | `src/beliefs/` | Keep server-time estimation, parcel revision, refused-edge tracking and recent-agent blocking. |
| Navigation | `src/planning/astar.js` | Keep shortest-path queries for utility estimates and fallback. |
| Options and utility | `src/deliberation/options.js`, `utility.js` | Preserve as baseline; make alternative scoring strategies swappable later. |
| SDK demos | `src/observe.js`, `follow-path.js`, `pickup-deliver.js` | Keep as diagnostics until end-to-end tests replace their purpose. |

Stage 1 adds `src/index.js`, `src/plans/`, `src/intentions/`, and `src/planning/pddl/`. These components pass unit and fake-client tests. The second LLM agent remains outside Stage 1. The team verified real local game play and external PDDL calls for the previous Stage 1 build on 2026-11-11. Stage 1.1 modifications require a fresh local smoke test; see `stage1_test_report.md`.

### Known behavior and compatibility checks

- **Capacity:** in the game, `capacity = -1` means unlimited. `src/deliberation/options.js` already handles unlimited capacity (`-1`) with a regression test.
- **Fractional movement coordinates:** the existing belief layer rounds positions for tile reasoning; do not confuse transitional coordinates with completed moves.
- **Uncertain move outcomes:** `src/client.js` now propagates SDK transport exceptions. `ActionGate` places a deadline on awaiting actions and keeps the action locked until the underlying promise settles. `BdiAgent` requires fresh observation after an unknown outcome; it does not blindly retry.
- **Map and plugins:** Stage 1 enforces directional arrow traversal, and observed crates receive temporary blocks. Energy, doors, batteries, special movement modes, and other plugins are not yet explicitly modeled; use a standard parcel-delivery configuration for verification. Check each enabled plugin before tournament use.
- **Game settings:** never hardcode a universal decay interval, penalty, capacity, observation radius, or movement duration from one scenario. The older docs contain observations about specific maps, not global rules.

## 4. BDI cycle and intention lifecycle

The BDI controller follows:

```text
Observation -> belief revision -> generate options -> score options
            -> select/revise intention -> select/obtain plan
            -> execute an action -> observe result -> repeat
```

### Baseline goals/options

- `pickup:<parcelId>`: reach a known free parcel and pick it up.
- `deliver`: reach an applicable delivery tile and put down carried parcels.
- `explore:<x>,<y>`: inspect a reachable parcel-spawn area when collection/delivery is not worthwhile.

Keep option IDs stable and re-evaluate values as beliefs change. A newly observed parcel or failed plan may justify reconsideration; not every sensor event needs a full external planning call.

### Initial intention policy (Stage 1.1)

- When idle, choose the best currently viable option, excluding temporarily cooled-down failed goals.
- Hard-invalidate promptly when a goal truly becomes impossible, e.g. the target parcel is confirmed missing or the carried load is gone.
- Keep an applicable goal when option ranking changes; a different *preferred* exploration tile is not a reason to cancel current exploration.
- Delivery intentions remain committed unless invalidated or superseded by a future explicitly higher-priority goal (rather than a marginally better pickup).
- Other nonurgent utility-based switches require `REPLACE_MARGIN` (default `1.2`) and `MIN_COMMIT_MS` (default `6000` wall-clock milliseconds); exploration still yields promptly when a positive-reward option becomes available.
- After failed/unknown plans, `FAILED_GOAL_COOLDOWN_MS` (default `10000`) suppresses immediate reactivation of the same goal. A cooldown expires and the goal may be tried again.
- Pickup response outcomes are reconciled with acknowledged parcel IDs and, where needed, a short sensing window; unconfirmed pickups must never be reported as success. In-progress final SDK actions are not interrupted by incidental belief changes.
- Use stop/cancel signals and serial actions; record why switches, cancellations and retries occur.

The 20% margin is a **starting parameter**, not a course requirement and not a proven optimum. Benchmark it later.

## 5. Utility function — baseline now, alternatives later

The existing `expectedReward(rewards, moves, timing)` estimates the value remaining after the trip using the server's movement duration and decay interval:

```text
lossPerParcel = floor(routeMoves * moveMs / decayMs)
expectedValue = sum(max(0, reward_i - lossPerParcel))
```

When decay is infinite, loss is zero. The pickup option estimates a route **self -> parcel -> delivery**, while `deliver` estimates **self -> delivery**. A* is used to estimate the route length. This baseline is intentionally understandable and already tested; it ignores pickups/drops duration, some collision risks, penalties, and uncertainty.

**Known ranking limitation:** pickup includes the existing load's eventual reward, so comparing pickup and immediate delivery by their total predicted reward may not express the **incremental benefit** of making the pickup detour. Do not change the formula until Part 1 is functional and a benchmark can measure the difference.

Future alternatives, implemented behind a strategy selector:

1. **Baseline expected reward:** current implementation.
2. **Marginal pickup value:** predicted score of `pickup then delivery` minus predicted score of `deliver now`, including extra travel time and action time where modeled.
3. **Reward per unit time:** expected score or incremental score divided by estimated completion time, with safe handling of zero-length routes.
4. **Competition/uncertainty-aware:** weight reward by observed target availability and competitor/teammate claims; keep belief confidence explicitly separate from ground truth.

Never compare incompatible utility scales without defining a consistent intention-switching rule. For experiments, keep the same sensing, planner, and environment while changing one policy at a time.

## 6. Plans, navigation and external automated planner

### Predefined plans

Use a small plan library with explicit applicability, execution, success/failure, and cancellation behavior:

- Move to a valid tile.
- Pickup at a parcel's tile.
- Deliver at a delivery tile.
- Explore a target tile.

The plan runner executes one action at a time through `src/client.js` and updates the existing beliefs from actual action results. Guard actions with a single-flight rule; on a move timeout, check subsequent state before concluding failure or issuing a conflicting action.

### PDDL integration

Use the course `@unitn-asa/pddl-client` (the repository already declares it), especially the `PddlProblem`, `PddlDomain`, `onlineSolver`, and/or `PddlExecutor` APIs shown in Lab 5.

- On activation of a new intention, construct a PDDL problem from the relevant current beliefs and invoke the **external** solver.
- The initial domain may plan movement to a chosen target, while the BDI plan library handles pickup/putdown; the solver must still be genuinely invoked on intention activation.
- Validate returned moves and preconditions before use. Cache the plan; replan on meaningful invalidation rather than every step.
- If no valid plan is returned, apply a bounded, logged fallback (e.g., A*) where safe. Do **not** count a fallback-only run as evidence of successful external planning.
- Separate modes for comparison: `pddl` compliant vs `astar` baseline. Record requested/returned plans, success/failure, solver latency, and fallback use.

PDDL optimizes only what its domain/cost model expresses; a returned plan should not be called optimal without evidence.

## 7. Second LLM-based agent

### Provider abstraction

Local development uses Ollama with the model already available to the team:

```dotenv
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:4b-q4_K_M
```

The Ollama adapter can use `/api/chat` with non-streaming calls first, then native tool calls where the installed model/runtime support them. Parse and validate outputs; never rely on an unvalidated free-text command to perform a game action.

Provide a second adapter for the course token-authenticated LLM endpoint once its contract is known. Keep model/provider-specific HTTP and response formats outside the agent's planning logic. Credentials stay in local `.env`, never in prompts/logs/source control.

### LLM agent loop

```text
Receive objective / important new observation
 -> update compact working memory
 -> read available tool definitions
 -> ask LLM for plan or next tool call
 -> validate tool name, arguments and constraints
 -> execute authorized tool through an adapter
 -> observe result and update memory
 -> check objective completion / failure / change
 -> continue or replan (bounded iterations)
```

The LLM agent needs its own game observations and ability to execute actions. Use deterministic helpers for low-latency navigation, moving, and picking up; the LLM should focus on **objective interpretation, selecting tools, planning, and responding to changed results**. A structured plan or bounded tool-calling loop is the initial approach. ReAct-style reflection and more complex memory are later candidates, not prerequisites.

### Memory

Start with short-term structured context, **not a vector database**:

- Current objective, identifier and status (active, achieved, superseded, failed).
- Current game state summary relevant to that objective.
- Known teammate positions, beliefs and committed intentions (with timestamps/source).
- Tool catalog metadata, active plan and recent executed steps/results.
- A small capped history or summaries of recent reasoning/tool outcomes.

Expired/contradictory observations are revised, not appended forever. Never assume a teammate's message is certain ground truth.

### Objective input and course tools

Use an input adapter so tests can inject objectives without a server. Prefer the **actual course-provided objective channel** in the final integration; terminal input is a useful development fallback, not the sole evaluation interface.

Use a tool-catalog adapter for the course server. During local tests, inject a mock catalog with equivalent schemas and safe local SDK-backed tools. A passing mock alone does not verify compatibility with the course's real tool server. Validate tool names, arguments and action permissions, and explicitly handle unknown/unavailable tools, timeouts and invalid LLM responses.

### Responsiveness and boundaries

- Do not call the LLM on every frame or movement action.
- Bound total LLM iterations, tool calls, wall time and retries per objective (settings, not hard-coded assumptions).
- Handle pending or superseded objectives and stale tool outputs.
- Keep each game identity's movement single-flight and recover from ambiguous action completion.
- The LLM has planning authority for its **own** agent; it may request or negotiate teammate help, but it does not silently override Agent 1's intentions.

## 8. Two-agent communication and coordination

Use the official SDK messaging (`emitSay`, `emitAsk`, `emitShout`, and their receive events) instead of adding an independent messaging server unless a requirement arises. Add message methods to `src/client.js` rather than opening another SDK connection.

Start with a small, versioned message schema:

```json
{
  "v": 1,
  "type": "CLAIM",
  "sender": "agent-id",
  "objectiveId": "task-id",
  "parcelId": "parcel-id",
  "expiresAt": 100000,
  "seq": 12
}
```

Other message types: `BELIEF`, `INTENTION`, `RELEASE`, `COMPLETE`, `FAILED`, `HELP`. Validate source, age, schema and duplicates. `expiresAt` is in a **defined shared timebase** (server frame/time if available); do not compare unrelated local timestamps across processes.

**Baseline coordination:** exchange relevant parcel/agent observations and intentions; claim a parcel before committing; release claims on completion, failure, cancellation or expiration; if both claim simultaneously, resolve deterministically (e.g., distance, then agent ID). If a teammate disappears, claims expire and tasks can be reconsidered.

Both agents retain autonomous goal selection. Later alternatives: static roles, greedy nearest-agent assignment, auction/bid coordination, uncertainty-aware allocation, and congestion-aware cooperation.

## 9. Tests, measurements and experiments

Test structure:

- **Unit tests:** beliefs, utility, options, switching rules, PDDL problem construction, LLM memory and tool validation, message parsing, task claims.
- **Integration tests (fakes):** plan execution with move failures/timeouts, cancellation, no duplicate actions, fake solver, fake LLM, fake tool catalog, messages between two agents.
- **Live smoke tests:** SDK connection, agent identity/tokens, pickup/deliver, actual external PDDL invocation, actual Ollama tool calls, actual course tools, two concurrent agents on one server.
- **Challenge simulations:** run predefined course scenarios when provided; retain logs and scenario metadata.

Log run ID, configuration, scenario, agent identities, game score, deliveries, failed actions, PDDL calls/results/latency, LLM calls/latency/invalid tool actions, intention switches, communication events, duplicate claims and objective success. Avoid secrets and overlarge raw model prompts in standard logs.

Experiments must be reproducible: compare configurations on the same scenarios; control seeds if the server allows; use multiple trials; report mean, dispersion and important failures. Keep the **course-compliant configuration** available throughout tuning.

## 10. Decision status and open questions

| Decision | Current agreement |
|---|---|
| Development order | **Fixed:** compliance -> baseline -> controlled benchmarks -> final selection. |
| Existing BDI core | **Fixed:** preserve working modules and tests; extend rather than rewrite. |
| Intention policy | **Baseline chosen:** `replaceMargin = 1.2`; benchmark alternatives. |
| Utility | **Baseline chosen:** current expected reward; benchmark marginal/time-aware strategies later. |
| Navigation | **Baseline chosen:** A* plus required external PDDL integration. |
| Two agents | **Chosen:** independent BDI and LLM game agents sharing implementation helpers. |
| LLM model | **Development choice:** local Ollama `qwen3.5:4b-q4_K_M`; provider replaceable. |
| LLM pattern | **Baseline chosen:** bounded structured tool-execution loop with dynamic context and replanning. |
| Communication | **Baseline chosen:** SDK messaging and expiring claims. |
| Advanced policies | **Deferred:** probabilistic beliefs, vector memory, auctions, optimization of thresholds. |

**Verify with course staff/infrastructure:** permitted model for evaluation, exact LLM and tool service contracts, how natural-language objectives arrive, plugin/scenario settings for the challenges, and any scoring rules beyond the published project slides. These are integration questions, not reasons to prematurely invent an API.

## Stage 1 implementation note

The execution path uses `ActionGate` for serialized SDK actions, `MovementRunner` for target navigation, `PlanLibrary` for pickup/delivery/exploration, and `BdiAgent` for goal commitment and reconsideration. An activated intention obtains a PDDL movement plan where navigation is needed; if the external solver fails, the agent emits `pddl_failure` followed by `planner_fallback` and navigates using A*. A fall-back-only run is **not** external-planning validation.

Stage 1 logs JSON events: `intention_activated`, `intention_revision`, `move`, `move_refused`, `pickup`, `delivery`, `score_changed`, `pddl_call`, `pddl_success`, `pddl_failure`, `planner_fallback`, and `intention_outcome`. The future benchmark collector can consume these lines.


## Stage 2A — Implemented LLM foundation (not yet a second game agent)

The Stage 1.1 source remains unchanged. The approved Stage 2A choice is a **compact structured plan followed by bounded ReAct-style tool decisions**. The initial provider is local Ollama (`qwen3.5:4b-q4_K_M`). A provider must accept chat messages plus an optional tool catalog/format and return a normalized assistant message; the course provider's auth/HTTP contract is deliberately unimplemented until published.

New code under `src/llm/`:

- `providers/ollama.js`: HTTP `/api/chat` provider; default `stream:false`, `think:false`, deterministic temperature, configurable timeout; no SDK/game dependency.
- `memory.js`: versioned objective, expiring observation, current structured plan and a capped tool-result history; objective replacement clears obsolete plans/outcomes.
- `validation.js` and `tools/registry.js`: reject unsupported schemas, unknown tool names, extra/wrong arguments; bound tool execution and treat timed-out in-flight side effects as **uncertain**, never a safe automatic retry.
- `agent.js`: structured JSON plan validation with allowed tool names, native Ollama tool calls or JSON action fallback, tool result feedback, objective cancellation, max-step/max-tool caps and optional external completion verification. Without a verifier, the model may return `reported_completed` but **not verified completion**.
- `tools/demo.js`: deterministic, side-effect-free demo functions for Stage 2A tests only; these are **not** the professor's tool catalog.

The model is never asked for a hidden reasoning transcript; it emits a concise structured plan and selects tools. Future game observations must be curated to avoid sending tokens or admin-only global state. Real SDK navigation, parcel picking, teammate communication, and the second player identity are Stage 2B/2C tasks. Tool calls should be high level so the LLM is not consulted on every movement step.

**Verification:** 130 automated tests and strict JS typechecking pass in the delivery environment; tests include an HTTP fake-provider workflow. The real Qwen-on-Mac smoke is a separate pending local acceptance gate (see `stage2a_local_testing.md`).

## Stage 2B — Independent LLM-controlled game actor (code complete, live test pending)

The Stage 2A archive is the baseline. A new `src/llm-agent.js` runs a **separate** `milktea` process and `TOKEN_MILKTEA`; `bubble` retains its original `src/index.js` and private token. A `createGameRuntime` factory instantiates fresh beliefs, action gate, movement runner, plan library, model memory and objective tracker for the LLM actor. Only the existing class implementations are shared; mutable state and sockets are not shared.

The tool allowlist is `get_game_state`, `get_known_parcels`, `get_delivery_tiles`, `navigate_to`, `pickup_parcels`, `deliver_parcels`, `explore`. Tools validate arguments, preconditions and action outcomes before reporting success. `navigate_to`, `pickup_parcels`, `deliver_parcels` reuse Stage 1.1 `MovementRunner`/`PlanLibrary` rather than replacing the SDK or treating a model recommendation as a movement command. External tools are not permitted to execute shell instructions or arbitrary remote requests.

The LLM sees a **bounded, explicitly partial observation** (self, rules, top known free parcels, carried parcels, delivery tiles, recent occupied cells) updated on meaningful tool results; it is not presented with global, admin-only game state. The LLM chooses objectives, tool order, parcel IDs and recovery actions; A* handles detailed movement. The model cannot self-certify objective completion: a deterministic, separate `GameProgress` verifier checks the running game score or delivery acknowledgments. The locally supported objectives are deliver N parcels, reach a score, and earn additional score. Unsupported objective semantics return blocked, rather than a fabricated completed status. Official course objective transport and tool catalog are deferred until their real specification is published.

The new loop preserves Stage 2A native-tool and JSON fallback modes. On an uncertain tool outcome (e.g., timeout after SDK dispatch), execution halts for explicit reconciliation rather than blindly retrying a potentially completed action. Stage 2B is a **single-objective** run; continuous tournament policy and independent-agent cooperation are later experimental phases.

**Verification boundary:** 144 passing unit/fake-integration tests and clean strict JavaScript typechecking. They do **not** replace the live Mac acceptance gate (real Ollama plus server) or prove two-agent cooperation. See `stage2b_local_testing.md` and `stage2b_test_report.md`.
