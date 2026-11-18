# Stage 4C — Evidence-first local course readiness validation

**Baseline:** Stage 4A/4B (frozen Stage 3C.3 gameplay). This stage changes only the validation CLI, evidence rules, process helper exports, and documentation. BDI/LLM agent policies, PDDL problem/solver, SDK game actions, coordination, and evacuation are unchanged.

## What the test proves (and does not)

`npm run course:validate` controls **fresh local Deliveroo.js game servers** and independently spawned agents, watches machine-readable game events, and emits a pass/fail report with per-scenario evidence. The harness intentionally refuses to treat model summaries, an open TCP port, test mocks, or agent-reported scores as official course certification. It does **not** run the unknown professor Challenge 1/2 graders or official model/tool interfaces.

`npm run course:failure-tests` runs existing deterministic simulated fault/recovery and Stage 4B safety checks. They are **offline regression evidence**, not assertions of live game fault injection. Do not merge them into the live scenario pass count.

## Prerequisites

- macOS/Linux, Node and installed dependencies (`npm ci`). Your **private** `.env` must contain separate game-agent JWTs `TOKEN_BUBBLE` and `TOKEN_MILKTEA` (or approved locally supplied credentials). Never share these tokens.
- A working Deliveroo.js source checkout, with `npm start`, `GAME_NAME=oval_counterclockwise` and an **unused** `http://localhost:8080` before running. The runner starts/stops a fresh server per scenario; do **not** start it yourself.
- Ollama running, with the local model in your `.env` available. This validation deliberately sets `LLM_PROVIDER=ollama`, `LLM_MODE=json` and clears optional `COURSE_MCP_URL` for an unchanged local baseline. The official provider/catalog remain pending instructor documentation.
- For `bdi_pddl`, the external `@unitn-asa/pddl-client` online solver must be reachable. **Fallback to A* is not a pass.**

## Install and automated checks

```bash
npm ci
npm test
npm run typecheck
npm run course:audit
npm run course:smoke
npm run course:failure-tests
```

## First live test — BDI + external PDDL only

```bash
caffeinate -i npm run course:validate -- \
  --server-dir "/Users/ntvan/Documents/sem 1/Agent/Deliveroo.js" \
  --scenarios bdi_pddl \
  --duration 180
```

The runner must log `bdi_game_ready`, `intention_activated`, `pddl_call`, **`pddl_success`**, and `move`. If the PDDL service is down, `planner_fallback` is visible in the log but the scenario must **fail**, not claim an external planning pass.

## Full local validation (four fresh games)

```bash
caffeinate -i npm run course:validate -- \
  --server-dir "/Users/ntvan/Documents/sem 1/Agent/Deliveroo.js" \
  --scenarios bdi_pddl,llm_objective,cooperation,objective_replace \
  --duration 180
```

The `--duration` is a **maximum observation period per scenario**, not a fixed-length scoring benchmark. A scenario may finish early as soon as its evidence conditions are fulfilled, or fail after the timeout. Total duration depends on game conditions and LLM latency.

| Scenario | Actors | Required proof |
|---|---|---|
| `bdi_pddl` | BDI alone, external PDDL | Ready, intention activation, actual PDDL call and success, actual move |
| `llm_objective` | LLM alone | Game ready, model called, successful validated tool, confirmed delivery, game-evidence-verified goal completion |
| `cooperation` | Both agents, A* | Bidirectional SDK messages, merged belief, independent BDI intention and LLM action, LLM confirmed delivery, successful tile evacuation |
| `objective_replace` | Both agents, A* | `stdin` NDJSON first goal (100 parcels) started; first real tool result; queued second goal (1 parcel), safe cancellation, second goal started and completed based on a *new* confirmed delivery, no quarantine |

The dynamic goal fixture uses the **existing opt-in** `LLM_OBJECTIVE_SOURCE=stdin` inbox. If the first tool never finishes in the safe observation window, the runner must fail the scenario instead of claiming the first goal was actively replaced. An unresolved SDK/tool action causes quarantine rather than unsafe retries. Local objective updates do not prove compatibility with the instructor's eventual objective-delivery format.

## Output

```
course-validation-results/<timestamp>/
  manifest.json               # sanitized runtime, revisions, scenario selection
  report.md                   # pass/fail, missing evidence, limitations
  scenarios.csv               # all scenario checks, basic event counts
  bdi_pddl/
    server.log
    bubble.log
    result.json
  llm_objective/
    server.log
    milktea.log
    result.json
  cooperation/
    server.log
    bubble.log
    milktea.log
    result.json
  objective_replace/
    server.log
    bubble.log
    milktea.log
    result.json
```

The command exits **0 only if all requested scenarios pass**. Missing event evidence, early unexpected agent/server exit, interruption, or a failure to stop the server causes a failed scenario/nonzero exit. Every scenario uses a fresh server, including failures; raw logs are retained in each scenario directory.

**Important:** Per-scenario outputs and logs are ignored by Git. Review before sharing, since external runtime/tool logs may include private host details or identifiers. Do not commit `.env` or tokens. `git ls-files .env` should output nothing.

## Common diagnostic paths

- **`bdi_pddl` fails:** Inspect `bdi_pddl/bubble.log` for `pddl_call`, `pddl_failure` and `planner_fallback`. Network failure or unrecognized online solver output is **not** a local PDDL success.
- **`llm_objective` fails:** Inspect `milktea.log` for `llm_model_result`, `llm_tool_result`, `delivery` and `game_objective_result`. Missing confirmed deliveries must not be reported as completion.
- **`cooperation` fails:** Inspect the two agent logs for `coordination_sent`, `coordination_received`, `coordination_belief_merged` and `llm_delivery_evacuate_result`. Random worlds may not produce a delivery before the timeout.
- **`objective_replace` fails:** Check `course_objective_channel_ready`, `course_objective_started`, `course_objective_queued`, `course_objective_replacement_requested`, `course_objective_finished`, `course_objective_quarantined`; the second delivery must occur *after* the second goal starts.
- **Server port occupied:** Stop any previous Deliveroo server and re-run; never kill an unknown running process automatically.
- **Incomplete goal:** Increase `--duration 240` for a diagnostic rerun, but record the changed observation limit; no cherry-picking in reported success rates.

## Remaining official blockers

Official Challenge 1/2 scenarios/grader, externally provided LLM endpoint and auth, course tool-server contract, objective replacement transport and exact submission deadline are **not present in the supplied course slides**. Stage 4C does not claim these are validated.
