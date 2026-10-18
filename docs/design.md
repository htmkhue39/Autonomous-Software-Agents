# Deliveroo.js BDI agent: design

Date: 2026-10-13. Requirements: [project_requirement.md](project_requirement.md).
Server facts and open items: [server_notes.md](server_notes.md).
Plan: [implementation_plan.md](implementation_plan.md).

## Decisions

| Topic | Decision |
|---|---|
| Language | Plain JavaScript, ES modules, JSDoc types |
| Game client | `@unitn-asa/deliveroo-js-sdk` (1.3.10): `DjsConnect(host, token, name)` returning a `DjsClientSocket`. Needs `socket.io-client` installed alongside. |
| Planner client | `@unitn-asa/pddl-client` (1.7.7): `onlineSolver(domain, problem)`, default host `solver.planning.domains:5001` |
| PDDL role | Hybrid plan library: A* mover by default, PDDL mover selectable by flag, A* fallback on solver failure |
| Part 2 | LLM agent turns user instructions into validated directives (goals and constraints) that the BDI agent deliberates over |
| LLM provider | Open; isolated behind one file so it can be swapped |
| Out of scope | Two-agent team, opponent modelling, map-specific tuning, report |

## Architecture

One Node process per agent running sense → believe → deliberate → act:

```
server events ─> Beliefs ─> Option generation ─> Intention revision ─> Plan ─> actions
                    ^                ^                  ^                │
                    │                └── directives     └─── failures ───┘
                    │                       ^
              status reports ──> LLM agent <── user instruction (terminal)
```

### Units (under `src/`)

| Unit | Responsibility | Depends on |
|---|---|---|
| `config.js` | Server URL, token, mover choice (`astar`/`pddl`), LLM settings, tuning constants. Read from env. | none |
| `client.js` | Thin wrapper over the SDK: connect with `DjsConnect`, forward `onConfig`, `onMap`, `onTile`, `onYou`, `onSensing` to beliefs, expose `move`, `pickup`, `putdown`. The only file that imports the SDK. | SDK |
| `beliefs/map.js` | Tiles by type: `0` wall, `1` parcel spawner, `2` delivery, `3` walkable, `4` base, `5`/`5!` crate tiles, arrows `← ↑ → ↓` directional. Neighbour lookup that respects directional tiles. Temporary "blocked" marks with expiry. | none |
| `beliefs/parcels.js` | Known parcels: position, reward, carrier, last seen. Decay estimate from `config.GAME.parcels.decaying_event`. A parcel is removed when its tile is in `sensing.positions` but the parcel is absent, or when its estimated reward reaches zero. | config |
| `beliefs/agents.js` | Other agents' last known position and time. | none |
| `beliefs/index.js` | Aggregate `Beliefs` object with `me`, the three stores, and update methods called by `client.js` events. | above |
| `deliberation/utility.js` | Expected reward of an option: sum of carried and target parcel values after decay over the path length to pickup then nearest delivery. Pure function. | beliefs, astar |
| `deliberation/options.js` | Generates options (`pickup(parcel)`, `deliver`, `explore`) and returns them scored. | utility |
| `intentions/intention.js` | One intention: tries applicable plans from the library in order, can be stopped. | plans |
| `intentions/revision.js` | The agent loop. Holds the current intention; on belief change, replaces it when a new option beats it by a margin (to avoid thrashing). | options, intention |
| `plans/` | `GoPickUp`, `GoDeliver`, `Explore`, `MoveAStar`, `MovePddl`. Each has `isApplicableTo(intention)` and `execute()`; sub-goals go through the same intention mechanism. | planning, client |
| `planning/astar.js` | A* on the belief map, treating other agents and blocked marks as obstacles. Pure function. | map |
| `planning/pddl/domain.pddl` | Predicates `at`, `adjacent-up/down/left/right` (or one `connected`), actions `move-*`. Movement only. | none |
| `planning/pddl/problem.js` | Builds the PDDL problem from the belief map, current position and goal tile. | map |
| `planning/pddl/solve.js` | Sends domain and problem to the online solver with a timeout; maps the returned steps to move directions. | pddl-client |
| `index.js` | Wires everything and starts the loop. | all |

### Key behaviours

