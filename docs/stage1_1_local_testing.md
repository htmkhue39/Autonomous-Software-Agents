# Stage 1.1 — Local testing (macOS / zsh)

Use this checklist after replacing the previous Stage 1 source. The **original** Deliveroo.js server folder and its game assets remain unchanged. The agent folder is the code we modify.

## 1. Prepare

- **Terminal A:** start your existing official Deliveroo.js server in its own folder with `npm start` (after `npm install` and `npm run build` if needed). Open <http://localhost:8080> in a browser.
- In the browser, sign in with a **separate local admin-viewer token**. Select a normal map such as `oval_counterclockwise`. The game map appears after clicking **Play** for the viewer identity; the viewer account must **not** share the `bubble` agent's token.
- **Terminal B:** open `Autonomous-Software-Agents`. Preserve your existing **local** `.env`, which is intentionally omitted from the downloadable ZIP. Use the `.env.example` as a reference; don't overwrite your token.

At minimum, `.env` should contain:

```dotenv
HOST=http://localhost:8080
AGENT=bubble
TOKEN_BUBBLE=<a-token-issued-by-your-local-server>
MOVER=astar
REPLACE_MARGIN=1.2
MIN_COMMIT_MS=6000
FAILED_GOAL_COOLDOWN_MS=10000
```

The `TOKEN_BUBBLE` value must be a local **game** token, not an admin or LLM token. Keep it private. Reuse the same token between runs so you don't create duplicate `bubble` identities. If you have no agent token yet, create one in the web login modal with name `bubble`, copy it to `.env`, and use the **other** browser identity for spectating. Stop any old `npm run observe` or agent process before launching.

## 2. Automated checks

From `Autonomous-Software-Agents`:

```bash
node --version        # Node 22.x recommended
npm ci                # installs dependencies from package-lock.json
npm test              # expected: 105 tests, 0 failures
npm run typecheck     # expected: no TypeScript/JSDoc errors
```

These tests use a deterministic fake game client and an injected PDDL solver. They **do not** prove a real-server run of this modified code.

## 3. A* smoke test

```bash
mkdir -p logs
HOST=http://localhost:8080 MOVER=astar npm start 2>&1 | tee logs/astar-stage11.log
```

Watch `bubble` in the browser for at least a few pickup/delivery attempts. Expect:

- `startup` showing the local host and `astar` mode; `Connected` appears.
- `intention_activated`, `move`, `pickup_ack`, `pickup`, `delivery`, and `score_changed` as parcels are handled.
- `pickup_ack` reports `returnedIds` and `responseShape`. If the acknowledgement omitted the target but sensing confirmed it, `pickup` uses `confirmation:"sensing"`; a missing target with **no** evidence is correctly recorded as a failure.
- An unreachable goal should produce `navigation_failed` and `intention_cooldown`; the agent should not immediately select the same goal again.
- A delivery underway should no longer be cancelled merely because another parcel looks more valuable.
- There should be **no `pddl_call` events** in A* mode.

Stop the agent with **Ctrl+C**. The game server continues running.

To summarize the structured events in that log, run:

```bash
npm run summarize -- logs/astar-stage11.log
```

The summary's **last observed score is not necessarily the saved timed-round score**. For a fair three-minute run, click the browser's green **Play** button to reset the scoreboard and parcels, let its **03:00** countdown finish, and record the saved round from the **Tournament** panel. The agent itself keeps running after the timer finishes; stop it using Ctrl+C.

## 4. PDDL smoke test

Use the same server/map, but stop the A* process first:

```bash
HOST=http://localhost:8080 MOVER=pddl npm start 2>&1 | tee logs/pddl-stage11.log
```

Expected:

- `pddl_call` followed by `pddl_success` from the **real** remote planner and actual `move` events for the resulting path.
- `planner_fallback` is clearly logged if the solver fails; fallback-only navigation is **not** evidence of successful external planning.
- Fewer wasted cancellations than the old version, particularly for deliveries and small utility-ranking changes (the count can vary with the map and observations).
- The course planner endpoint requires connectivity. The earlier live log demonstrated successful solver calls with approximately 3–4 seconds latency, but this modified build still needs to be verified on your machine.

Summarize the run:

```bash
npm run summarize -- logs/pddl-stage11.log
```

Compare `pddl_success`, mean successful PDDL time, `intention_revision`, `navigation_cancelled`, `move_refused`, `intention_cooldown`, and actual delivered score.

## 5. Controlled three-minute comparison

After both smoke tests succeed, run one A* round and one PDDL round using the same map, rules, opposing agents, and browser timer. Record:

| Field | What to record |
| --- | --- |
| Server map/config | e.g. `oval_counterclockwise`, any enabled plugins |
| Agent mode | `astar` or `pddl` |
| Round duration | 3 minutes using browser's timer |
| Saved round score | Tournament panel value immediately after round ends |
| Successful deliveries | Count of `delivery` events during the timed interval |
| Movement failures | `move_refused`, `navigation_failed` |
| Intention stability | `intention_revision`, `navigation_cancelled`, `intention_cooldown` |
| Planner | `pddl_call`, `pddl_success`, `pddl_failure`, `planner_fallback`, average latency |

One round is a **smoke test**, not a statistically fair benchmark. Repeated matched runs and score variability belong in the later benchmarking milestone.

## 6. Troubleshooting

| Symptom | Action |
| --- | --- |
| Browser shows controls but a blank map | Log in as your **viewer** and click Play; connecting a Node agent does not log the browser in. |
| Two `bubble` identities appear | Stop all scripts, keep a single local `TOKEN_BUBBLE`, and Kick the stale agent using the admin browser (select the exact row before clicking Kick). |
| Agent stuck in one goal | Check `navigation_failed` and `intention_cooldown` events; save the complete log and note the map and agent position. |
| `pickup_ack` doesn't list the expected parcel | Check `responseShape`, `returnedIds`, and whether `confirmation:"sensing"` follows. If still failed despite later delivery, share the redacted event sequence and SDK version. |
| `planner_fallback` without `pddl_success` | Check network access to the external solver; PDDL compliance remains unverified for that run. |
| `npm run typecheck` fails | Report error and file/line. Do not bypass typecheck. |
| No agent appears | Check `HOST`, local game token, and that the server is running. |

## 7. Evidence to share for follow-up debugging

Share the map name, `node --version`, `npm ls @unitn-asa/deliveroo-js-sdk`, the `npm run summarize` output, and a redacted portion of `logs/*-stage11.log` around any failure. **Remove game tokens and secrets**; do not upload `.env` or a ZIP containing `.env`, `.git` or `node_modules`.
