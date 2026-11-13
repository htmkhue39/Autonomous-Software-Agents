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

**Reuse:** `src/deliberation/options.js`, `src/deliberation/utility.js`, `src/beliefs/index.js`, and Task 6 runner.

**Likely files:** `src/intentions/intention.js`, `src/intentions/revision.js`, `src/index.js`, `test/intentions.test.js`, `test/agent-loop.test.js`.

- [ ] Model intention states (`pending`, `running`, `completed`, `failed`, `cancelled`) and a cancellable plan lifecycle.
- [x] Implement the baseline rule in `design.md`: keep intention unless invalidated or a new option is clearly preferable; start with `replaceMargin = 1.2` and existing option priorities.
- [x] Invalidate pickup immediately when its target is confirmed gone/claimed by another agent or impossible; re-evaluate rather than walking to a dead target.
- [x] Avoid repeated external work on every sensing event: serialize the decision loop, debounce/coalesce redundant notifications when useful, and cancel superseded plans safely.
- [x] Create the missing `src/index.js` entry point; initialize config, SDK connection, beliefs and plan runner, then run until stopped.
- [x] Add initial agent-loop and intention tests; Stage 1.1 adds delivery commitment, exploration stability, hard invalidation, commitment interval and failed-goal cooldown regression tests. Additional corner cases can be added as encountered.
- [x] **Previous-build live smoke test:** BDI agent ran on local Deliveroo.js and delivered for score; fresh Stage 1.1 smoke test is pending.

**Done when:** `npm start` runs a stable autonomous BDI agent end-to-end, without manual commands. This is the **Part 1 predefined-plan baseline**, not yet the external-planning requirement.

### Task 8 — External PDDL planner called on intention activation

**Reuse:** existing `@unitn-asa/pddl-client` dependency, `src/planning/astar.js` for distance estimates/fallback, Task 6 plan executor.

**Likely files:** `src/planning/pddl/domain.pddl`, `problem.js`, `solve.js`, `test/pddl.test.js` and small orchestration changes to Task 7.

- [x] Build a valid PDDL domain/problem reflecting currently walkable tiles, start, goal and reachable moves (respecting relevant current constraints).
- [x] Integrate the **course PDDL client** with an actual external solver; team-provided local logs showed successful returned plans and executed moves.
- [x] Call the external planner on movement-plan initiation for newly activated intentions in compliant mode; log solver calls, outcomes, latency and fallback. A no-op at an already-reached target does not need a route.
- [x] Cache the resulting executable plan; replan when it becomes invalid, not on every movement frame.
- [x] Provide bounded timeout/error/empty-plan behavior. Fallback to A* when appropriate, but distinguish *solver succeeded* from *fallback succeeded* in logs/tests.
- [x] Preserve an A*-based baseline mode for experiments; ensure the compliant mode invokes PDDL regardless of the option kind when movement planning is needed (e.g. already-at-goal can be explicitly treated as a no-op).
- [x] Tests cover PDDL domain/problem, planner invocation, valid/invalid result, timeout, fallback and executing returned moves; further live route-replanning edge cases remain possible.
- [x] **Previous-build live smoke test:** real remote solver `pddl_success` and planned movement followed by a parcel delivery observed in team logs; rerun with Stage 1.1 before closing stability gate.

**Done when:** Part 1's required automated-planning behavior is demonstrated, not merely mocked or simulated through A*.

### Stage 1 delivery status (previous build verified live; Stage 1.1 local check pending)

- [x] `src/index.js` starts the autonomous BDI controller and prints structured JSON lines.
- [x] Predefined pickup/deliver/explore plans and abortable movement tested in a deterministic fake-client harness.
- [x] Unlimited capacity, moving-agent occupancy, and directional arrow handling regression-tested.
- [x] `@unitn-asa/pddl-client` adapter, PDDL generation/validation, solver timeout and logged fallback implemented and tested with an injected solver.
- [x] 103 unit and fake-client tests pass after Stage 1.1; `tsc -p jsconfig.json` passes with Node typings available.
- [x] Previous build verified with actual local Deliveroo.js server, pickup/delivery, and observed score increases. Stage 1.1 changes still require a fresh run.
- [x] Previous build logged genuine `pddl_success` against a live external solver and executed moves; retest the updated code. A `planner_fallback` alone does not prove PDDL success.
- [ ] Verify the installed SDK version against the local server, including transitional move acknowledgements and plugin map behavior.

See the root README's **Stage 1 local manual verification** instructions. The Stage 1 work is delivered as a testable candidate, **not yet a certified Challenge 1 run**.

### Gate A — Part 1 completion

- [ ] All existing and new unit tests pass; typecheck passes.
- [x] Previous-build agent played autonomously and scored through the SDK and predefined plans.
- [x] Belief revision and intention revision are observable in logs/tests; Stage 1.1 refines revision correctness.
- [x] Previous build invoked the real external solver and executed returned PDDL moves.
- [ ] Run the **current Stage 1.1** A*/PDDL smoke tests and verify improved pickup/goal recovery behavior.
- [ ] Record the available Challenge 1 / course-simulation scenarios when instructor setup is provided.

**Do not start performance optimization before the Stage 1.1 live stability gate passes.**

---


## Stage 1.1 — Runtime stability update (complete in code, local re-test pending)

**Scope:** Stabilize the existing BDI implementation; do not change the utility equation, PDDL domain, or Part 2 architecture.

- [x] **Pickup acknowledgment:** `src/plans/library.js` records `pickup_ack` response shape/IDs, updates beliefs for all acknowledged parcels, and confirms the target using ACK or a bounded positive sensing update. Other collected parcels are not discarded when the target is missed. A genuinely unconfirmed pickup remains failed.
- [x] **Intention commitment:** `src/intentions/agent.js` avoids invalidating applicable delivery/exploration plans merely because other options re-rank. Deliveries stay committed; ordinary pickup switching has a minimum commitment interval. Future explicitly higher-priority goals may preempt.
- [x] **Failed-goal cooldown:** failed/unknown goals are temporarily excluded from selection. The cooldown expires; no permanent target blacklist is introduced.
- [x] **Navigation diagnostics:** `src/plans/moveTo.js` logs attempted edges and tile types on refusals, impossible destinations, and cancelled navigation progress. Serialized action handling and explicit PDDL→A* fallbacks remain.
- [x] **Instrumentation:** `npm run summarize -- logs/example.log` counts key decisions, actions, failures and successful PDDL latency; game server frontend is unchanged.
- [x] **Regression tests:** new Stage 1.1 tests for pickup ACK/sensing, false positives, carried-other-parcel preservation, delivery/ exploration stability, soft switching, failed-goal cooldown, hard invalidation, and navigation diagnostics.
- [x] **Automated gate:** 105/105 tests and strict typecheck pass in the delivery working copy.
- [x] **Local functional gate (team):** A* and real external PDDL have both been demonstrated on `oval_counterclockwise`. A* log: 35 pickups, 13 delivery events, 1 refused move, last logged score 431. PDDL log: 32 successful solver plans, 3 fallbacks, 6 delivery events, last logged score 47; mean successful solver latency 3325 ms. Scores are last observed, **not verified saved timed-round results**. Separate repeated benchmarking remains open.

The previous build's real-game logs, including its successful external solver run and known failures, are summarized in `docs/stage1_test_report.md`. **Team-provided live logs now demonstrate Stage 1.1 autonomous gameplay and real external planning.** These runs do not establish tournament performance rankings or all level/plugin compatibility.

## Phase B — Add the second LLM-based agent (Part 2)

### Task 9 — LLM provider abstraction and local Ollama smoke test

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
