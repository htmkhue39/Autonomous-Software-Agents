# Implementation plan

This is the task tracker for turning the agreed [design](design.md) into working code. [Project requirements](project_requirement.md) define what must be demonstrated; this file defines **what to implement next, which code to reuse, and how to prove each milestone is complete**.

**Development order:** complete Part 1 -> complete Part 2 -> establish benchmarks -> compare alternative strategies -> select final configuration. Keep existing functionality and tests. Before each task, inspect the current working tree; a checked box in this document is not a substitute for a passing test.

## Current baseline

| Area | Existing code | Status | Next step |
|---|---|---|---|
| SDK and per-agent config | `src/client.js`, `src/config.js`, `.env.example` | [x] Implemented | Extend for chat/tools and action timeout safety only as needed. |
| Belief representation/revision | `src/beliefs/*`, `src/types.js` | [x] Implemented | Preserve and test integration with actions/messages. |
| A* navigation | `src/planning/astar.js` | [x] Implemented | Reuse; do not replace. |
| Option generation / expected-reward utility | `src/deliberation/*` | [x] Implemented | Fix unlimited-capacity handling; preserve baseline policy. |
| SDK smoke/demo scripts | `src/observe.js`, `src/follow-path.js`, `src/pickup-deliver.js` | [x] Present | Keep as diagnostics until replaced by reliable integration tests. |
| Autonomous movement and plans | `src/plans/` | [x] Implemented; previously verified live | Stage 1.1 pickup/movement fixes require local recheck. |
| Intention revision and BDI run loop | `src/intentions/`, `src/index.js` | [x] Implemented and observed live | Stage 1.1 commitment/cooldown policy requires local recheck. |
| External PDDL planning | `src/planning/pddl/` | [x] Real solver invoked and route executed on local Mac | Retest after Stage 1.1; preserve actual `pddl_success` evidence. |
| Second LLM agent | `src/llm/`, `src/llm-agent.js` (proposed) | [ ] Missing | Tasks 10–13. |
| Team communication and coordination | `src/coordination/` (proposed) | [ ] Missing | Task 14. |
| Benchmarks and final write-up | `scripts/benchmarks/`, `docs/results.md` (proposed) | [ ] Missing | Tasks 16–18. |

Stage 1.1 checks against the **current ZIP**: **105/105** tests passed (`npm test`) and strict JSDoc checking passed (`tsc -p jsconfig.json`) with Node type definitions available. The team has previously demonstrated `npm start` on a real local Deliveroo.js server, autonomous delivery/scoring, and genuine external `pddl_success` with executed solver routes on 2026-11-11. **These live checks used the preceding Stage 1 source**. Repeat the local acceptance checks for the newly fixed Stage 1.1 build; use [stage1_1_local_testing.md](stage1_1_local_testing.md). Keep the team's private `.env` out of shared ZIPs.

## Workflow for every task

1. Read the relevant requirement and section of `design.md`.
2. Inspect the existing code and tests first; prefer extending a tested component over introducing a duplicate.
3. State the smallest interface/contract change and write focused failing tests where practical.
4. Implement only the task in progress. Do not simultaneously add deferred optimization policies.
5. Run the relevant tests, the whole suite (`npm test`), and `npm run typecheck`. If a network/server dependency is unavailable, report the blocked live check accurately.
6. Update the checkbox and document the actual outcome. Avoid marking live validations complete based on mocks.

All new filesystem paths below are **suggested**, not compulsory: align them with any equivalent code already in the live branch.

---

## Phase A — Finish Part 1 fundamentals

### Task 5a — Correct known baseline edge cases

**Reuse:** `src/deliberation/options.js`, existing option tests; `src/client.js` for action safety.

