# Stage 2C.1 — macOS installation and live testing

Stage 2C.1 is a **reliability patch** based on Stage 2C. Keep the earlier version available as a benchmark. **The code passed local simulation tests but has not been tested against your Mac's Deliveroo.js server or your Qwen instance.**

## 1. Prepare

1. Extract `Autonomous-Software-Agents-Stage2C1.zip` to a **new directory**.
2. Copy `.env` from your private Stage 2C installation into the new project directory. Never upload it, screenshots of tokens, or JWT values.
3. From the extracted `Autonomous-Software-Agents` directory:

```bash
npm ci
npm test
npm run typecheck
```

Expected in our tested source: **175 passing tests**, zero failures, strict typecheck with no diagnostics.

Keep the official Deliveroo.js server running on `http://localhost:8080`, preferably with a fixed `GAME_NAME=oval_counterclockwise`. Keep Ollama running and verify `ollama list` shows `qwen3.5:4b-q4_K_M`. Use the admin-viewer browser session, not the browser's `milktea` Play button, to watch the agents.

## 2. Launch the two players in separate terminals

**Terminal 1 — BDI `bubble`:**

```bash
mkdir -p logs
HOST=http://localhost:8080 AGENT=bubble MOVER=astar \
COORDINATION_ENABLED=true \
NAV_CONGESTION_TIMEOUT_MS=3500 NAV_CONGESTION_RETRY_MS=180 \
npm start 2>&1 | tee logs/bubble-stage2c1.log
```

**Terminal 2 — LLM `milktea`:**

```bash
mkdir -p logs
HOST=http://localhost:8080 AGENT=milktea MOVER=astar \
COORDINATION_ENABLED=true OLLAMA_MODEL=qwen3.5:4b-q4_K_M \
NAV_CONGESTION_TIMEOUT_MS=3500 NAV_CONGESTION_RETRY_MS=180 \
npm run start:llm -- --objective "Deliver 3 parcels" \
2>&1 | tee logs/milktea-stage2c1.log
```

`milktea` may stop when it completes or exhausts its bounded objective. Stop `bubble` with Ctrl+C after capturing a comparable run. Keep tokens separate: `TOKEN_BUBBLE` and `TOKEN_MILKTEA`.

## 3. Summarize

```bash
npm run summarize:coop -- logs/bubble-stage2c1.log logs/milktea-stage2c1.log
```

Inspect Stage 2C.1 recovery events:

```bash
grep -E '"event":"(navigation_wait|navigation_recovered|navigation_failed|llm_parcel_rejected|llm_target_cooldown|llm_inventory_reconciled)"' logs/*-stage2c1.log
```

Look for `game_objective_result`, `pickup`, `delivery`, and `coordination_received`. A `navigation_wait` may not appear if no route is actually congested; no yields may occur unless two agents want the same parcel. Message volume should usually be lower for STATUS/BELIEF than Stage 2C, but do not compare absolute counts between runs of different durations.

## 4. Suggested verification scenarios

- **Solo baseline:** run only `bubble` with `COORDINATION_ENABLED=false` on `oval_counterclockwise`.
- **Independent pair:** run both processes with `COORDINATION_ENABLED=false`.
- **Cooperative pair:** run both with `COORDINATION_ENABLED=true`; check bids/claims, exchange, and delivery.
- **Congestion:** introduce a player/NPC near a narrow delivery lane and check that a blocked agent waits then recovers or times out within the configured deadline; do not assume all blocked routes can recover.
- **Parcel expiry:** allow known parcels to age and check that the ranked `get_known_parcels` output marks low-value candidates `viable:false`, and that the LLM explores or picks a better target.
- **PDDL regression:** set `MOVER=pddl` on `bubble` for a separate run and verify `pddl_call`, `pddl_success`, and delivery events; an active agent block can delay solver invocation until a route clears.

For a fair performance claim, repeat runs with the **same map, duration, server settings, NPC count, and both agent identities**. Record official saved Tournament scores separately; the summary script does **not** compute tournament scores.

## 5. Troubleshooting

- `no_tool_calls`, `limit_reached`: inspect the latest `llm_tool_result`, `llm_parcel_rejected`, and `llm_target_cooldown` events before increasing LLM steps. LLM calls may still be slow.
- `game_action_failed` with a vanished parcel: normal on a decaying map; the next observation should indicate cooldown or a nonviable target.
- `navigation_failed` with `failureKind=static`: the map's current wall/one-way layout offers no path. Choose a different destination.
- `navigation_failed` with `failureKind=congestion`: another agent held a path longer than `NAV_CONGESTION_TIMEOUT_MS`; inspect the `blockers` array and consider a longer bounded wait if needed.
- `nothing carried` / `Nothing dropped at delivery`: may be parcel expiry during transit; check the `llm_inventory_reconciled` event and subsequent action.
- `coordination_received` is zero: ensure both terminals set `COORDINATION_ENABLED=true`, use different valid tokens, and are connected to the same game server.

## 6. Limits and scope

This patch preserves Stage 1's BDI + A*/external PDDL, Stage 2A's model/tool foundation, Stage 2B's game actions, and Stage 2C's JSON message protocol. It does **not** add professor-provided LLM APIs, guarantee a tournament score, eliminate parcel expiry, or prove cooperation outperforms independent agents. Those claims require further live evaluation.
