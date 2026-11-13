# Stage 2C.2.1 — Verification report

## Source and change scope

Baseline: `Autonomous-Software-Agents-Stage2C2.zip`. The code patch changes:

- `src/llm/game/tools.js`: distinguish **safe peer-won claim cancellation
  during navigation** from an unknown SDK action; do not add failed-target
  cooldown for the safe conflict. Existing dynamic bounded reselection handles it.
- `scripts/summarize-coop-run.js`: count the new `llm_coordination_safe_yield` event.
- Three tests in `test/stage2c2-yield.test.js`.
- README and this guide/report.

**Safety invariant:** No automatic retry when action status is unknown or an
SDK pickup/putdown might already have been dispatched. `PlanLibrary` marks
`StopSignal.finishing` before issuing such SDK actions; the safe branch requires
`status === 'cancelled'` and `!stop.finishing` and an explicit `onYield` signal
from a peer's winning claim. A plain cancellation or general timeout is NOT
mapped to a safe coordination conflict.

## Tests

- 193/193 Node tests passed (190 previous + 3 new).
- Strict `tsc -p jsconfig.json` typechecking passed using the installed dependencies.
- Three added scenarios: safe claim yield reselects a backup and delivers;
  ambiguous SDK pickup is not retried despite yield; unrelated cancellation
  remains uncertain.
- Live two-agent gameplay against macOS Deliveroo.js + Ollama: **not run here**.

## Live investigation to perform

Observe `llm_coordination_safe_yield`, `llm_dynamic_reselected`,
`llm_dynamic_delivered`, `coordination_yield`, and the final
`game_objective_result`. A zero in the safe-yield counter is not a regression
unless the two agents actually competed for the same parcel.
