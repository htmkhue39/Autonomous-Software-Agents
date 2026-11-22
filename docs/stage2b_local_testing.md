# Stage 2B — Independent LLM Deliveroo.js agent (macOS)

## Status and scope

Stage 2B was implemented **on top of the exact completed Stage 2A ZIP**. The existing `bubble` BDI agent, its utility, A*, PDDL, intentions and action executor were not rewritten. The new `milktea` agent has its own SDK connection, belief state, action gate, LLM memory and tools. It reuses the tested Stage 1.1 *implementations* but not `bubble`'s running agent instance.

**Developer verification:** 150/150 Node tests passed in the Stage 2B.1 patch, including simulated pickup → actual Stage 1.1 movement/action plan → delivery → verified completion; strict JS typechecking passed. **Real Ollama + Deliveroo.js gameplay is not tested in the delivery environment**. That acceptance gate is for your Mac.

## A. Install without overwriting the baseline

1. Back up your current Stage 2A project and its `.env` separately.
2. Extract `Autonomous-Software-Agents-Stage2B.zip` into a **new** directory.
3. Restore your local `.env` privately. Do **not** copy it into Git or share the JWTs.
4. From the new project folder:

```bash
npm ci
npm test
npm run typecheck
npm run llm:smoke
```

Expected: **150 tests passed**. Your Stage 2A toy-world Qwen smoke should continue to pass.

## B. Run the local game and Ollama

In terminal 1, launch your existing official Deliveroo.js server:

```bash
cd /path/to/Deliveroo.js
GAME_NAME=oval_counterclockwise npm start
```

If the server was already running with a different game, stop it first. In browser `http://localhost:8080`, log in as an **admin viewer** with your own token to inspect the map. Expect only the `oval_counterclockwise` map and its single intelligent NPC `a0` before launching our agents.

In terminal 2, verify the local model:

```bash
ollama list
curl -s http://127.0.0.1:11434/api/tags | head -c 300
```

If the Ollama service is not running, use `ollama serve` in a separate terminal. Do not start a second server if your Ollama desktop app is already listening on 11434.

## C. Get a **separate** `milktea` token

Through the game's normal login/token UI, create a **regular** player identity `milktea` (not admin and not `bubble`). Save its local JWT in the new project's `.env`:

```dotenv
HOST=http://localhost:8080
TOKEN_MILKTEA=<your-private-local-milktea-token>
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:4b-q4_K_M
```

`TOKEN_BUBBLE` belongs only to the existing BDI agent. The Stage 2B runner **never reads or reuses** `TOKEN_BUBBLE`. If `TOKEN_MILKTEA` is omitted the server can issue a new identity/token; to avoid duplicates, create and persist a distinct token before repeated runs.

## D. First independent live objective (no BDI yet)

In terminal 3, from the new Stage 2B project directory:

```bash
mkdir -p logs
HOST=http://localhost:8080 AGENT=milktea MOVER=astar npm run start:llm -- --objective "Collect and deliver at least one parcel." 2>&1 | tee logs/milktea-stage2b.log
```

**Important:** Do this *without* starting `bubble` initially. A successful run should print structured events resembling:

```text
llm_game_ready
llm_plan
llm_tool_result ... collect_and_deliver ... ok:true (or separately pickup_parcels + deliver_parcels)
game_objective_result ... status:completed ... deliveredCount:1
```

You should also visually see `milktea` move, pick up, and deliver in the game viewer. The exact tool sequence can vary; no model result is guaranteed. The process **exits after the objective succeeds or after configured limits**, rather than playing forever.

Summarize the saved log:

```bash
npm run summarize:llm -- logs/milktea-stage2b.log
```

**Success requires** a genuinely executed delivery and `status: completed, reason: verified`. `reported_completed` or a conversational claim without game evidence is not a pass. If the process fails, send the structured events and summary, redacting tokens.

## E. Next scenarios

Test the score objective after the first real delivery works:

```bash
HOST=http://localhost:8080 AGENT=milktea MOVER=astar npm run start:llm -- --objective "Reach at least 100 points"
```

Test invalidated parcel targeting by having the NPC pick up a parcel first; the agent should report a recoverable tool failure and choose another action instead of blindly repeating pickup. If the model returns native-tool errors, try:

```bash
HOST=http://localhost:8080 AGENT=milktea LLM_MODE=json MOVER=astar npm run start:llm -- --objective "Collect and deliver at least one parcel."
```

This explicitly selects schema-guided JSON fallback. No automatic change of mode occurs during measurement. **Use a consistent model/mode/map** for comparisons.

