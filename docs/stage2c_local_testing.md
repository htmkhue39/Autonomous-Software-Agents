# Stage 2C — cooperative BDI + LLM local testing (macOS)

## What changed

Start with the completed Stage 2B.1 source. Stage 2C adds `src/coordination/{protocol,controller}.js`, messaging methods in the SDK client adapter, shared parcel beliefs with freshness protection, BDI option/claim integration, and LLM game tools that consult teammate claims. `COORDINATION_ENABLED` is **false by default**. Standalone BDI and standalone LLM tests still run as before.

**This package passed automated tests and strict typecheck in a local fixture. Live two-agent SDK communications and game score still need verification on your Mac.** No course-hosted LLM token or tool catalog was available, so those remain independent work items.

## 1. Install and verify

Extract `Autonomous-Software-Agents-Stage2C.zip` to a new folder. Copy your existing **private** `.env` from Stage 2B.1 into that folder. Never share JWTs or commit `.env`.

```bash
cd Autonomous-Software-Agents
npm ci
npm test
npm run typecheck
```

The official **Deliveroo.js** server runs from its own folder:

```bash
cd /path/to/Deliveroo.js
GAME_NAME=oval_counterclockwise npm start
```

Open `http://localhost:8080` as `admin-viewer` (do not click Play for a human-controlled `bubble` or `milktea`). Run `ollama list` to check `qwen3.5:4b-q4_K_M` is available, and start `ollama serve` only if it is not already running.

Check that your private `.env` has separate player credentials:

```dotenv
TOKEN_BUBBLE=<your bubble player JWT>
TOKEN_MILKTEA=<your milktea player JWT>
OLLAMA_MODEL=qwen3.5:4b-q4_K_M
```

## 2. Run two agents in parallel

**Terminal A — BDI `bubble`** (inside the NEW Stage 2C codebase):

```bash
mkdir -p logs
HOST=http://localhost:8080 AGENT=bubble MOVER=astar COORDINATION_ENABLED=true \
  npm start 2>&1 | tee logs/bubble-stage2c.log
```

**Terminal B — LLM `milktea`** (in the same Stage 2C folder):

```bash
mkdir -p logs
HOST=http://localhost:8080 AGENT=milktea MOVER=astar COORDINATION_ENABLED=true \
  OLLAMA_MODEL=qwen3.5:4b-q4_K_M LLM_MAX_RUN_MS=300000 LLM_MAX_STEPS=45 LLM_MAX_TOOL_CALLS=60 \
  npm run start:llm -- --objective "Deliver 3 parcels" \
  2>&1 | tee logs/milktea-stage2c.log
```

The LLM may stop when its objective completes or reaches its bounded budget. `bubble` runs continuously until you press **Ctrl+C** in Terminal A. Both agents must use **separate player identities**; do not use your admin-viewer token as either agent.

**Terminal C — summarize after finishing both:**

```bash
npm run summarize:coop -- logs/bubble-stage2c.log logs/milktea-stage2c.log
npm run summarize -- logs/bubble-stage2c.log
npm run summarize:llm -- logs/milktea-stage2c.log
```

## 3. What to look for

1. `coordination_peer_discovered` and `coordination_received` in **both** logs: two-way real SDK message handling.
2. `coordination_belief_merged`: a parcel observed by one agent is adopted by the other only if not contradicted by more recent direct sensing. Shared parcels are estimates, not proof of current availability.
3. `coordination_claim_started` and `coordination_claim_released`: explicit intention commitments. Check that peer-claimed parcels are omitted by BDI deliberation and rejected by LLM `collect_and_deliver`/`pickup_parcels` where appropriate.
4. `coordination_yield` or `coordination_pickup_skipped` **if** the agents contend for the same parcel. These are conditional; a good run with no collisions may have zero yields.
5. `pickup`, `delivery`, and `game_objective_result` logs: actual gameplay, independent of verbal claims.
6. When stopping one agent unexpectedly, the other must continue within the expired claim lease (typically up to several seconds). No permanent deadlock.

Avoid assuming a game score from a `last observed` log line is an exact tournament score. Use the saved tournament panel for timed results.

## 4. Compare coordinated against independent agents

Repeat with the same game level and comparable timed round, but set `COORDINATION_ENABLED=false` in **both** terminals. Do not mix one enabled agent and one disabled agent when judging cooperation. Use multiple runs because parcel spawning, NPCs, and Qwen response latency vary.

Compare combined tournament score, delivered parcels, duplicated target attempts, navigation failures, Qwen calls, and communication overhead. Report both the functional cooperation evidence and the measured performance; do not claim a performance gain until repeated matched trials establish it.

## 5. Troubleshooting

- **No `coordination_received` events:** check `COORDINATION_ENABLED=true` in both commands and correct `TOKEN_BUBBLE`/`TOKEN_MILKTEA`. Stop old agent processes. Check that both players appear simultaneously in the game panel.
- **One agent appears as a duplicate:** stop the process, verify the correct player token is loaded, and restart the game if needed. Do not paste your JWT into logs or chats.
- **Claims expire during long navigation:** the controller periodically renews its active claim. If the player disconnects, the peer's claim naturally expires.
- **No `coordination_yield` events:** not an error when the agents choose different parcels. Force a shared target in a repeatable fixture for a deterministic conflict test (already covered by automated tests).
- **LLM objective stalls:** save full logs and inspect tool failures; small parcels may decay before delivery. This is a game performance issue, separate from whether the two agents exchanged beliefs and intentions.
- **Different local game server configuration:** use `oval_counterclockwise` and ideally a fresh server restart, not a map changed from `hundred` mid-session.

## 6. Important limitations

The SDK chat protocol is a **cooperative application agreement**, not a server-enforced lock or an authentication boundary. Teammate names and server-supplied connection IDs are checked, but the game server does not guarantee claim exclusivity. Simultaneous commitments are settled using path distance, an incumbent preference, and a deterministic tie-breaker; race windows can remain. A peer disconnect is tolerated through short-lived claims.

Stage 2C does **not** implement the unpublished course tool-server API or the final Challenge 2 objective-delivery format. The BDI PDDL capability is still available and the independent `MOVER=astar|pddl` modes remain selectable.