- [x] Correct pickup capacity so `capacity === -1` means unlimited; add a regression test. Do not alter the original scoring algorithm while fixing this.
- [x] Review `client.move()` response behavior for rejected vs unresolved actions. Design single-flight action execution and state reconciliation; do not automatically treat a timed-out move as definitely failed.
- [ ] Verify current SDK and map assumptions (tile types, special plugins, moving positions) in a local or course-server smoke check; record unsupported configurations.
- [x] Re-run all existing tests and typecheck after fixes (105 tests total; local typecheck with available Node typings).

**Done when:** existing tests still pass; unlimited capacity is handled; failures and uncertain action outcomes have explicit tests/handling in subsequent runner work.

### Task 6 — Movement runner and predefined plan library

**Reuse:** `src/client.js`, `src/beliefs/index.js`, `src/beliefs/map.js`, `src/planning/astar.js`.

**Likely files:** `src/plans/moveTo.js`, `src/plans/library.js`, `test/plans.test.js`, `test/fake-client.js`.

- [x] Build an **abortable, single-flight** action runner. Never issue two concurrent moves for one agent identity.
- [x] Walk towards a target using the existing A* pathfinder; re-evaluate the next step after observations or a blocked edge.
- [x] Use `map.failMove(...)` and `map.moveSucceeded(...)` to update beliefs when outcomes are known. On timeout/disconnection, reconcile position before another move.
- [x] Implement predefined plans with applicability + success/failure/cancel contracts: `moveTo`, `pickup`, `deliver`, `explore`.
- [x] Reuse `ParcelBeliefs.pickedUp(...)` and `.putDown(...)` after successful SDK actions; handle already-taken, decayed, and unreachable parcels.
- [x] Add focused tests for successful route, refused movement, ambiguous timeout, cancellation, disappeared pickup, delivery and single-flight actions; Stage 1.1 adds pickup reconciliation and diagnostics regressions.

**Done when:** given a selected option, the agent can perform the associated plan, update beliefs, and return a meaningful terminal outcome in fake-client tests.

### Task 7 — Intentions, revision and autonomous BDI loop

## Done

- **Task 1, setup.** Project, game client wrapper that never crashes the
  agent, shared types, demo scripts. What the server really does is in
  design section 9.
- **Task 2, map.** Tile types, walkable tiles, neighbours, delivery and
  spawn tiles, temporarily blocked tiles, when each tile was last seen.
- **Task 3, parcels and agents.** Parcel values estimated from decay;
  parcels and agents forgotten when their tile is seen empty; recently seen
  agents block tiles; all beliefs fed by server messages, ready once
  settings, map and position are known, every change announced.
- **Task 3b, game clock.** Times use the server's game time. Parcels the
  agent carries come from its own pickup and putdown results; delivered
  parcels are forgotten.
- **Task 3c, agents that left.** An agent is forgotten as soon as its tile
  is seen without it.
- **Task 3d, moving agents.** An agent between two tiles blocks both, and is
  forgotten only once both are seen without it.
- **Task 4, A\*.** Shortest routes that avoid walls, occupied and forbidden
  tiles; closest of several targets. A refused move is remembered and
  avoided for longer each time it is refused again.
- **Task 5, scoring and options.** A trip is worth the reward left at
  delivery. Options: pickup, deliver, explore; worthless ones dropped, the
  rest sorted best first. Energy is left out until the course staff say
  whether it is active.
- **Task 6, movement and plans.** `moveTo` walks one step at a time with a
  fresh route each step from a planner passed in (`astarRoute`), stops
  when told, records refused and unanswered moves, and gives up after three
  failures. Before each step it acts on the spot: picks up free parcels on
  its tile and puts down on a delivery tile. One plan per kind of option;
  deliver heads for the nearest delivery tile that can be reached. Tested
  against a fake game server in `test/helpers.js`.
- **Local server and pickup replies.** The course server's code is linked
  as `deliveroo-server/` and runs locally with `npm run server`. A first
  live run showed that pickup and putdown replies carry no parcel ids, so
  the beliefs now match those parcels by tile (design section 9).

