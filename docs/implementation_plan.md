# Implementation plan

The order in which the agent is built. What it must do is in
[project_requirement.md](project_requirement.md); how it works and why is in
[design.md](design.md). Work happens on the branch `feature/bdi-agent`.

**The goal for now is Part 1 only**: a complete BDI agent that plays as
well as we can make it. Part 2 (instructions through an LLM) waits until
Part 1 is finished; its tasks are kept at the end of this plan.

## Where we are

| Phase | Delivers | Tasks | Status |
|---|---|---|---|
| 0. Setup | Connection to the server, observations | 1 | Done |
| 1. Beliefs | The agent's picture of the world | 2, 3, 3b, 3c, 3d | Done |
| 2. Choosing what to do | Routes, and options with scores | 4, 5 | Done |
| 3. Acting | An agent that plays on its own | 6, 7 | Done |
| 4. External planner | Movement planned by PDDL | 8 | Next; meets every Part 1 requirement |
| 5. Playing well | Measured scores, tuning, better choices | 9, 10 | |
| 6. Finishing Part 1 | README with results, clean code | 11 | Part 1 complete |

## How each task is done

1. Write the tests, run them, and see them fail.
2. Write the feature until they pass.
3. Run the whole suite and the type check; both must pass.
4. Commit, and tick the task here.

If something behaves differently from what the plan expects, find out why
before changing a test. If the plan is wrong, fix it here.

**How a change to the agent's behaviour is judged.** From Phase 5 on, a
change is kept only if it raises the score. Each measurement is five
minutes on the same map and server with only that change made, and the
score is noted in the table of Task 9.

---

## Done

- **Task 1, setup.** Project, game client wrapper that never crashes the
  agent, shared types, demo scripts. What the server really does is in
  design section 9.
- **Task 2, map.** Tile types, walkable tiles, neighbours, delivery and
  spawn tiles, temporarily blocked tiles, when each tile was last seen.
- **Task 3, parcels and agents.** Parcel values estimated from decay;
  parcels and agents forgotten when their tile is seen empty; recently seen
  agents block tiles; all beliefs fed by server messages, ready once
  settings, map and position are known, every change announced.
- **Task 3b, game clock.** Times use the server's game time. Parcels the
  agent carries come from its own pickup and putdown results; delivered
  parcels are forgotten.
- **Task 3c, agents that left.** An agent is forgotten as soon as its tile
  is seen without it.
- **Task 3d, moving agents.** An agent between two tiles blocks both, and is
  forgotten only once both are seen without it.
- **Task 4, A\*.** Shortest routes that avoid walls, occupied and forbidden
  tiles; closest of several targets. A refused move is remembered and
  avoided for longer each time it is refused again.
- **Task 5, scoring and options.** A trip is worth the reward left at
  delivery. Options: pickup, deliver, explore; worthless ones dropped, the
  rest sorted best first. Energy is left out until the course staff say
  whether it is active.
- **Task 6, movement and plans.** `moveTo` walks one step at a time with a
  fresh route each step from a planner passed in (`astarRoute`), stops
  when told, records refused and unanswered moves, and gives up after three
  failures. Before each step it acts on the spot: picks up free parcels on
  its tile and puts down on a delivery tile. One plan per kind of option;
  deliver heads for the nearest delivery tile that can be reached. Tested
  against a fake game server in `test/helpers.js`.
- **Local server and pickup replies.** The course server's code is linked
  as `deliveroo-server/` and runs locally with `npm run server`. A first
  live run showed that pickup and putdown replies carry no parcel ids, so
  the beliefs now match those parcels by tile (design section 9).