- **Intention revision.** Options are regenerated on every parcel-sensing
  event and after each completed or failed intention. The current intention
  is replaced only when the best new option exceeds it by a configurable
  margin.
- **Deliver decision.** `deliver` is scored like any other option, so the
  agent keeps collecting while nearby parcels are worth more than the decay
  it incurs, and delivers otherwise.
- **Explore.** With no known parcels, head for the spawn tile seen longest
  ago.
- **PDDL scope.** PDDL plans the path for a single move intention. Keeping
  the domain to movement keeps problems small and solver calls short.

### Part 2: LLM agent

| Unit | Responsibility | Depends on |
|---|---|---|
| `llm/directives.js` | The directive schema and validator. Goals: `goto(x,y)`, `pickup(parcelId)`, `deliverNow`, `pause`, `resume`. Constraints: `avoidArea(rect)`, `stayInArea(rect)`, `minParcelReward(n)`, `maxCarried(n)`, `clear`. Rejects anything outside the schema or off the map. | map |
| `llm/provider.js` | The only file that calls the LLM API. Takes a system prompt, the conversation and the tool schema; returns structured output. | LLM SDK |
| `llm/agent.js` | The LLM agent: builds the prompt from a compact belief summary (map size, my position, carried parcels, active directives), asks the provider for directives, validates them, sends them to the BDI agent, and turns status reports into a reply for the user. | provider, directives |
| `llm/console.js` | Terminal prompt where the user types instructions and reads replies. | agent |
| `beliefs/directives.js` | Active directives held as beliefs, with the status of each user goal (pending, active, done, failed and why). | none |

How the BDI agent uses directives:

- **User goals** become options with priority above autonomous ones. They
  enter the same intention revision, so the agent still replans around
  obstacles and reports failure if the goal is unreachable.
- **Constraints** filter option generation (reward threshold, carry limit,
  area) and mark tiles as forbidden for A* and for the PDDL problem.
- **Autonomy is kept.** With no directives the agent behaves exactly as in
  Part 1. The LLM never emits moves.
- **Latency.** LLM calls happen only when the user types, never inside the
  agent loop.

### Failure handling

| Failure | Response |
|---|---|
| Move returns `false` or times out | Mark the target tile blocked for a short time, replan; drop the intention after N attempts |
| PDDL solver timeout or error | Fall back to `MoveAStar` for that move, log it |
| No path | Drop the option, exclude that target for a short time |
| Parcel gone on arrival | Remove from beliefs, re-deliberate |
| LLM returns invalid or off-schema output | Reject, do not change directives, tell the user what was not understood |
| LLM API error or timeout | Keep current directives, agent carries on, report the error in the console |
| User goal unreachable | Mark failed with reason, report to the user, resume autonomous behaviour |
| Disconnect | Let the SDK reconnect; beliefs rebuild from fresh sensing |

### Testing

- Unit tests with `node --test` for the pure logic: A*, utility scoring,
  parcel decay and expiry, PDDL problem text, directive validation, and the
  effect of each constraint on option generation.
- `llm/agent.js` tested with a fake provider returning canned output.
- Live runs on the game server: A*, PDDL, and instructed (a fixed script of
  user instructions). Compare score over a fixed duration for A* and PDDL.

## Build roadmap

Each milestone is runnable and demonstrable on its own.

1. **Connect and observe.** `config.js`, `client.js`; log every event. This
   is where the open items in [server_notes.md](server_notes.md) get answered.
2. **Beliefs.** Map, parcels, agents, `me`; unit tests for decay and expiry.
3. **A\* and blind agent.** `astar.js` with tests; agent walks to the nearest
   parcel and nearest delivery tile with no scoring.
4. **Deliberation and revision.** Utility, options, intention loop with
   replacement margin. This completes the core of Part 1.
5. **Robustness.** The failure-handling table above.
6. **PDDL mover.** Domain, problem builder, solver call, fallback, `MOVER=pddl`
   flag. This completes Part 1 (external planner).
7. **Directives in the BDI agent.** Schema, validator, directive beliefs,
   user-goal options, constraint filters, forbidden tiles in both movers.
   Driven by hand-written directives, no LLM yet.
8. **LLM agent.** Provider, prompt, console, status replies. This completes
   Part 2.
9. **Tuning.** Margin, expiry times and explore strategy, measured on live
   runs.