**Likely files:** `src/intentions/intention.js`, `src/intentions/revision.js`, `src/index.js`, `test/intentions.test.js`, `test/agent-loop.test.js`.

## Phase 3: Acting

Design sections 3 and 4. At the end of this phase the agent plays on its
own.

**Task 7: Intentions and the agent loop**

Files: `src/intentions/intention.js`, `src/intentions/revision.js`,
`src/index.js`, changes to `src/beliefs/parcels.js` and
`src/deliberation/options.js`, and the tests. The observation demo script
is removed.

- An intention holds one option, runs its plan, and can be stopped. It
  fails when no plan fits or the plan crashes.
- Switching rule: never without a better option; always when idle; never to
  the same option; always to a higher priority, never to a lower one;
  otherwise only when the new option is worth more than the current one
  times the margin and at least one point more.
- The loop waits until beliefs are ready, commits to the best option,
  carries it out, and repeats; with no options it waits for a change.
- On every change, re-score the current intention and stop it if the
  switching rule says so.
- Stop a pickup at once when its parcel is no longer free. The switching
  rule alone would keep it: a dead pickup and exploring are both worth 0.
- Parcels out of view fade: weight a parcel's expected reward by the chance
  it still exists, which falls with the time since it was seen and the
  number of agents around. Without this, a parcel seen once stays a target
  until its value reaches zero, which is forever when parcels never decay.
- Skip a parcel we are bound to lose: drop the pickup option when another
  agent is closer to the parcel and is one step away or moving towards it.
- Start-up connects, feeds messages into beliefs, builds the plans with the
  chosen mover, and starts the loop.
- Every message announces a change. Sensing comes only when something
  changes, which may be rare enough; check in the live run, and re-score at
  most once per frame if it is not.

Tests show each switching rule on its own; a pickup stopped when its parcel
is taken or vanishes; a parcel unseen for long ranked below a fresh one
of equal value and dropped once its chance is low; a pickup dropped when a
closer agent heads for the parcel, and kept when it heads away; an
intention running the right plan, failing when none fits or the plan
crashes; a running plan noticing it was stopped.

- [ ] Tests written and seen to fail
- [ ] Intentions and loop written; suite and type check pass
- [ ] Start-up file written; observation script removed
- [ ] Live run: within two minutes the agent picks up and delivers on its
  own and switches when a clearly better parcel appears. Note the score
  after five minutes.
- [ ] Network off and on: the agent reconnects and carries on
- [ ] Committed

---

## Phase 4: External planner

Design section 5. Completes Part 1.

**Task 8: PDDL mover**

Files: `src/planning/pddl/domain.pddl`, `problem.js`, `solve.js`, changes to
movement and start-up, and the tests.

- Domain: movement only, one move action per direction, named "default".
- Problem from beliefs: one object per walkable tile, a connection for each
  possible step (leaving out occupied and forbidden tiles), start and goal.
- The answer becomes moves. No plan, an error or no answer within five
  seconds means "no route"; the solver is not asked when already there.
- The mover keeps its plan between steps and asks again only after a failed
  move or a new target. With no route it logs it and falls back to A\*.
- A setting in `.env` chooses A\* (default) or PDDL.

Tests use a fake solver and show: valid tile names; the problem's tiles,
connections, start and goal; occupied and forbidden tiles left out; answers
turned into moves; no call when already there; no route on no plan, error
or timeout; the agent still arriving with A\* when the solver fails.

- [ ] Solver reachable and fast enough from our network
- [ ] Domain written
- [ ] Tests written and seen to fail
- [ ] Problem, solver call and mover written; suite and type check pass
- [ ] Live run with PDDL; note the score after five minutes
- [ ] Committed

---

## Phase 5: Instructions in the BDI agent

Design section 6. **First** settle the open questions at the end of that
section and update the design, requirements and this plan.

**Task 9: Goals and constraints**

