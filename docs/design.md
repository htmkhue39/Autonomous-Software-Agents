# Deliveroo.js BDI agent: design

Updated: 2026-10-18. Requirements: [project_requirement.md](project_requirement.md).
Server facts and open items: [server_notes.md](server_notes.md).
Plan: [implementation_plan.md](implementation_plan.md).

## Key ideas

The words used in the rest of this document.

| Term | Meaning | In this game |
|---|---|---|
| **Beliefs** | What the agent thinks is true. They can be out of date or wrong. | "A parcel worth about 18 is at (4,2)." "Tile (2,0) is a wall." |
| **Desires (options)** | Things the agent could do right now, each with a score. | Pick up a given parcel, deliver what it carries, explore. |
| **Intention** | The one option the agent has committed to and is working on. | "I am going to pick up the parcel at (4,2)." |
| **Plan** | A recipe that achieves an intention. | "Walk to the tile, then pick up." |
| **Agent loop** | The cycle repeated all game long: sense → update beliefs → list and score options → keep or switch intention → act. | One step per move. |
| **A\*** | Finds the shortest route on a grid. It tries first the tiles whose "steps so far plus a straight-line guess of steps left" is smallest. | Route around walls and other agents. |
| **PDDL** | A language for describing a planning problem to a general solver: a domain (the rules, written once) and a problem (this situation, rebuilt each time). The solver returns a sequence of actions. | "Agent at (3,1), goal (7,4)" → "right, right, up…". |
| **Directive** | An instruction from the user, checked and turned into a goal or a constraint for the BDI agent. | "Go to (0,0)", "ignore parcels worth less than 20". |

## Design decisions and reasons

Each decision lists the options that were considered, the choice, and the
reason in one line.

### 1. Commitment: when to reconsider the intention

- Considered: never mid-way (finish first); always switch to the best
  option; switch only when a new option is clearly better.
- **Chosen: switch only when a new option is clearly better**, meaning
  better by a margin (starting at 20%, and at least one point). The
  margin is tuned in live runs.
- **Why:** it avoids changing its mind back and forth over small
  differences, but still switches when something is clearly worth it.

### 2. Scoring: how options are compared

- Considered: nearest parcel first; most valuable parcel first; the reward
  expected at delivery.
- **Chosen: the reward expected at delivery.** Every parcel involved (the
  ones carried and the one to pick up) loses value for each decay interval
  the whole trip takes, down to zero; the score is the sum. Delivering is
  scored the same way, so the agent decides by itself when to stop
  collecting and deliver.
- **Why:** it accounts for both reward and distance, and so for time, which
  is what makes parcels lose value.

### 3. Exploring: what to do when there is nothing to pick up

- Considered: random walk; farthest spawn tile; spawn tile seen longest
  ago.
- **Chosen: the reachable spawn tile seen longest ago.** Beliefs keep, for
  each tile, the last time it was in view. Exploring scores zero, so any
  real option replaces it.
- **Why:** it covers the whole map systematically.

### 4. Moving: how a route is followed

- Considered: plan the whole route once and follow it; plan again before
  every step.
- **Chosen: plan again with A\* before every step**, using current beliefs,
  and take only the first step.
- **Why:** it always uses the latest information. A\* on a 20 × 20 map takes
  well under a millisecond, so the repeated work costs nothing.

### 5. Failed moves: how the agent recovers

- Considered: retry the same move; block the tile briefly and plan again;
  give up the intention at once.
- **Chosen: block the tile for a short time (about 2 s) and plan again.**
  After a few failures (about 3) the intention is dropped and the agent
  deliberates again. A move the server does not answer in time counts as a
  failed move.
- **Why:** the agent learns from the failure (it becomes a belief) and
  finds a detour, instead of paying a point for every retry.

### 6. External planner: what PDDL plans

- Considered: movement only; the whole task (pickups and deliveries in
  order); both.
- **Chosen: movement only.** PDDL replaces A\* for routes when the mover
  setting says so. Because the solver is slow (an internet call taking up
  to seconds), the PDDL mover keeps its plan and asks again only after a
  failed move or a change of target. If the solver fails or takes longer
  than 5 s, A\* is used for that route.
- **Why:** deliberation decides *what* to do and planners decide *how* to
  get there, so the two never compete. Problems stay small and fast, the
  agent never stalls, and A\* and PDDL can be compared fairly on the same
  agent.

### Part 2 decisions: not yet discussed

The Part 2 design below is kept from the first version and still has to be
gone through step by step: where instructions come from (terminal only, or
in-game chat too), which goals and constraints to support, whether the LLM
agent runs in the same program or as a separate game agent, and which LLM
to use.

### Fixed choices

| Topic | Choice |
|---|---|
| Language | Plain JavaScript, ES modules, JSDoc types |
| Game client | `@unitn-asa/deliveroo-js-sdk` 1.3.10 with `socket.io-client` |
| Planner client | `@unitn-asa/pddl-client` 1.7.7, online solver at `solver.planning.domains:5001` |
| LLM provider | Open; only one file talks to it, so it can be swapped |
| Out of scope | Two-agent team, modelling opponents, tuning for one map, the report |

