# Stage 3C.2 — Cooperative delivery-lane evacuation

## Purpose and exact scope

The frozen Stage 3A.1 benchmark showed low-scoring cooperative rounds in which `milktea` occupied delivery tile `(6,13)` while `bubble` repeatedly logged `Agent occupying static route` and `Congestion timeout`. This release implements **Layer 1: automatic evacuation after verified LLM putdown**. It does **not** implement a new reactive traffic-negotiation protocol or alter BDI target-selection, A*, PDDL, parcel-selection prompts, claim arbitration, or SDK uncertainty handling.

When `milktea` confirms a delivery, it deterministically selects a reachable non-delivery staging tile within seven movement steps. It excludes occupied and temporarily blocked tiles and obeys one-way map rules. It prefers ordinary tiles away from all delivery tiles, noncritical side pockets, and avoids candidates that would disconnect delivery access where alternatives exist. It executes `goto` through the pre-existing PlanLibrary, MovementRunner and ActionGate. This occurs **before the next LLM inference**, preventing delivery-tile occupancy during model thinking.

The feature defaults **on when `COORDINATION_ENABLED=true`**, off for independent B mode. Explicitly override either with `LLM_DELIVERY_EVACUATION=true` or `false`. To keep the B-vs-C experiment interpretable, **leave this variable unset** in your `.env` for ordinary Stage 3C.2 benchmarking. Compare the cooperative condition on/off to measure this intervention directly. Startup logs and `rounds.csv` record the effective switch.

Safety: a confirmed putdown stays confirmed if parking is unavailable or navigation fails deterministically. An **unknown SDK move acknowledgement remains `outcome_unknown` and is never retried**. The high-level tool may therefore be blocked after it has already recorded a real delivery; count confirmed deliveries using `delivery` events, not only successful high-level tool responses. If the round ends just after putdown, evacuation can be skipped safely.

## Install from GitHub Stage 3A.1

1. Save a copy of your current GitHub checkout. Download `Stage3C2.patch` and put it in `~/Downloads`.
2. From your project directory, run:

```bash
 git status --short
 git apply --check ~/Downloads/Stage3C2.patch
 git apply ~/Downloads/Stage3C2.patch
 npm ci
 npm test
 npm run typecheck
```

Do not commit `.env`, tokens or benchmark raw logs. If the patch check fails because your checkout has diverged, use the complete Stage 3C.2 ZIP instead or reconcile the changes. The patch is constructed against the supplied clean Stage 3A.1 ZIP.

## First real Mac smoke test

Ensure Ollama is running. Stop manually launched Deliveroo.js processes; the benchmark starts a fresh game server per trial. In your project folder:

```bash
caffeinate -i npm run benchmark -- \
  --server-dir "/Users/ntvan/Documents/sem 1/Agent/Deliveroo.js" \
  --runs 1 \
  --duration 45 \
  --modes A,B,C \
  --mover astar
```

Expected: each trial marked `valid=true` (unless an actual system/game issue occurs). In `rounds.csv`, `llmDeliveryEvacuationEnabled` should be empty for A, `false` for B, `true` for C. Because the test is only 45 seconds, C might not complete a delivery; zero evacuation attempts in that case is expected.

If C delivers, look for these events in the relevant `milktea.log`:

```bash
OUT="benchmark-results/<timestamp-from-runner>"
grep -E '"event":"(delivery|llm_delivery_evacuate_selected|llm_delivery_evacuate_result)"' \
  "$OUT/03_C_trial1/milktea.log" | tail -n 30
```

Events:
- `llm_delivery_evacuate_selected`: starting tile, chosen unoccupied parking tile, path length and delivery separation.
- `llm_delivery_evacuate_result` with `status:"vacated"`: reached and confirmed destination.
- `status:"no_safe_target"`: all bounded candidate exits blocked/unreachable; no move sent.
- `status:"blocked"`: known navigation failure; confirmed delivery remains credited.
- `status:"uncertain"`: an unconfirmed move outcome; fail closed without further actions.
- `status:"interrupted"`: game deadline/abort before evacuation; no move dispatched.

## Ablation: does eviction help? (recommended after smoke test)

Do not change agent code between runs. Keep your local `.env` setting **unset** for `LLM_DELIVERY_EVACUATION`, except where explicitly testing it. Run two 5-round cooperative-only batches using the same 180-second duration and `caffeinate`:

```bash
# Control: Stage 3C.2 feature disabled (matches the old cooperative behavior)
LLM_DELIVERY_EVACUATION=false caffeinate -i npm run benchmark -- \
  --server-dir "/Users/ntvan/Documents/sem 1/Agent/Deliveroo.js" \
  --runs 5 --duration 180 --modes C --mover astar

# Treatment: Stage 3C.2 automatic evacuation enabled
LLM_DELIVERY_EVACUATION=true caffeinate -i npm run benchmark -- \
  --server-dir "/Users/ntvan/Documents/sem 1/Agent/Deliveroo.js" \
  --runs 5 --duration 180 --modes C --mover astar
```

Save both output directories and send `rounds.csv`, `aggregate.json`, plus one low-scoring C trial's `bubble.log` / `milktea.log` if problems recur.

Compare scores and deliveries as well as `bdiTeammateCongestionFailures`, `llmDeliveryEvacuationSuccesses`, `llmDeliveryTileDwellMeanMs`, and `llmDeliveryTileDwellCensored` in the new CSV. Each dwell observation measures elapsed time from the `delivery` event to the first logged move out of that tile; incomplete intervals are **right-censored** and not included in the mean. A low completed-dwell mean alone is not proof of success if many intervals remain censored.

Seeds are not controlled, and agent-observed scores are **not official Tournament scores**. Five rounds per treatment are a screening experiment, not proof of causality. Follow with more trials if the results are promising.

## Limits

- The change handles **post-confirmation delivery-tile occupancy**. It cannot move an LLM agent off a bottleneck before a delivery is confirmed, or move `bubble`/NPCs; reactive yielding is a possible separate Layer 2.
- No hard guarantee that all maps contain a safe nonblocking parking tile. Some corridors have no alternative.
- The no-target selection reports its reason; it does not force a move through an occupied tile.
- `llmDeliveryEvacuationEnabled` is from startup telemetry and is the authoritative per-round switch value. Do not assume that a copied `.env` matches the manifest.