Files: `src/llm/directives.js`, `src/beliefs/directives.js`, changes to
beliefs, options and the loop, and the tests.

- Goals: go to a tile, pick up a parcel, deliver now, pause, resume.
  Constraints: avoid an area, stay in an area, minimum parcel value,
  maximum carried, clear all.
- Reject, with a reason, anything unknown, off the map, at a wall, naming
  an unknown parcel, or with a meaningless value.
- Constraints shape routes and options; pause means no options; clear
  resets everything.
- The oldest waiting goal becomes an option above all of the agent's own.
  Unreachable goals, or deliver now with nothing carried, fail with a
  reason.
- Goals are waiting, in progress, done or failed, and every change is
  announced. A stopped goal goes back to waiting.
- With no instructions, nothing changes.

- [ ] Part 2 questions settled; documents updated
- [ ] Tests written and seen to fail
- [ ] Goals and constraints written; suite and type check pass
- [ ] Live run: a hand-written pause and resume stop and restart the agent
- [ ] Committed

---


Design section 6. Completes Part 2.

**Task 10: The LLM agent, with a fake LLM** (`src/llm/agent.js`)

- One tool for the LLM: a list of instructions plus a reply.
- The prompt: the LLM's role, each instruction type with an example,
  direction rules, map size, the agent's position and load, known parcels
  and delivery tiles, active instructions.
- Keep the last ten messages.
- If any instruction is invalid apply none and explain; otherwise apply all
  and pass on the reply.
- If the LLM is unreachable, skips the tool or sends something malformed,
  say so and change nothing.

**Likely files:** `src/llm/providers/ollama.js`, `src/llm/providers/course.js`, `src/llm/provider.js`, `test/llm-provider.test.js`, `.env.example`.

- [x] Define an injectable `chat` provider contract and add request cancellation, timeout, structured response validation and HTTP error handling.
- [x] Implement the HTTP Ollama adapter without new npm dependencies; default local development configuration: `LLM_PROVIDER=ollama`, `OLLAMA_BASE_URL=http://127.0.0.1:11434`, `OLLAMA_MODEL=qwen3.5:4b-q4_K_M`.
- [ ] **User local acceptance:** run `npm run llm:smoke` on the installed Qwen model and record true native tool-call behavior; compare `npm run llm:smoke:json` if needed. JSON fallback is implemented and verified using fake-model tests.
- [x] Keep the provider contract injectable; do not implement an ungrounded course-specific HTTP/auth adapter before official specifications exist.
- [x] Keep the Stage 2A demo free of secrets and game credentials; `.env.example` contains only localhost settings.

**Stage 2A status:** provider code, fake-model and fake-HTTP tests passed; **real local Qwen smoke passed on the user's Mac**. The independent game agent is now implemented in Stage 2B, pending live verification.

### Task 10 — Tools and dynamic LLM memory

**Likely files:** `src/llm/memory.js`, `src/llm/tools/catalog.js`, `src/llm/tools/execute.js`, `test/llm-memory.test.js`, `test/llm-tools.test.js`.

- [x] Implement bounded memory with objective/version, expiring JSON observations (can carry teammate state later), current plan and recent tool outcomes; actual game observation normalization remains for Stage 2B.
- [x] Implement deterministic **non-game demo tools** and strict tool catalog; game SDK-backed tools and official tool-service adapter remain for Stage 2B/2D.
- [x] Validate tool allowlist and argument schema before execution, with cancellation, deadlines, errors and unknown-outcome reporting. Game-specific state preconditions remain for SDK tools in Stage 2B.
- [x] Bound memory events and observation age; clear prior tool history/plan when objectives are replaced.
- [x] Add memory, objective replacement, invalid tool, expired observation and result feedback regression tests. Teammate belief conflicts will be covered with coordination in Stage 2C.

**Stage 2A status:** standalone memory and safe demo tool execution passed. Stage 2B adds game/state preconditions. The course tool catalog remains a separate integration requirement.