Once independent gameplay is verified, you may start `bubble` in another terminal with its *own* token, `HOST=http://localhost:8080 AGENT=bubble MOVER=astar npm start`. This only tests concurrency; actual **belief sharing, intention exchange, conflict avoidance and parcel claims belong to Stage 2C**, so both players will act independently for now.

## F. Local objectives and limits

Supported local deterministic completion criteria (not a substitute for the unpublished course objective contract):

- `Collect and deliver at least one parcel.` → at least one **acknowledged** parcel delivery.
- `Deliver 3 parcels` → 3 acknowledged parcel IDs delivered by this process.
- `Reach at least 100 points` → current game score ≥100.
- `Earn 50 additional points` → score increased ≥50 since the objective began.

Other objectives deliberately return `unsupported_local_completion_criterion` rather than fabricating success. The LLM still interprets supported natural-language objectives and chooses which tools to execute. No official tool-server catalog or objective interface has been invented.

Defaults: `LLM_MAX_STEPS=18`, `LLM_MAX_TOOL_CALLS=20`, `LLM_TOOL_TIMEOUT_MS=60000`, `LLM_TIMEOUT_MS=120000`, `LLM_MAX_RUN_MS=180000`. Tools abort at their limits; a timeout after SDK dispatch is **unknown outcome**, not permission to retry without re-observation. For a better live benchmark, first measure planning time and objective completion, then do repeated three-minute tournament runs with an explicitly selected score goal.

## G. Troubleshooting

| Symptom | Action |
|---|---|
| `No full SDK map/config/self observation` | Confirm the game server is reachable, player token is valid, and map is loaded; check `HOST` |
| `milktea` missing or duplicated | Check `TOKEN_MILKTEA`, do not reuse `TOKEN_BUBBLE`, use admin Kick on extras; restart the local server if needed |
| `Ollama unreachable` | Check Ollama app/service and `OLLAMA_BASE_URL` |
| `invalid_plan` / `stalled` | Retry once, inspect logged plan/tool names, try `LLM_MODE=json` explicitly |
| `game_action_failed` | Target may have disappeared or route become blocked; model should inspect beliefs and replan |
| `outcome_unknown` | A side effect was interrupted/timed out; don't blind-retry; inspect server state and re-run after reconciliation |
| No delivery despite movement | Inspect `pickup_ack`, `pickup`, `delivery`, `llm_tool_result` and game rules |
| `unsupported_local_completion_criterion` | Use documented objectives; official challenge goals await the actual professor objective contract |

**Security:** Never print, share, upload, or commit JWTs or full `.env`. Log files may include map positions and parcel IDs but must not contain secrets.


## Stage 2B.1 patch — Recovery from the first live parcel-expiration failure

The first observed real Ollama run (Nov 12, 2026) successfully collected `p47`
but failed to deliver. The process spent about 8 seconds between the completed
pickup and its first move to the delivery zone. At the putdown action the agent
was carrying nothing and its game score remained 0; parcel expiration is the
most plausible explanation, though the server-side expiry event was not logged.
The model then returned prose instead of another tool and the loop stalled.

Stage 2B.1 adds:

- `collect_and_deliver({parcel_id})`, an **LLM-selected** atomic *tool call*
  executing the existing pickup and delivery plans back-to-back with **no
  intervening model inference**. The LLM still makes the strategic parcel
  choice; deterministic A* handles movement.
- A maximum of one corrective turn after a native Ollama response without
  function calls. Prose alone cannot satisfy the objective. The loop still
  stops if the model again fails to choose a tool.
- Updated observations even after a *known* tool failure and diagnostic
  `errorMessage` in `llm_tool_result` events. Unknown outcomes remain blocked
  rather than blindly retried.

Testing: 150/150 Node tests passed, and the project JS typecheck passed.
**Live local Qwen and game success are still unverified for this patch**.

Extract the Stage2B.1 ZIP **in a new folder**, preserve your private `.env`,
`npm ci`, `npm test`, `npm run typecheck`, start Deliveroo.js and Ollama, then run:

```bash
mkdir -p logs
HOST=http://localhost:8080 AGENT=milktea MOVER=astar \
  npm run start:llm -- --objective "Collect and deliver at least one parcel." \
  2>&1 | tee logs/milktea-stage2b1.log
npm run summarize:llm -- logs/milktea-stage2b1.log
```

Positive verification requires a real `delivery` event and
`game_objective_result` with `status: completed`, `reason: verified`.
If Qwen does not select `collect_and_deliver`, inspect the plan and tool events.
It is allowed to select separate `pickup_parcels` / `deliver_parcels` tools,
but that is slower and may allow rewards to expire.
