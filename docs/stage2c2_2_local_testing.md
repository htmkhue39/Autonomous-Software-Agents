# Stage 2C.2.2 — macOS live verification

## What this release fixes

In Stage 2C.2.1, `milktea` reached `deliveredCount: 5` on an objective to
`Deliver 3 parcels` but returned `stalled/no_tool_calls`. Delivery evidence was
already recorded; the LLM loop was incorrectly waiting for a model-issued
`finish_objective` tool. In this version the game runtime automatically returns
`completed/verified` as soon as its deterministic criterion is satisfied, and
makes cumulative objective progress visible to Qwen.

## Install

1. Extract `Autonomous-Software-Agents-Stage2C2_2.zip` in a **new folder**.
2. Copy your **private** `.env` from Stage 2C.2.1 into that extracted project.
   Verify that `TOKEN_BUBBLE` and `TOKEN_MILKTEA` refer to **different players**.
   Do not publish tokens or `.env`.
3. Inside the new project directory run:

```bash
npm ci
npm test
npm run typecheck
```

Expected local suite: **200 tests** (the clean package has no `node_modules`).

## Start the real services

In the separate Deliveroo.js repository directory, run the game server:

```bash
GAME_NAME=oval_counterclockwise npm start
```

Log in as `admin-viewer` in `http://localhost:8080`. Do not click Play on the
`bubble` or `milktea` token rows in the viewer; launch both as Node.js agents.
Ensure the Ollama service is running and `qwen3.5:4b-q4_K_M` is installed.

## Run the two agents

**Terminal 1** — Stage 2C.2.2 project directory, BDI agent:

```bash
mkdir -p logs
HOST=http://localhost:8080 \
AGENT=bubble \
MOVER=astar \
COORDINATION_ENABLED=true \
npm start 2>&1 | tee logs/bubble-stage2c2_2.log
```

**Terminal 2** — same project directory, LLM agent:

```bash
mkdir -p logs
HOST=http://localhost:8080 \
AGENT=milktea \
MOVER=astar \
COORDINATION_ENABLED=true \
OLLAMA_MODEL=qwen3.5:4b-q4_K_M \
npm run start:llm -- \
--objective "Deliver 3 parcels" \
2>&1 | tee logs/milktea-stage2c2_2.log
```

The model has a bounded tool budget. The expected goal is **3 acknowledged
parcels delivered** (possibly via multiple delivery actions); it does **not**
require 3 separate delivery actions. Once the third parcel is confirmed, the
LLM should return without a further model request:

```text
"event":"llm_objective_auto_verified"
"event":"game_objective_result","status":"completed","reason":"verified"
"progress":{"deliveredCount":3 ...}
```

It may exceed 3 if one single confirmed delivery action drops multiple parcels.
The model may still fail to collect enough parcels within its bounded budget;
we do not guarantee success in every random run.

After `milktea` exits, stop `bubble` with Ctrl+C, then run:

```bash
npm run summarize:coop -- \
  logs/bubble-stage2c2_2.log \
  logs/milktea-stage2c2_2.log
```

Inspect goal verification directly:

```bash
grep -E '"event":"(llm_objective_auto_verified|game_objective_result|delivery)"' \
  logs/milktea-stage2c2_2.log
```

## Acceptance criteria

- `milktea` reports `completed/verified` after at least 3 confirmed parcels
  delivered, without relying on a model-issued `finish_objective`.
- Progress snapshots expose `target`, `current`, and `remaining` correctly.
- No false success when a parcel disappears or a tool only observes the game.
- Two-agent communication remains intact; the BDI agent can keep running.
- After successful live verification, preserve logs and record the saved
  tournament round result separately (last logged scores are not round scores).

## Limitations

Automated tests use simulated SDK interactions and model responses. This package
was not connected to your Mac's live Deliveroo.js and Ollama services here.
Official Challenge 2 tool-server/API/objective contracts are still unavailable;
the local goal parser is not a replacement for those specifications.