## Architecture

One Node process per agent, running sense → believe → deliberate → act:

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
| `config.js` | Server address, token, mover choice (A\* or PDDL), LLM settings, tuning values. Read from `.env`. | none |
| `client.js` | Thin wrapper over the SDK: connects, passes server events on to beliefs, and offers move, pick up and put down. The only file that uses the SDK. | SDK |
| `beliefs/map.js` | Tiles by type: wall, parcel spawner, delivery, walkable, base, crate tiles, one-way arrows. Neighbours that respect arrows. Tiles blocked for a while after a failed move. When each tile was last in view (for exploring). | none |
| `beliefs/parcels.js` | Known parcels: position, reward, carrier, last seen. Value estimated from the server's decay interval. A parcel is forgotten when its tile is in view without it, or when its value reaches zero. | config |
| `beliefs/agents.js` | Other agents' last known position and time. | none |
| `beliefs/index.js` | All beliefs together: the agent itself, the map, parcels, agents. Updated by server events. | above |
| `deliberation/utility.js` | Reward expected at delivery (decision 2). | none |
| `deliberation/options.js` | Lists the options (pick up a parcel, deliver, explore) with their scores. | utility, astar |
| `intentions/intention.js` | One intention: runs the plan that handles it, can be stopped. | plans |
| `intentions/revision.js` | The agent loop. Keeps the current intention and replaces it when a new option is clearly better (decision 1). | options, intention |
| `plans/` | Go to, pick up, deliver, explore, and step-by-step movement with either mover (decisions 4, 5). | planning, client |
| `planning/astar.js` | A\* on the believed map; other agents and blocked tiles are obstacles. | map |
| `planning/pddl/domain.pddl` | Movement domain: the agent is at a tile, tiles connect in four directions, one move action per direction. | none |
| `planning/pddl/problem.js` | Builds the PDDL problem from the believed map, the agent's tile and the goal tile. | map |
| `planning/pddl/solve.js` | Sends domain and problem to the online solver with a timeout, and turns the reply into directions. | pddl-client |
| `index.js` | Wires everything together and starts the loop. | all |

### Part 2: LLM agent (to be discussed)

| Unit | Responsibility | Depends on |
|---|---|---|
| `llm/directives.js` | The list of allowed directives and their checks. Goals: go to a tile, pick up a parcel, deliver now, pause, resume. Constraints: avoid an area, stay in an area, minimum parcel reward, maximum parcels carried, clear. Rejects anything else, or anything off the map. | map |
| `llm/provider.js` | The only file that talks to the LLM. Sends the instructions, the conversation and the description of the directive tool; returns structured output. | LLM SDK |
| `llm/agent.js` | The LLM agent: builds the prompt from a short summary of beliefs, asks for directives, checks them, hands them to the BDI agent, and turns status reports into replies. | provider, directives |
| `llm/console.js` | Terminal prompt where the user types instructions and reads replies. | agent |
| `beliefs/directives.js` | Active directives held as beliefs, and each user goal's status (pending, active, done, failed and why). | none |

How the BDI agent uses directives:

- **User goals** become options with priority above autonomous ones. They
  go through the same intention revision, so the agent still replans
  around obstacles and reports failure if a goal is unreachable.
- **Constraints** filter the options (reward threshold, carry limit, area)
  and forbid tiles for both A\* and PDDL.
- **Autonomy is kept.** With no directives the agent behaves exactly as in
  Part 1. The LLM never moves the agent.
- **Speed.** The LLM is called only when the user types, never inside the
  agent loop.

## Failure handling

| Failure | Response |
|---|---|
| A move fails or is not answered in time | Block the tile briefly and plan again; drop the intention after a few failures (decision 5) |
| The PDDL solver fails or is too slow | Use A\* for that route and log it (decision 6) |
| No route | Drop the option; leave that target out for a short time |
| Parcel gone on arrival | Forget the parcel and deliberate again |
| The LLM returns something invalid | Reject it, keep the current directives, tell the user what was not understood |
| The LLM cannot be reached | Keep the current directives; the agent carries on; report it in the console |
| A user goal cannot be reached | Mark it failed with the reason, tell the user, go back to autonomous behaviour |
| Disconnected | The SDK reconnects; beliefs rebuild from the events that follow |

## Testing

- Unit tests with Node's test runner for everything that does not need the
  server: the map, parcel decay and expiry, A\*, scoring, options,
  exploring, movement and plans against a fake game client, intention
  revision, the PDDL problem, directive checks and the effect of each
  constraint.
- The LLM agent is tested with a fake LLM that returns prepared answers.
- Live runs on the game server: with A\*, with PDDL, and with a fixed list
  of typed instructions. A\* and PDDL scores are compared over the same
  time on the same map.

## Build order

The phases and tasks are in [implementation_plan.md](implementation_plan.md).
