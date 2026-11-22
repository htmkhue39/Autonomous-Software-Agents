# Stage 2C.2 — Verification report (2026-11-12)

## Baseline and scope

Base archive: `Autonomous-Software-Agents-Stage2C1.zip`, from the previous stage. Base regression test status: **175/175 passed** before modification. No files were borrowed from the official game server or unrelated repos.

The user supplied evidence that Stage 2C.1 completed 1 of 3 requested LLM deliveries and generated 9 rejected tool outcomes, eight for unavailable parcels and one predicted to expire. This package addresses the age between LLM inference and actual tool dispatch. It is a **targeted reliability patch**, not a performance-claim or course API implementation.

## Changes

- `src/llm/game/tools.js`: new allowlisted `collect_best_and_deliver` with two deterministic strategies, fresh-time targeting, safe bounded pre-dispatch reselection, optional one-trip exploration, explicit no-target result, improved precondition logs, and structured recent alternatives for exact-ID rejection.
- `src/llm/game/viability.js`, `src/beliefs/parcels.js`, `src/llm/game/observations.js`: observation source/age, separate freshness eligibility, prompts to prefer execution-time selection.
- `src/llm/agent.js`, `src/llm/tools/registry.js`: stronger model prompts, distinction between true game action failures and precondition rejections, retained legacy error code where required.
- `scripts/summarize-coop-run.js`: counts dynamic target selections, delivery results, exploration, reselection, and precondition rejection breakdown.
- `test/stage2c2.test.js`: 15 new tests; one existing allowlist expectation updated to include the new registered tool.
- Updated docs and launch instructions.

## Automated verification

- Full Node.js suite: **190 passed / 190 total / 0 failed**.
- Strict JavaScript typecheck using TypeScript 5.8.3: **passed**.
- `node --check` syntax verification on all source, test and script JavaScript files: **passed**.
- Existing BDI/PDDL, SDK movement, BDI+LLM coordination and Stage 2C.1 congestion tests are included in regression coverage.

New test coverage includes:

1. Parcel disappears after an old observation and is replaced by a new parcel before tool dispatch.
2. Choice of strategy affects selection (`nearest_viable` vs expected delivery reward).
3. Stale teammate reports cannot trigger immediate dynamic pickup.
4. Teammate claims are respected.
5. Simulated parcel disappearance *during claim settlement* causes safe reselection.
6. Failure after an SDK-side pickup attempt is **not** automatically retried.
7. Unknown SDK outcome is **not** automatically retried.
8. No target results in an explicit no-delivery outcome.
9. Optional bounded exploration without invented success.
10. Invalid strategy is rejected by the tool registry.
11. Legacy exact-ID error code and richer precondition metadata are preserved.
12. End-to-end simulated pickup/delivery through the real plan executor.
13. Exact-ID failure provides fresh alternative IDs.
14. Precondition rejection metrics are separated from game-action failures.
15. Parcel changes during mocked model inference are handled at execution time.

## Explicit limitations

- This container did not run the actual user's Mac Ollama model or a live game server. **No improvement in live delivery score or objective completion is claimed yet.**
- Freshness and feasibility are estimates based on partial observations; a candidate can still vanish during movement or be collected by a non-cooperating NPC.
- The new tool performs bounded deterministic selection/execution; strategic priorities remain with the model. The model is not forced to use the new tool.
- Official course LLM/tool service and Challenge 2 objective transport are still unspecified and unimplemented.

See `docs/stage2c2_local_testing.md` for reproducible macOS testing.
