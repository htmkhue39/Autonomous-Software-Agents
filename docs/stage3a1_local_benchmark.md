# Stage 3A.1 — Reliable local benchmark (Mac)

Stage 3A.1 builds on frozen Stage 3A. **No BDI/LLM decision or coordination policy changes**. It adds strict validity rules, diagnostics, sanitized reproducibility metadata, unpaired uncertainty estimates, and retrospective auditing of old Stage 3A runs.

## What changed

- **Timing:** `actualDurationMs` is monotonic elapsed time; `actualWallDurationMs` is wall elapsed time. BOTH must be within `max(2,000 ms, 2% of requested duration)`, unless overridden by `--timing-tolerance-ms`. The B4 (~1,074 s) and C4 (~942 s) anomalies from the first dataset would be invalid. Overrun scores remain in raw results and are excluded from valid-only means.
- **Readiness:** record per-agent readiness delays and difference between ready timestamps; by default, if that difference exceeds **15,000 ms**, mark trial invalid (`readiness_skew_exceeded`). This is *monitoring*, **not** a synchronized start barrier. Moderate startup asymmetry may remain; do not assert strict paired equivalence.
- **Server health:** a 5-second **TCP reachability probe**, plus driver timer lag, measures server/runner responsiveness. TCP success does NOT prove game-protocol responsiveness. Probe failure invalidates the trial.
- **Timing telemetry:** `llm_model_result` records wall-clock model call latency, provider-reported duration, usage; `llm_tool_result` records execution latency and any timeout origin. `plan_phase` records navigation time; `sdk_action_phase` records action-gate pickup/putdown wait and outcome; `llm_dynamic_phase` records exploration and pickup/delivery pipeline time. These events do **not** log prompts, private game tokens or API keys. An SDK unknown outcome is still terminal and MUST NOT be retried automatically.
- **Reproducibility:** manifest records the agent/server Git commit when known, Node/platform, map, planner, JSON mode, allowlisted Ollama model, timing tolerances, and order. **Randomness remains uncontrolled**; no seed is injected because an official reproducible seed interface has not been verified. Fresh servers and rotated order mitigate but do not eliminate variability.
- **Statistics:** `aggregate.json` contains mean/median/sample SD/Student-t 95% CI of valid scores, validity rate, and invalid-reason counts. `comparisons.json` includes B vs C and A vs C unpaired Welch differences and intervals. With only a few uncontrolled trials, these are descriptive uncertainty estimates, **not causal proof** or Tournament results.

## Install or patch

Use the complete Stage3A1 ZIP or apply `Stage3A1.patch` onto your existing **Stage 3A** checkout. Preserve your private `.env` (it is never included in the ZIP).

```bash
# from Autonomous-Software-Agents directory
# patch only on a clean Stage 3A checkout
 git apply --check ~/Downloads/Stage3A1.patch
 git apply ~/Downloads/Stage3A1.patch
 npm ci
 npm test
 npm run typecheck
```

Keep a copy of the prior benchmark folders. Verify `.env` is gitignored. The patch deliberately does not modify your private `.env` or player tokens.

## First real smoke test

Stop any manually running game server. Keep Ollama available. The benchmark starts a fresh game-server instance per round.

```bash
caffeinate -i npm run benchmark -- \
  --server-dir "/Users/ntvan/Documents/sem 1/Agent/Deliveroo.js" \
  --runs 1 \
  --duration 45 \
  --modes A,B,C \
  --mover astar
```

Inspect the emitted path, then:

```bash
OUT="benchmark-results/<timestamp>"
npm run benchmark:summary -- "$OUT"
cat "$OUT/aggregate.json"
cat "$OUT/comparisons.json"
```

The runner creates `manifest.json`, `rounds.csv`, `aggregate.json`, `comparisons.json`, and per-round `result.json`, `server.log`, `bubble.log`, `milktea.log` as applicable. Main `rounds.csv` includes timing drift, readiness skew, and LLM latency columns; detailed tool and SDK latencies are in each `result.json` under `summary.agents`.

**Expected smoke result:** three rows, each close to 45 seconds; valid trials only if both agent readiness/observations and server monitoring pass. The 45-second smoke may legitimately deliver zero parcels.

If you see `readiness_skew_exceeded`, inspect the agent log startup latency and model cold start; don't simply increase the tolerance without documenting the changed rule. If `server_probe_failed`, inspect `server.log` and CPU load. If `duration_out_of_tolerance`, inspect actual mono/wall durations and timer lag; use `pmset` only to corroborate sleep events, not to infer them from Chrome assertions.

## Full experiments

```bash
caffeinate -i npm run benchmark -- \
  --server-dir "/Users/ntvan/Documents/sem 1/Agent/Deliveroo.js" \
  --runs 10 \
  --duration 180 \
  --modes A,B,C \
  --mover astar
```

This gives 30 rounds of 3 minutes. Note that `--runs 10` means 10 per mode, not total. The score is **last agent-observed, NOT official Tournament score**. The runner includes only valid trials in performance means, but keeps invalid trials in the manifest and reliability analysis. Five-round preliminary results are insufficient to establish reproducible effects.

### Review older Stage 3A results without editing them

```bash
npm run benchmark:summary -- \
 "benchmark-results/2026-11-12T15-25-58-503Z"
```

For Stage 3A manifests the summary applies a **read-only retrospective duration audit**; the original CSV/JSON remains untouched. The original 942s / 1074s rows are excluded from the audited display. Historical runs lack new readiness or latency instrumentation, so no such metrics will be invented.

## Interpretation boundaries

- A vs B includes the effect of an extra agent. **B vs C** is the relevant comparison for coordination, but without synchronized server RNG streams, it is not a matched-seed causal estimate.
- A model or SDK timeout is a reliability observation. Do not count a safely interrupted tool as a confirmed gameplay failure.
- TCP probe success means the socket was reachable, not necessarily that server game processing was healthy.
- The benchmarking code does **not** alter `collect_best_and_deliver` behavior; pipeline events simply measure its phases.
- A failed tool's `timeoutOrigin` can be `tool_registry_deadline`, `external_abort`, or unclassified. Check `sdk_action_phase` to distinguish action-gate uncertainty; neither event authorizes retrying a potentially dispatched SDK action.
- Manifest records only allowlisted configuration, never private player tokens. Inspect files before committing or sharing raw logs.