### Task 11 — LLM planning, execution and replanning loop

**Likely files:** `src/llm/agent.js`, `src/llm/planner.js`, `src/llm/executor.js`, `test/llm-agent.test.js`.

- [x] Accept objective strings via an injectable loop input (hardcoded demo objective for smoke). Real CLI/official objective-event input adapter is Stage 2B/2D.
- [x] Implement bounded **objective -> memory -> validated structured plan -> model tool call/JSON action -> validate -> execute demo tool -> update memory -> replan/finish**.
- [x] Support cancellable objective replacement, and optional completion verifier; never report an unverified model claim as externally completed.
- [x] Feed tool failure and refreshed observation into subsequent tool decisions. Game obstacle, parcel and teammate events will be wired in Stage 2B/2C; no per-frame LLM calls.
- [x] Stage 2B reuses the existing movement/plan helpers as validated high-level LLM game tools; the original Stage 2A demo remains game-free.
- [x] Add fake-LLM and fake-HTTP tests covering tool invocation, invalid plan/tool calls, revised feedback, objective replacement, loop limits, and completion verification.

**Stage 2A status:** simulated model executes a validated multi-turn tool workflow; real Qwen smoke passed on the Mac; Stage 2B live-game acceptance remains open.

### Task 12 — Second autonomous game identity and integration

**Reuse:** `src/config.js`, `src/client.js`, `src/beliefs/`, `src/plans/`, Task 11 LLM loop.

**Likely files:** `src/llm-agent.js`, `src/runtime/agent-context.js` (if useful), package scripts and `.env.example`.

- [x] Implement an LLM runner using a **separate game identity** with its own token/config, SDK connection, beliefs and action runner (e.g. `AGENT=milktea`).
- [x] Preserve the BDI agent as its own autonomous process/identity (e.g. `AGENT=bubble`).
- [x] Share pure utility code; never share mutable beliefs or a single SDK socket between distinct players.
- [x] Demonstrate with a **simulated SDK/game** that LLM plans trigger real movement/pickup/delivery modules and grounded completion.
- [ ] Repeat the independent objective on the real local Deliveroo.js + Qwen server (Mac acceptance).
- [x] Add stage 2B tool, state, objective, runtime and readiness regression tests.
- [ ] Demonstrate **both identities concurrently** on the game server (Stage 2C entry gate).

**Done when:** both agents can run concurrently in the same game without controlling the same player.

### Task 13 — Communication and task coordination

**Likely files:** `src/coordination/protocol.js`, `src/coordination/messenger.js`, `src/coordination/claims.js`, `test/coordination.test.js`; small `src/client.js` additions.

- [ ] Extend the SDK wrapper with **official in-game messaging**; verify receive-event signatures against the installed SDK.
- [ ] Exchange relevant BELIEF, INTENTION, CLAIM, RELEASE and completion/failure messages using a small validated protocol.
- [ ] Give each message identity, version/sequence and freshness information; reject stale/malformed/duplicate messages.
- [ ] Start with parcel claims and deterministic conflict resolution; expire claims when teammates disconnect or cease reporting.
- [ ] Feed received beliefs into each agent's belief revision without blindly treating them as certain observations.
- [ ] Test simultaneous claims, message delay/duplicates, release, timeout, teammate unavailability, and two-agent division of work.

**Done when:** logs and game behavior show that two autonomous agents exchange beliefs/intentions and coordinate real tasks rather than merely sending chat messages.

### Task 14 — Real course LLM/tools/objective integration

**Likely files:** adapters under `src/llm/providers/`, `src/llm/tools/`, `src/llm/objectives/`.