- **Task 7, intentions and the agent loop.**
  - An intention runs the plan that matches its option and can be
    stopped. It fails, with a reason, when there is no plan for the
    option, the plan crashes, or the plan ends without achieving it.
  - The loop picks the best option, runs it, and starts again. When there
    is nothing to do, or the last intention failed, it waits for a change
    in the beliefs, or one second at most (a refused move stops being
    avoided without any message).
  - On every change the current intention is scored again, and the
    switching rule decides whether to keep it. A pickup whose parcel is no
    longer offered is stopped at once, unless the agent has just picked
    that parcel up on the way.
  - A parcel out of sight counts for less: its value is multiplied by the
    chance it is still there, which halves every 20 s (faster with other
    agents around). Below 20% it is not offered.
  - A parcel is skipped when another agent is closer to it and is next to
    it or moving towards it.
  - A new map means a new game, so the parcels and agents known before it
    are forgotten.
  - `npm start` runs the agent. It prints the map, every intention, and
    every 30 s the score, the warnings and how many other agents it knows.
    The observation script is removed.
  Live runs, five minutes each:

  | Server | Map | Agents | Score | Failed intentions | Warnings |
  |---|---|---|---|---|---|
  | local | `rectangles` | 1 | 2779 | 0 of 260 | |
  | course | (not logged yet) | 1 | 1885 | 0 of 176 | |
  | course | `diagonals`, 30 × 30 | 2 (ours) | 1399 + 1346 | 10 of 321 | 4 and 7 |

  With two agents, almost every failure was an explore walk that gave up
  because the other agent stood in the way. The server sends a sensing
  message after every move, which is often enough. When the server was
  stopped and started again, the agent tried a move about every three
  seconds while it was down, then reconnected and went on playing.

---

## Phase 4: External planner

Design section 5. Meets R1.4, the last Part 1 requirement.

**Task 8: PDDL mover**

Files: `src/planning/pddl/domain.pddl`, `problem.js`, `solve.js`, changes to
movement and start-up, and the tests.

The course's client `@unitn-asa/pddl-client` is already installed and its
default solver (`solver.planning.domains:5001`, planner
`dual-bfws-ffparser`) answers: on 14 November 2026 a four-tile problem
took 2.8 to 3.9 s. Only `solve.js` calls it, so the solver can be swapped
in one place.

- First measure how long the solver takes for a whole 20 × 20 and 30 × 30
  map. If that is too slow to be useful, send only the tiles in a band
  around the A\* route instead of the whole map, and say so in the design.
- Domain: movement only, one move action per direction, named "default".
- Problem from beliefs: one object per walkable tile, a connection for each
  possible step (leaving out occupied and forbidden tiles and avoided
  moves), start and goal.
- The answer becomes moves. No plan, an error or no answer within the time
  limit means "no route"; the solver is not asked when already there.
- The time limit is set from the measurement, not fixed in advance.
- The mover keeps its plan between steps and asks again only after a failed
  move or a new target. With no route it logs it and falls back to A\*.
- A setting in `.env` chooses A\* (default) or PDDL.

Tests use a fake solver and show: valid tile names; the problem's tiles,
connections, start and goal; occupied and forbidden tiles and avoided
moves left out; answers turned into moves; no call when already there; no
route on no plan, error or timeout; the agent still arriving with A\* when
the solver fails; a kept plan not sent again until a move fails or the
target changes.

- [ ] Solver time measured on a 20 × 20 and a 30 × 30 map; limit chosen
- [ ] Domain written
- [ ] Tests written and seen to fail
- [ ] Problem, solver call and mover written; suite and type check pass
- [ ] Live run with PDDL; note the score after five minutes
- [ ] Committed

---

## Phase 5: Playing well

Each item is measured as described at the top. Changes that do not raise
the score are dropped, and the result is noted either way.

**Task 9: Measure and tune**

- [ ] Baseline: five minutes with A\* and five with PDDL on the same map,
  alone and with our two agents together.
- [ ] Change one setting at a time and measure again:

| Setting | Try | Too low | Too high |
|---|---|---|---|
| Switching margin | 1.0, 1.2, 1.5 | switching back and forth | ignoring better parcels |
| First avoidance of a refused move | 1, 2, 4 s | repeated failed moves | long detours |
| How long a seen agent blocks a tile | 1, 3 s | walking into agents | avoiding empty tiles, giving up walks |
| Parcel half-life out of view | 10, 20, 40 s | forgetting real parcels | chasing taken ones |
| Failed moves before a walk gives up | 3, 5 | giving up behind a passing agent | long waits behind a blocked one |
| PDDL time limit | from Task 8 | falling back to A\* too often | long pauses |

- [ ] Energy: ask the course staff whether it is active in the evaluated
  games. If so, count its cost in the scoring (design section 9).

