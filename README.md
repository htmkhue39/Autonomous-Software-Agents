# BDI and LLM Agents for Deliveroo.js

An autonomous multi-agent project for the University of Trento's **Autonomous Software Agents** course. Two **independent JavaScript processes** control two players in [Deliveroo.js](https://github.com/unitn-ASA/Deliveroo.js):

- **`bubble` (BDI)** maintains beliefs about parcels, agents, and the map; compares pickup, delivery, and exploration options; revises intentions; and executes predefined plans. It supports A* navigation and an **external online PDDL solver**.
- **`milktea` (LLM)** interprets natural-language objectives with Ollama/Qwen, keeps bounded working memory, selects validated game tools, checks real outcomes, and supports updated objectives.
- In **cooperative mode**, the agents exchange parcel beliefs and claims through the game SDK, avoiding duplicate targets. After a confirmed delivery, `milktea` can automatically leave the shared delivery tile to reduce congestion.

This repository includes automated regression tests, a four-scenario **local live-game validator**, and a randomized-order two-condition **ablation benchmark**. Local validation does **not** imply official instructor certification.

## Architecture in one minute

```text
Deliveroo.js server (sensing + SDK actions)
    |                                    |
    v                                    v
bubble: BDI process                   milktea: LLM process
  beliefs -> options -> intention        goal + observations + memory
         -> plan -> move/pickup          -> Qwen -> validated tool
         -> A* or external PDDL          -> game plan -> observed result
    |                                    |
    +------ SDK communication -----------+
           HELLO / BELIEF / CLAIM / RELEASE / STATUS
           (each process retains its own beliefs and decisions)
```

## Prerequisites

- **Node.js 22** with npm, and an independent checkout of the [Deliveroo.js game server](https://github.com/unitn-ASA/Deliveroo.js).
- **Ollama** with the local model `qwen3.5:4b-q4_K_M` installed for the LLM player. The default provider is local Ollama; an optional OpenAI-compatible adapter exists but has **not** been verified against the instructor's API.
- Two **different private game tokens** (`TOKEN_BUBBLE` and `TOKEN_MILKTEA`) obtained from the same game server. Do **not** commit `.env` or publish tokens.
- Internet access to the external `@unitn-asa/pddl-client` online solver for a *successful PDDL demonstration*. When unavailable, A* fallback is not evidence of a PDDL success.
- For `course:validate` and `benchmark:ablation`: macOS or Linux, and the server port must be free before execution.

Detailed setup, including configuration and token acquisition: **[docs/SETUP.md](docs/SETUP.md)**.

## Quick start

```bash
npm ci
cp .env.example .env
# Edit .env with your local HOST, separate tokens, and LLM settings.
npm test
npm run typecheck
```

In a separate terminal, start the **game server** (not this agent repository):

```bash
cd "/path/to/Deliveroo.js"
npm ci
GAME_NAME=oval_counterclockwise npm start
```

With the server running on `http://localhost:8080` and Ollama available, start either player independently:

```bash
# Terminal A — standalone BDI (A*)
AGENT=bubble MOVER=astar npm start

# Terminal B — independent LLM with one natural-language goal
AGENT=milktea MOVER=astar LLM_MODE=json npm run start:llm -- \
  --objective "Collect and deliver at least one parcel."
```

To **enable cooperation**, restart the agents with `COORDINATION_ENABLED=true` in **both** terminals:

```bash
AGENT=bubble MOVER=astar COORDINATION_ENABLED=true npm start
AGENT=milktea MOVER=astar LLM_MODE=json COORDINATION_ENABLED=true npm run start:llm -- \
  --objective "Collect and deliver at least one parcel."
```

Cooperative delivery-tile evacuation is enabled by default only for the LLM agent in cooperative mode. Override with `LLM_DELIVERY_EVACUATION=false` or `true` only for a specific experiment.

## What to run for the exam

| Task | Command | What it demonstrates |
| --- | --- | --- |
| All automated tests | `npm test` | Pure tests and simulated integrations; **not** a live game |
| Static JS checking | `npm run typecheck` | TypeScript-based checking of JavaScript; requires the compiler |
| Course audit | `npm run course:audit` | Code-to-requirement matrix |
| API/MCP mock test | `npm run course:smoke` | **Local mock** of optional remote integrations |
| Failure-recovery tests | `npm run course:failure-tests` | Deterministic/simulated recovery |
| Live local validation | `npm run course:validate -- --server-dir "/path/to/Deliveroo.js" --duration 180` | BDI + PDDL, LLM, cooperation, and objective replacement across fresh games |
| Repeated performance test | `npm run benchmark:ablation -- --server-dir "/path/to/Deliveroo.js" --runs 10 --duration 180 --schedule-seed 20261112` | 10 independent-game trials per condition, order randomized |
| Release preflight | `npm run release:check` | Check curated files, evidence, and Git hygiene |

**Do not manually start the game server** before running either automated live runner: each runner launches and cleans up fresh servers itself. On a Mac, prefix long-running experiments with `caffeinate -i` to avoid sleep. The game-world random seed is *not controlled*: `--schedule-seed` controls only the order of benchmark conditions.

See **[docs/DEMO.md](docs/DEMO.md)** for a short oral-exam demonstration and **[docs/EVIDENCE.md](docs/EVIDENCE.md)** for the original trial data, effect sizes, and limitations.

## Recorded findings (local, not official Tournament results)

- A randomized-order experiment with **20 valid 180-second trials** (10 per condition) observed mean team scores of **243.7 without** and **376.3 with** post-delivery evacuation (**+54.4%**). Mean teammate-related congestion failures declined from **4.7 to 1.7 per trial**. Game worlds were not paired or seeded; see evidence for statistical limitations.
- Four live local course-readiness scenarios passed **60/60 checks**, including one actual external PDDL success. This is not the instructor's private evaluator.

The metrics are **agent-observed**, not the official Tournament scoreboard. Raw logs and private credentials are deliberately excluded from the public release.

## Repository map

```text
src/                         Gameplay agents, beliefs, planning, coordination, LLM
scripts/                     Launch and evaluation CLI helpers
test/                         Unit and deterministic integration tests
 docs/SETUP.md                Installation and environment configuration
 docs/DEMO.md                 Demonstration and fallback plan
 docs/EVIDENCE.md             Local experimental methods and limitations
 docs/FINAL_AUDIT.md          Release audit and remaining caveats
 evidence/                    Sanitized summary data from real Mac runs
 submission/                  10-page report and exam presentation
```

Historical development notes remain in `docs/` for traceability; they are not current setup instructions. See [docs/INDEX.md](docs/INDEX.md).

## Scope and limitations

The published course materials do not provide a verified instructor LLM endpoint, approved tool-server schema, objective-delivery contract, or official challenge outcome for this repository. Optional compatibility adapters are provided and were mock-tested, but should not be described as official integrations until confirmed. The included report describes the actual local implementation and tests, not an official tournament ranking.
