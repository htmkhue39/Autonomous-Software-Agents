# Stage 2C.2.1 — macOS testing: safe teammate-claim yields

## Why this patch exists

A live Stage 2C.2 test revealed the following sequence for `milktea`:

- `12:48:30.310` — claims `p1440`
- `12:48:30.557` — yields `p1440` to `bubble` and releases claim
- `12:48:30.608` — navigation cancelled, `movesCompleted: 1`
- `12:48:30.609` — incorrectly reports `outcome_unknown`, objective stops

This is NOT a 60-second tool timeout. It is a safe coordination cancellation
*before an SDK pickup/putdown action was dispatched*.

Stage 2C.2.1 maps that narrow known-safe case to `coordination_conflict` and
lets `collect_best_and_deliver` select another parcel. **Unknown SDK action
outcomes and timeouts are still not retried automatically.**

## Install

Extract the ZIP to a separate folder and copy your private `.env` from your
Stage 2C.2 installation. Do not put `.env` into the ZIP or a Git commit.

```bash
npm ci
npm test
npm run typecheck
```

Expected in this codebase: **193 passing tests**, strict typecheck passes.
These test results are from a synthetic game client. Live testing is pending.

## Live run

Start your official Deliveroo.js server on the `oval_counterclockwise` level,
log in to the browser as `admin-viewer` and keep Ollama running.

In terminal 1 from this project's root:

```bash
mkdir -p logs
HOST=http://localhost:8080 AGENT=bubble MOVER=astar COORDINATION_ENABLED=true \
  npm start 2>&1 | tee logs/bubble-stage2c2_1.log
```

In terminal 2:

```bash
mkdir -p logs
HOST=http://localhost:8080 AGENT=milktea MOVER=astar COORDINATION_ENABLED=true \
  OLLAMA_MODEL=qwen3.5:4b-q4_K_M \
  npm run start:llm -- --objective "Deliver 3 parcels" \
  2>&1 | tee logs/milktea-stage2c2_1.log
```

After the LLM finishes, stop `bubble` with Ctrl+C and summarize:

```bash
npm run summarize:coop -- logs/bubble-stage2c2_1.log logs/milktea-stage2c2_1.log
```

Inspect the relevant events:

```bash
grep -E '"event":"(coordination_yield|llm_coordination_safe_yield|llm_dynamic_reselected|llm_tool_result|game_objective_result)"' \
  logs/milktea-stage2c2_1.log
```

### Expected behavior

If a teammate wins a claim while `milktea` is **still navigating to pickup**,
look for `llm_coordination_safe_yield`, then `llm_dynamic_reselected`
(or `llm_dynamic_no_target` if nothing viable exists). The agent should **not**
terminate solely because it yielded a pre-pickup claim.

`outcome_unknown` is still possible for *genuinely* ambiguous game actions,
SDK timeouts or tool timeouts. Do not assume every unknown is safe.

A first successful delivery is a useful milestone; the three-delivery objective
and performance improvement require repeated local verification. The game's
saved Tournament round score (not the last logged free-play score) is the
basis of timed comparison.