- [ ] Obtain/verify the course-provided LLM API and tool-catalog specifications, credentials, and objective input channel.
- [ ] Connect the LLM-agent adapter to the actual server-side tool catalog; validate that tool discovery and execution work end to end.
- [ ] Support the actual natural-language objective delivery method (e.g., the relevant game/course messages), not just a local console.
- [ ] Exercise changing/replaced objectives and execution-time replanning with the real services.
- [ ] Keep local Ollama mode operational for reproducible development, and record exactly which provider/tool endpoint the final demo uses.

**Done when:** the LLM agent works with the infrastructure used for course evaluation, or an unresolved external dependency is recorded explicitly and tested as far as access permits.

### Gate B — Part 2 completion

- [ ] Part 1 remains operational after adding Part 2.
- [ ] Two separate agents are connected and act concurrently.
- [ ] LLM memory changes with objectives and observations.
- [ ] Real LLM planning, tool execution and replanning are demonstrated.
- [ ] Agents exchange beliefs/intention information and avoid duplicate assignments.
- [ ] Course tool catalog and evaluation objective channel have been exercised when available.
- [ ] Run and record available Challenge 2 / predefined simulation scenarios.

**Only after Gate B:** optimize tournament performance.

---

## Phase C — Benchmarks and policy comparison

### Task 15 — Reproducible evaluation harness

**Likely files:** `src/metrics/`, `scripts/benchmarks/`, `docs/results.md`.

- [ ] Add structured event logs and a run manifest: scenario/map/configuration, provider/model, utility/revision/coordination policies, seed if exposed, and run duration.
- [ ] Measure score, delivered parcels, failed actions, path length, decision and intention counts, PDDL calls/success/latency/fallbacks, LLM calls/latency/invalid actions, shared-claim conflicts and objective success.
- [ ] Write scripts to run a matrix of configurations on comparable scenarios without embedding private credentials.
- [ ] Establish **baseline results before changing any policy**; report multiple trials plus variability when possible.

**Done when:** running the same experimental setup yields comparable machine-readable results and a human-readable summary.

### Task 16 — Utility and intention-policy alternatives

- [ ] Introduce a policy selector with a stable input/output contract; keep the existing `expectedReward` behavior as the named baseline.
- [ ] Implement a **marginal pickup gain** policy: compare pickup-detour reward against deliver-now reward.
- [ ] Optionally implement reward-per-time and uncertainty-aware policies after the marginal policy is benchmarked.
- [ ] Parameterize intention switching and compare baseline `1.2` with other margins using the same scenarios.
- [ ] Ensure policies do not double-count carried rewards, violate capacity semantics, or bypass intention-revision safety rules.
- [ ] Preserve baseline mode and document results, not just a preferred winner.

### Task 17 — Exploration and coordination alternatives

- [ ] Benchmark the current least-recently-seen exploration against a distance-aware or spawn-aware policy.
- [ ] Compare independent-agent behavior (where meaningful) against the baseline claim/release coordination.
- [ ] If baseline data justifies it, test nearest-agent task assignment or role specialization.
- [ ] Select a final policy using measured objective completion, score, reliability and latency; retain fallback behavior.

### Task 18 — Final validation and delivery

- [ ] Run full unit/integration/typecheck suite and a fresh live two-agent demonstration.
- [ ] Verify startup instructions, `.env.example`, required npm scripts, supported modes, external services and clear error messages.
- [ ] Update `README.md` with actual setup, two-agent launch, PDDL and Ollama/course-provider options, and verified limitations.
- [ ] Produce the final report (maximum 10 pages) covering architecture, BDI and LLM reasoning, planning, revision, coordination, controlled comparisons, results and limitations.
- [ ] Prepare a repeatable oral demonstration and submit by the instructor-announced deadline.

---

## Requirement coverage

