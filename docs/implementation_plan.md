# Implementation plan

The order in which the agent is built. What it must do is in
[project_requirement.md](project_requirement.md); how it works and why is in
[design.md](design.md). Work happens on the branch `feature/bdi-agent`.

## Where we are

| Phase | Delivers | Tasks | Status |
|---|---|---|---|
| 0. Setup | Connection to the server, observations | 1 | Done |
| 1. Beliefs | The agent's picture of the world | 2, 3, 3b, 3c, 3d | Done |
| 2. Choosing what to do | Routes, and options with scores | 4, 5 | Done |
| 3. Acting | An agent that plays on its own | 6, 7 | Task 7 next |
| 4. External planner | Movement planned by PDDL | 8 | Completes Part 1 |
| 5. Instructions in the BDI agent | Hand-written goals and constraints | 9 | |
| 6. The LLM agent | Instructions in plain language | 10, 11 | Completes Part 2 |
| 7. Tuning and results | Measured scores and the README | 12 | |

## How each task is done

1. Write the tests, run them, and see them fail.
2. Write the feature until they pass.
3. Run the whole suite and the type check; both must pass.
4. Commit, and tick the task here.

If something behaves differently from what the plan expects, find out why
before changing a test. If the plan is wrong, fix it here.

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

---

## Phase 3: Acting

Design sections 3 and 4. At the end of this phase the agent plays on its
own.

**Task 7: Intentions and the agent loop**

Files: `src/intentions/intention.js`, `src/intentions/revision.js`,
`src/index.js`, changes to `src/beliefs/parcels.js` and
`src/deliberation/options.js`, and the tests. The observation demo script
is removed.

- An intention holds one option, runs its plan, and can be stopped. It
  fails when no plan fits or the plan crashes.
- Switching rule: never without a better option; always when idle; never to
  the same option; always to a higher priority, never to a lower one;
  otherwise only when the new option is worth more than the current one
  times the margin and at least one point more.
- The loop waits until beliefs are ready, commits to the best option,
  carries it out, and repeats; with no options it waits for a change.
- On every change, re-score the current intention and stop it if the
  switching rule says so.
- Stop a pickup at once when its parcel is no longer free. The switching
  rule alone would keep it: a dead pickup and exploring are both worth 0.
- Parcels out of view fade: weight a parcel's expected reward by the chance
  it still exists, which falls with the time since it was seen and the
  number of agents around. Without this, a parcel seen once stays a target
  until its value reaches zero, which is forever when parcels never decay.
- Skip a parcel we are bound to lose: drop the pickup option when another
  agent is closer to the parcel and is one step away or moving towards it.
- Start-up connects, feeds messages into beliefs, builds the plans with the
  chosen mover, and starts the loop.
- Every message announces a change. Sensing comes only when something
  changes, which may be rare enough; check in the live run, and re-score at
  most once per frame if it is not.

Tests show each switching rule on its own; a pickup stopped when its parcel
is taken or vanishes; a parcel unseen for long ranked below a fresh one
of equal value and dropped once its chance is low; a pickup dropped when a
closer agent heads for the parcel, and kept when it heads away; an
intention running the right plan, failing when none fits or the plan
crashes; a running plan noticing it was stopped.

- [ ] Tests written and seen to fail
- [ ] Intentions and loop written; suite and type check pass
- [ ] Start-up file written; observation script removed
- [ ] Live run: within two minutes the agent picks up and delivers on its
  own and switches when a clearly better parcel appears. Note the score
  after five minutes.
- [ ] Network off and on: the agent reconnects and carries on
- [ ] Committed

---

## Phase 4: External planner

Design section 5. Completes Part 1.

**Task 8: PDDL mover**

Files: `src/planning/pddl/domain.pddl`, `problem.js`, `solve.js`, changes to
movement and start-up, and the tests.

- Domain: movement only, one move action per direction, named "default".
- Problem from beliefs: one object per walkable tile, a connection for each
  possible step (leaving out occupied and forbidden tiles), start and goal.
- The answer becomes moves. No plan, an error or no answer within five
  seconds means "no route"; the solver is not asked when already there.
- The mover keeps its plan between steps and asks again only after a failed
  move or a new target. With no route it logs it and falls back to A\*.
- A setting in `.env` chooses A\* (default) or PDDL.

