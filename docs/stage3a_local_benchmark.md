# Stage 3A — Local fixed-duration benchmark (macOS)

This is an **additive** benchmark harness built on the frozen Stage 2C.2.2
functional baseline. Regular `npm start`, `npm run start:llm -- --objective ...`
and the cooperative tests are unchanged. The only gameplay change is an
explicit `BENCHMARK_CONTINUOUS=true` session mode for milktea; it repeats
verified delivery objectives rather than quitting as soon as three deliveries
are achieved. Stage 3A does not modify parcel selection, arbitration, or PDDL.

## Requirements

- Two **different** directories: this agent project and the **official**
  `Deliveroo.js` game-server checkout. The directory passed via `--server-dir`
  must contain the game-server `package.json`, **not** this agent's package.
- Node.js 22 recommended, `npm ci` completed in **both** repositories.
- A working Ollama daemon (`ollama list` shows `qwen3.5:4b-q4_K_M`).
- In the **agent** project, the private `.env` contains `TOKEN_BUBBLE` and
  `TOKEN_MILKTEA`, as previously verified. A blank token can create a new
  player, but per-server authentication must be checked if agents fail to join.
- `LLM_MODE=json` and `OLLAMA_MODEL=qwen3.5:4b-q4_K_M` in `.env`.
  Stage 3A itself pins JSON action mode for the milktea process.
- **STOP the game server first.** The benchmark will launch and clean up a
  fresh game server itself for each trial. If port 8080 is already occupied,
  it deliberately fails rather than reusing a potentially contaminated game.

## 1 — Install and smoke test

Open a terminal in the extracted **Stage3A agent project directory**:

```bash
npm ci
npm test
npm run typecheck
```

Replace `/ABSOLUTE/PATH/TO/Deliveroo.js` with your actual official server
folder. In particular, do not pass your current `Autonomous-Software-Agents`
folder.

```bash
npm run benchmark -- \
  --server-dir "/ABSOLUTE/PATH/TO/Deliveroo.js" \
  --runs 1 \
  --duration 45
```

This runs one 45-second round in each configuration, with a fresh server for
**each** round. On first use, verify that the agents actually connect and
`valid=true` appears; if not, inspect each trial's `server.log`, `bubble.log`
and `milktea.log`. A 45-second smoke round may legitimately yield zero
deliveries. For a representative round use 180 seconds.

The runner writes a unique local directory under `benchmark-results/`:

```
benchmark-results/<timestamp>/
├── manifest.json          # sanitized configuration + all trial summaries
├── rounds.csv             # one row per trial
├── aggregate.json         # means and sample SD (VALID trials only)
├── 01_A_trial1/
│   ├── server.log
│   ├── bubble.log
│   └── result.json
├── 02_B_trial1/
│   ├── server.log
│   ├── bubble.log
│   ├── milktea.log
│   └── result.json
└── 03_C_trial1/
    ├── server.log
    ├── bubble.log
    ├── milktea.log
    └── result.json
```

To display the result later:

```bash
npm run benchmark:summary -- benchmark-results/<timestamp>
```

## 2 — Research trials

After the smoke test succeeds:

```bash
npm run benchmark -- \
  --server-dir "/ABSOLUTE/PATH/TO/Deliveroo.js" \
  --runs 5 \
  --duration 180 \
  --modes A,B,C \
  --mover astar
```

A, B and C compare:

| Mode | Players | Coordination | Key comparison |
| --- | --- | --- | --- |
| A | bubble BDI only | off | Solo baseline |
| B | bubble BDI + milktea LLM | off | Impact of adding second player |
| C | bubble BDI + milktea LLM | on | Isolating benefit of coordination: **C vs B** |

Trial order rotates between repetitions: `A,B,C / B,C,A / C,A,B / ...`
so the experiment is not systematically biased toward the same first mode.
With five runs per mode there are 15 individual 180-second rounds (45 minutes
of **gameplay**, plus server startup and LLM overhead). `Ctrl+C` stops the
active round and cleans up the server; completed trial files remain available.