| Requirement | Main tasks/gate |
|---|---|
| P1-01 Beliefs and revision | Existing beliefs + Task 5a + Gate A |
| P1-02 Intentions and revision | Task 7 + Gate A |
| P1-03 Predefined plans | Task 6 + Gate A |
| P1-04 External automated planner | Task 8 + Gate A |
| P1-05 Plan execution/replanning | Tasks 6–8 + Gate A |
| P1-06 Challenge 1 | Gate A |
| P2-01 Second game agent | Task 12 + Gate B |
| P2-02 Interpret objectives | Tasks 9, 11, 14 + Gate B |
| P2-03 Dynamic memory | Task 10 + Gate B |
| P2-04 Tool planning and replanning | Tasks 10–11, 14 + Gate B |
| P2-05 Course tool catalog | Tasks 10, 14 + Gate B |
| P2-06 Belief/intention coordination | Task 13 + Gate B |
| P2-07 Challenge 2 | Gate B |
| Submission and measured improvement | Tasks 15–18 |

## Next coding-agent task

Next, run **`docs/stage2b_local_testing.md`** on the Mac. Verify separate `milktea` identity, native Qwen tool calls, real SDK pickup and delivery, and score/parcel evidence. Preserve logs without tokens. Then start Stage 2C coordination; do not refactor the BDI algorithms just to add the LLM.


## Stage 2C — cooperative multi-agent extension (implemented; live test pending)

- Added SDK message adapter, versioned protocol, peer discovery, bounded messages, peer identity/name checks, de-duplication and freshness validation.
- Both agents broadcast current intentions and direct parcel observations; received parcels are incorporated only when newer than their local direct observations, preserving decay ages.
- Short-lived claims with renewal/release, path cost arbitration, incumbent preference, bounded conflict settlement, and an LLM tool guard prevent most duplicate pursuits.
- BDI `BdiAgent` respects contested parcels during option selection and can cancel an intention when it loses a claim. LLM `collect_and_deliver` / `pickup_parcels` claim before executing.
- `COORDINATION_ENABLED=false` by default; independent A* and PDDL baselines are unchanged.
- Added unit and fake-SDK two-agent integration tests and `npm run summarize:coop`.
- **Pending:** real two-player Deliveroo.js + Ollama run on the user's Mac; objective and communication logs; multiple matched-run score comparisons; unpublished course service integrations.

See `docs/stage2c_local_testing.md` and `docs/stage2c_test_report.md`.

## Stage 2C.1 — Reliability patch

Status: **implemented in this package and passing automated local tests; live Mac verification pending**.

1. Distinguish static impossibility from agent occupancy and wait a bounded interval for congestion to clear; preserve one-way map semantics and PDDL support.
2. Provide LLM-visible delivery-time feasibility estimates, conservative parcel reward decay predictions, and target cooldowns.
3. Log recovery outcomes and separate malformed tool calls from real failed game actions.
4. Reduce unnecessary coordination broadcasts while retaining claim/lease correctness.
5. Verify via 175 regression tests and strict typechecking, then run matched real-game scenarios using the Mac guide.

**Constraints unchanged:** no new professor-provided API assumed, BDI and LLM roles stay distinct, and Stage 2C communication is still optional for controlled comparisons. See `docs/stage2c1_local_testing.md`.

## Stage 2C.2 — Execution-time parcel selection patch

Status: **implemented, deterministic regression tests passed; live Mac verification pending**.

- Keep Stage 2C.1 BDI, PDDL, navigation and coordination unchanged.
- Add `collect_best_and_deliver` to the LLM tool catalog for high-level strategy selection and just-in-time parcel choice using fresh game beliefs.
- Preserve separate exact-ID calls for objectives naming a particular parcel.
- Bound exploration and retry *only* precondition-rejected targets, never uncertain or post-dispatch SDK actions.
- Expose observation freshness and structured alternatives; label precondition rejection separately in metrics.
- Measure delivered parcels per LLM call, precondition rejection count, and verified objective completion against Stage 2C.1 in repeated comparable live runs.
- Course-hosted API, exact official tools and objective interface remain pending instructors' release; do not infer compliance with unspecified contracts.

See `docs/stage2c2_local_testing.md` and `docs/stage2c2_test_report.md`.