| Run | Map | Agents | Change | Score after 5 min |
|---|---|---|---|---|
| | | | | |

**Task 10: Better choices**

Each is built test first, then measured; kept only if the score rises.

- [ ] **Re-scoring cost.** Measure how long `listOptions` takes on a
  30 × 30 map with many parcels. If it is slow, compute the distances
  between all tiles once when the map loads and use them in scoring.
- [ ] **Several parcels per trip.** Today a pickup is scored alone, with
  what is carried. Score routes that pick up two or three nearby parcels
  before delivering, and offer the best as one option.
- [ ] **Waiting near spawn tiles** instead of exploring, on maps with few
  of them.
- [ ] **Walks blocked by another agent.** With two agents most failed
  intentions were walks giving up behind the other agent. Try waiting a
  moment before giving up, or treating the blocker's tile as a detour.

---

## Phase 6: Finishing Part 1

**Task 11: Results and clean-up**

- [ ] README: what the project is, setup, how to run the agent with A\* and
  with PDDL, the local server and the tests, code layout, reading order of
  the documents, and the results table from Task 9.
- [ ] Remove the demo scripts `follow-path.js` and `pickup-deliver.js`.
- [ ] Each Part 1 requirement shown, by a test or a live run (table below).
- [ ] Suite and type check pass; committed.

---

## Requirements coverage (Part 1)

| Requirement | Tasks | Shown by |
|---|---|---|
| R1.1 Beliefs | 2, 3, 7 | tests |
| R1.2 Deliberation and intentions | 5, 7 | tests, live run |
| R1.3 Plans | 6, 7 | tests, live run |
| R1.4 External planner | 8 | tests, PDDL live run |
| R1.5 Replanning and revision | 6, 7 | tests, live run |

---

## Later: Part 2

Not started until Part 1 is complete. Design section 6; **first** settle
the open questions at the end of that section and update the design,
requirements and this plan. The red light / green light game of
`missions_tournament` (design section 9) belongs here too, since it is
announced in chat.

**Goals and constraints in the BDI agent** (`src/llm/directives.js`,
`src/beliefs/directives.js`, changes to beliefs, options and the loop)

- Goals: go to a tile, pick up a parcel, deliver now, pause, resume.
  Constraints: avoid an area, stay in an area, minimum parcel value,
  maximum carried, clear all.
- Reject, with a reason, anything unknown, off the map, at a wall, naming
  an unknown parcel, or with a meaningless value.
- Constraints shape routes and options; pause means no options; clear
  resets everything.
- The oldest waiting goal becomes an option above all of the agent's own.
  Unreachable goals, or deliver now with nothing carried, fail with a
  reason.
- Goals are waiting, in progress, done or failed, and every change is
  announced. A stopped goal goes back to waiting.
- With no instructions, nothing changes.

**The LLM agent, with a fake LLM** (`src/llm/agent.js`)

- One tool for the LLM: a list of instructions plus a reply.
- The prompt: the LLM's role, each instruction type with an example,
  direction rules, map size, the agent's position and load, known parcels
  and delivery tiles, active instructions.
- Keep the last ten messages.
- If any instruction is invalid apply none and explain; otherwise apply all
  and pass on the reply.
- If the LLM is unreachable, skips the tool or sends something malformed,
  say so and change nothing.

**The real LLM and the console** (`src/llm/provider.js`,
`src/llm/console.js`). Checked live, no unit tests.

- LLM key and model from `.env`; give up after 30 seconds.
- A terminal prompt passes each line to the LLM agent and prints the reply;
  a status command shows active instructions without asking the LLM; goal
  changes are printed as they happen.
- The console starts only when a key is set.
- Live check: pause, resume, minimum value 20, go to the bottom-left
  corner, stay out of the top half, go to 999,999 (rejected), clear, and
  deliver now with the network off (LLM reported unreachable, the agent
  keeps playing).

| Requirement | Shown by |
|---|---|
| R2.1 Instructions from a person | live check |
| R2.2 LLM interpretation | tests, live check |
| R2.3 Goals and constraints | tests |
| R2.4 Coordination with the BDI agent | tests, live check |
