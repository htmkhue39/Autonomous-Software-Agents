# Stage 3C.3 — Balanced randomized ablation of delivery-tile evacuation

## Why this exists

Our previous five-run, sequential C0/C1 experiment suggested a sizeable score gain from moving `milktea` off delivery tiles after confirmed putdown. The result was promising but vulnerable to uncontrolled game randomness, run-order bias, and machine load. This stage adds an **automated balanced randomized ablation** without modifying the Stage 3C.2 BDI, LLM, A*/PDDL, or coordination algorithms.

## Install

Apply `Stage3C3.patch` to the **exact Stage 3C.2 project**, or extract the complete Stage 3C.3 ZIP. Always check the Git patch first:

```bash
git status --short
git apply --check ~/Downloads/Stage3C3.patch
git apply ~/Downloads/Stage3C3.patch
npm ci
npm test
npm run typecheck
```

Do not commit your `.env`, access tokens, raw benchmark logs, or generated experiment output.

## First smoke test (2 trials, 45 s each)

Stop any manually started Deliveroo.js server. Keep Ollama running. Run from the agent project root:

```bash
caffeinate -i npm run benchmark:ablation -- \
  --server-dir "/Users/ntvan/Documents/sem 1/Agent/Deliveroo.js" \
  --runs 1 \
  --duration 45 \
  --mover astar \
  --schedule-seed 42
```

For this smoke test, the runner will execute **one C0 and one C1**, automatically restarting the game server each time and forcing `LLM_DELIVERY_EVACUATION=false` or `true` in the respective agent subprocess. It does **not** depend on any `LLM_DELIVERY_EVACUATION` value in your `.env`: the command overrides that variable for each trial. The *actual* setting is independently verified from `llm_game_startup` events. Both trials must show `valid=true` and correctly matched settings. A 45-second run does not need to contain an evacuation event.

The runner prints the new result directory, for example:

```text
ablation-results/2026-11-12T22-00-00-000Z/
  manifest.json                  # randomized order, sanitized settings, revisions
  rounds.csv                     # original per-trial benchmark columns
  ablation-results.csv           # per-trial columns plus condition/block/order seed
  aggregate.json                 # conventional cooperative-mode aggregate (all runs)
  comparison.json                # authoritative C0 vs C1 statistics and metadata
  report.md                      # research-ready report and caveats
  score-distribution.svg         # image for report/presentation
  01_C0_trial1/ or 01_C1_trial1/
    server.log
    bubble.log
    milktea.log
    result.json
  02_.../
```

**Use `comparison.json` and `ablation-results.csv` for the C0/C1 contrast.** The legacy `aggregate.json` groups all `mode=C` trials together and is **not** a C0/C1 comparison. No official Tournament score is calculated.

## Main experiment — 10 trials per condition

Once smoke passes:

```bash
caffeinate -i npm run benchmark:ablation -- \
  --server-dir "/Users/ntvan/Documents/sem 1/Agent/Deliveroo.js" \
  --runs 10 \
  --duration 180 \
  --mover astar \
  --schedule-seed 20261112
```

This executes **20 trials**, each lasting three minutes: 10 C0 and 10 C1. Every two-trial block contains one control and one treatment. For an even number of blocks the runner also balances which condition runs first; order is shuffled reproducibly using the recorded `--schedule-seed`. The schedule seed controls **only trial order**. It is **not** supplied to the game or Ollama.

The new runner keeps the Stage 3A.1 integrity checks: agent readiness, timing tolerance, server TCP probe, verified last-observed score, premature exits and cleanup. A trial is also invalid if `milktea`'s effective evacuation setting is missing or disagrees with its assigned condition. Invalid rounds remain in all output files with explicit reasons, but are omitted from score inference. If a system failure interrupts the experiment, the runner preserves partial results; **do not silently substitute incomplete rounds**.

## Analysis details

`comparison.json` reports both conditions separately and uses an **unpaired Welch 95% confidence interval** for the C1 − C0 difference. It includes mean, median, standard deviation, score CI, effect size (Hedges g), a descriptive cross-sample probability of superiority, delivery throughput, individual agent scores, teammate congestion, model latency and evacuation outcomes. Missing observations remain missing; single-trial confidence intervals are `null`.

The Markdown report and SVG plot use **agent-observed score, not official Tournament score**. `llmDeliveryTileDwellMeanMs` is an *average of non-censored per-trial means*, not the population mean; right-censored observations are counted separately and cannot be treated as zero. Small samples, uncontrolled world randomness, non-deterministic LLM inference, and changes in CPU/GPU load constrain causal interpretation.

## What game seed control means here

The user's **local Deliveroo.js checkout was not available to the packaging environment**, so deterministic game-seed support has not been verified. Stage 3C.3 does **not** invent a `GAME_SEED`, change `Math.random`, or inject undocumented controls. `randomSeedControlled:false` is recorded explicitly. The trials are not identical-world matched pairs and statistics must therefore be unpaired; block ID signifies execution-order grouping, not a shared random world.

If deterministic game configuration becomes available and is verified on the local server version, it can be added as a separate future capability, tested for reproducibility at the server state level. Until then the experimental design controls run ordering rather than world RNG.

## Acceptance criteria

- Exactly 2×runs trials scheduled, with one C0 and one C1 in each block.
- Same map, mover, time budget and codebase in both conditions.
- Effective condition flag confirmed from actual agent startup telemetry.
- No early agent exit, large timing drift, or missing score unnoticed.
- `comparison.json`, `ablation-results.csv`, `report.md` and `score-distribution.svg` produced.
- Zero known duplicate SDK action retries; Stage 3C.2 safety behavior unchanged.
- Research results are reported with uncertainty and limitations, whether positive, negative or inconclusive.

## What to send for analysis

Share the `ablation-results.csv`, `comparison.json`, and `report.md` from the latest run. Keep raw logs locally for detailed investigations. Do not upload `.env` or access tokens.