After A/B/C, an optional **separate** path-planner comparison may use
`--mover pddl`. Do not mix PDDL rounds into an A* aggregate.

## 3 — Data interpretation and limits

**Crucial distinction:** `teamObservedScore` in CSV is the sum of the two
agents' **last SDK-observed scores**, or bubble's score in A. This is **not**
the course's saved Tournament result. The runner intentionally writes
`officialTournamentScore: null` and labels every result
`last_agent_observed_not_tournament`. For official conclusions, use the
saved Tournament panel and document its protocol/time windows separately.
Never present `teamObservedScore` as a verified Tournament score.

The runner uses the same `GAME_NAME=oval_counterclockwise`, ruleset, configured
movement planner, fixed wall-clock time, and a completely new game-server
process per trial. **Random seeds and exact parcel spawn patterns are not
controlled** by this harness because no verified seed-setting interface was
available in the supplied server materials. The rounds are therefore
repeated under comparable conditions, **not paired identical-world trials**.
This limitation should be mentioned in your report.

Each round's wall-clock clock starts when the agent processes are spawned,
not when Ollama first finishes inference. This intentionally measures full
system throughput including model-startup/inference delays, rather than equal
post-warmup thinking time. Review `bdi_game_ready` and `llm_game_ready`
events to quantify join latency if needed.

The summary includes: agent-observed score, parcel count confirmed in delivery
logs, delivery actions, pickups, LLM calls/tools, SDK failures, navigation
failures, belief merges, claims/yields and invalid/early-exit flags. It drops
game events after the round deadline. `valid=false` rounds are excluded from
the aggregate mean, but **must be reported as failures**, not silently erased.
When a process exits early, no trusted score is available, or a server does
not stop, its trial is flagged invalid. Raw scores can be 0 without being
invalid if a ready agent observed that score.

The LLM benchmark uses repeated `Deliver 3 parcels` **episodes** throughout
the round. The agent remains active after each three-delivery milestone.
An episode that stalls gets a bounded pause and another planning attempt,
while an `uncertain_tool_outcome` terminates the LLM session rather than
risking a duplicated action. Existing tool validation and coordination safety
are unchanged. A blocked/early-exiting LLM trial is invalid and should be
investigated rather than counted as a successful full-duration run.

**Safety:** raw logs can expose map data, agent names and game-session metadata.
They are ignored by Git under `benchmark-results/`. The harness never writes
private `.env` contents or JWTs to the manifest, but inspect logs yourself
before uploading/sharing them publicly. Do not check private JWTs into GitHub.

## 4 — Troubleshooting

- **"Port already occupied"**: stop the manually launched game server
  (`Ctrl+C` in its terminal); the runner must own port 8080 from trial start.
- **"Game server did not open"**: check `server.log`; verify `npm ci` and
  `GAME_NAME=oval_counterclockwise npm start` work in the official server
  directory. Check whether the server uses port 8080.
- **"agent_not_ready"**: inspect `bubble.log` and `milktea.log` for
  authentication/socket problems. Confirm two distinct token identities.
- **"missing_score_observation"**: inspect agent logs; do **not** substitute
  `0` unless SDK explicitly observed a zero score.
- **"early_agent_exit"**: check for Ollama timeouts, model availability,
  or `blocked_uncertain_outcome` in the LLM log. Do not hide these trials.
- **`valid=true` with no deliveries**: the agents connected and the round
  completed; their strategy may still have produced zero score.
- **No claim yields**: not evidence that communication is broken; inspect
  `coordination_received` and `coordination_claim_started`. Benefit requires
  controlled comparison B vs C, not yield counts alone.

The code and automated tests are runnable in this environment; real game
server + Ollama timed trials **must be verified on your Mac** before any
benchmark-based research claim.