Tests use a fake solver and show: valid tile names; the problem's tiles,
connections, start and goal; occupied and forbidden tiles left out; answers
turned into moves; no call when already there; no route on no plan, error
or timeout; the agent still arriving with A\* when the solver fails.

- [ ] Solver reachable and fast enough from our network
- [ ] Domain written
- [ ] Tests written and seen to fail
- [ ] Problem, solver call and mover written; suite and type check pass
- [ ] Live run with PDDL; note the score after five minutes
- [ ] Committed

---

## Phase 5: Instructions in the BDI agent

Design section 6. **First** settle the open questions at the end of that
section and update the design, requirements and this plan.

**Task 9: Goals and constraints**

Files: `src/llm/directives.js`, `src/beliefs/directives.js`, changes to
beliefs, options and the loop, and the tests.

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

- [ ] Part 2 questions settled; documents updated
- [ ] Tests written and seen to fail
- [ ] Goals and constraints written; suite and type check pass
- [ ] Live run: a hand-written pause and resume stop and restart the agent
- [ ] Committed

---

## Phase 6: The LLM agent

Design section 6. Completes Part 2.

**Task 10: The LLM agent, with a fake LLM** (`src/llm/agent.js`)

- One tool for the LLM: a list of instructions plus a reply.
- The prompt: the LLM's role, each instruction type with an example,
  direction rules, map size, the agent's position and load, known parcels
  and delivery tiles, active instructions.
- Keep the last ten messages.
- If any instruction is invalid apply none and explain; otherwise apply all
  and pass on the reply.
- If the LLM is unreachable, skips the tool or sends something malformed,
  say so and change nothing.

- [ ] Tests written and seen to fail
- [ ] LLM agent written; suite and type check pass
- [ ] Committed

**Task 11: The real LLM and the console** (`src/llm/provider.js`,
`src/llm/console.js`). Checked live, no unit tests.

- LLM key and model from `.env`; give up after 30 seconds.
- A terminal prompt passes each line to the LLM agent and prints the reply;
  a status command shows active instructions without asking the LLM; goal
  changes are printed as they happen.
- The console starts only when a key is set.

Live check: pause, resume, minimum value 20, go to the bottom-left corner,
stay out of the top half, go to 999,999 (rejected), clear, and deliver now
with the network off (LLM reported unreachable, the agent keeps playing).

- [ ] LLM chosen and key obtained
- [ ] Settings, connection and console written
- [ ] Live check passed
- [ ] Suite and type check pass; committed

---

## Phase 7: Tuning and results

**Task 12: Tune and document**

- [ ] Five minutes with A\* and five with PDDL on the same map; note scores
- [ ] Change one setting at a time and measure again:

| Setting | Try | Too low | Too high |
|---|---|---|---|
| Switching margin | 1.0, 1.2, 1.5 | switching back and forth | ignoring better parcels |
| First avoidance of a refused move | 1, 2, 4 s | repeated failed moves | long detours |
| How long a seen agent blocks a tile | 1, 3 s | walking into agents | avoiding empty tiles |
| PDDL time limit | 2, 5 s | falling back to A\* too often | long pauses |

- [ ] Measure how long re-scoring takes on a big map with many parcels; if
  it is slow, compute distances between all tiles once when the map loads
- [ ] Try waiting near spawn tiles instead of exploring on maps with few
  of them; keep it only if the score improves
- [ ] README: what the project is, setup, how to run each mode and the
  tests, code layout, reading order of the documents, results table, and
  the supported instructions
- [ ] Suite and type check pass; committed

---

## Requirements coverage

| Requirement | Tasks | Shown by |
|---|---|---|
| R1.1 Beliefs | 2, 3 | tests |
| R1.2 Deliberation and intentions | 5, 7 | tests, live run |
| R1.3 Plans | 6, 7 | tests, live run |
| R1.4 External planner | 8 | tests, PDDL live run |
| R1.5 Replanning and revision | 6, 7 | tests, live run |
| R2.1 Instructions from a person | 11 | live check |
| R2.2 LLM interpretation | 10, 11 | tests, live check |
| R2.3 Goals and constraints | 9, 10 | tests |
| R2.4 Coordination with the BDI agent | 9, 10, 11 | tests, live check |
