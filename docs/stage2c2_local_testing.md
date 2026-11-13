# Stage 2C.2 — Mac installation and live test

Stage 2C.2 patches Stage 2C.1; it **does not** replace the BDI/PDDL agent or cooperation protocol. It adds an LLM tool that selects a parcel *when the tool executes*, so a model decision need not carry a stale parcel ID.

## 1. Install as a separate working copy

1. Unzip `Autonomous-Software-Agents-Stage2C2.zip` into a **new** folder.
2. Copy your private `.env` from Stage 2C.1 into the new `Autonomous-Software-Agents` folder. Never put tokens in a public commit or send them in logs.
3. From that folder, run:

```bash
npm ci
npm test
npm run typecheck
```

Expected from the packaged code: **190 passing tests**, zero failed, strict typecheck clean. These are deterministic and simulated tests. They do *not* require the game server or an Ollama daemon.

## 2. Run the real server and Ollama

In a separate `Deliveroo.js` terminal:

```bash
GAME_NAME=oval_counterclockwise npm start
```

Open `http://localhost:8080` as your **admin-viewer** account, not as `bubble` or `milktea`. Keep the level `oval_counterclockwise` (1 built-in NPC). Start Ollama, or use the already running service:

```bash
ollama list
```

Your `.env` should contain valid **separate** `TOKEN_BUBBLE` and `TOKEN_MILKTEA` tokens for this game server. Never expose the full JWT values. Qwen `qwen3.5:4b-q4_K_M` must be installed.

## 3. Run both agents in different terminals

BDI terminal:

```bash
mkdir -p logs
HOST=http://localhost:8080 AGENT=bubble MOVER=astar COORDINATION_ENABLED=true \
  npm start 2>&1 | tee logs/bubble-stage2c2.log
```

LLM terminal:

```bash
mkdir -p logs
HOST=http://localhost:8080 AGENT=milktea MOVER=astar COORDINATION_ENABLED=true \
  OLLAMA_MODEL=qwen3.5:4b-q4_K_M \
  npm run start:llm -- --objective "Deliver 3 parcels" \
  2>&1 | tee logs/milktea-stage2c2.log
```

The local LLM objective is intentionally short. **Keep the same `LLM_MAX_STEPS=18` and `LLM_MAX_TOOL_CALLS=20` values** for the first comparison, and do not change your Stage 2C.1 utility policy.

The LLM should *prefer*:

```json
{"name":"collect_best_and_deliver","arguments":{"strategy":"highest_expected_reward"}}
```

The model may still choose other tools; it is an LLM, not a hardcoded controller. `nearest_viable` is also accepted. `explore_if_empty` is optional and defaults to `true` (at most one exploration trip within this tool call). No target is claimed as delivered without a confirmed game action.

### What changed

- The tool **re-reads beliefs at execution time** to select a candidate, rather than trusting an ID from model history.
- It ranks viable candidates by expected delivery reward or nearest pickup path, using map reachability and teammate claims.
- Direct parcel sightings older than 3 seconds and peer reports older than 1.5 seconds are unsuitable for **immediate dynamic targeting**. They can still inform exploration. This is a heuristic, not a guarantee of parcel availability.
- If a target vanishes before any SDK pickup is dispatched, the tool can select another fresh candidate, with a bounded retry count.
- Once an SDK pickup is dispatched, a failure or unknown outcome is returned **without automatically trying another parcel**. The agent must reconcile state first.
- With no viable known parcel, the tool can explore once and reassess. Otherwise it returns `status: "no_viable_target"` without inventing success.
- Legacy `collect_and_deliver({"parcel_id":"..."})` remains available for exact-ID tasks.

## 4. Save results and inspect failures

After `milktea` finishes, stop `bubble` with Ctrl+C. Run:

```bash
npm run summarize:coop -- logs/bubble-stage2c2.log logs/milktea-stage2c2.log
```

Inspect the new events:

```bash
grep -E '"event":"llm_dynamic_(selected|reselected|explore|no_target|delivered)"' \
  logs/milktea-stage2c2.log

grep '"event":"llm_tool_result".*"ok":false' logs/milktea-stage2c2.log
```

Check the final `game_objective_result` for `status: "completed", reason: "verified"` and `deliveredCount >= 3`. The report now distinguishes `preconditionRejections` from `failedGameActions` and `invalidToolCalls`; it preserves the older `invalidTools` aggregate for comparison.

### Interpretation

Compare with Stage 2C.1's supplied run (**1 LLM delivery, 19 LLM calls, 9 unavailable/expiry target errors, 8 cooldowns**, max steps reached). This was a different live run: **do not present an improved result as a causal performance gain without repeated matched trials**. For a proper evaluation, run multiple 3-minute rounds on the same map/configuration and record the saved Tournament results separately from the free-running agent logs.

## 5. Troubleshooting

- **No `llm_dynamic_*` events:** Qwen may be choosing the old exact-ID `collect_and_deliver` tool. Confirm you're running the Stage 2C.2 folder, then inspect `llm_plan` and tool events. Native tool selection is model-controlled; a test can be repeated using `LLM_MODE=json` if needed.
- **`no_viable_target`:** No sufficiently recent, reachable, unclaimed, profitable parcel is currently known. This is not an SDK failure. Exploration may find one later; a parcel can still disappear during movement.
- **`game_action_failed` after starting movement:** Treat as a real or possibly post-dispatch action failure, inspect the latest inventory and sensor data before retrying.
- **`outcome_unknown`:** Do not blindly reissue the SDK action; inspect/reconnect and reconcile the state.
- **`milktea` doesn't connect:** Confirm the token's identity and that `.env` was copied into the extracted Stage 2C.2 directory.
- **200 NPCs:** Stop the server and start with `GAME_NAME=oval_counterclockwise npm start`, then refresh the browser.
- **Course LLM API or tool server:** Professors have not yet provided its contract. This test uses local Ollama and our validated tools, not an assumed official tool catalog.

**Live verification is still required on your Mac.** The package's automated tests use a simulated Deliveroo.js client and synthetic Ollama responses.
