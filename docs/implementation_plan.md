# Implementation plan

The order in which the agent is built. What it must do is in
[project_requirement.md](project_requirement.md), and how it works and why
is in [design.md](design.md); this plan refers to the design's sections
rather than repeating them.

The work is split into phases. Each phase ends with something that can be
run or shown, and each one builds only on the phases before it. Within a
phase, tasks are small enough to finish, test and commit in one sitting.

## Where we are

| Phase | What it delivers | Tasks | Status |
|---|---|---|---|
| 0. Setup | A connection to the game server, and what we learned from it | 1 | Done |
| 1. Beliefs | The agent's picture of the world | 2, 3 | Done |
| 2. Choosing what to do | Routes, and options with scores | 4, 5 | Task 4 done, Task 5 next |
| 3. Acting | An agent that plays on its own | 6, 7 | |
| 4. External planner | Movement planned by PDDL | 8 | Completes Part 1 |
| 5. Instructions in the BDI agent | Goals and constraints, written by hand | 9 | |
| 6. The LLM agent | Instructions in plain language | 10, 11 | Completes Part 2 |
| 7. Tuning and results | Measured scores and the README | 12 | |

Work happens on the branch `feature/bdi-agent`.

## How each task is done

1. Write the tests the task describes, run them, and see them fail because
   the feature is missing.
2. Write the feature until they pass.
3. Run the whole test suite and the type check; both must pass.
4. Commit, and tick the task here.

If something behaves differently from what the plan expects, find out why
before changing a test. If the plan turns out to be wrong, fix the plan and
say why next to the task.

---

## Phase 0: Setup (done)

The project was set up and connected to the course server before any
decision logic was written, so that the design rests on what the server
really does rather than on documentation. What was learned is in
[design.md](design.md), section 9.

**Task 1: Set up the project and observe the server** (done)

- [x] Project created with the game library, the PDDL client and settings
  from `.env`.
- [x] A game client wrapper that never crashes the agent: a failed or
  unanswered move reports failure, a failed pickup or putdown reports no
  parcels.
- [x] The shared data types in `src/types.js`.
- [x] Demo scripts that observe the server, follow a path, and pick up and
  deliver a parcel.
- [x] Observations recorded.

---

## Phase 1: Beliefs

The agent's picture of the world ([design.md](design.md), section 1). This
phase needs no server: everything is tested with small hand-made maps.

**Task 2: Map beliefs** (done)

The map knows every tile's type, which tiles can be walked on, which tiles
are blocked for a while after a failed move, where the agent can step from
each tile (never into an arrow tile against its direction), where the
delivery and spawn tiles are, and when each tile was last in view.

- [x] 8 tests, written first and seen to fail, now passing.
- [x] Committed.

**Task 3: Parcels, other agents, and all beliefs together** (done)

Files: `src/beliefs/parcels.js`, `src/beliefs/agents.js`,
`src/beliefs/index.js`, and their tests.

What it should do:

- Turn the server's decay setting ("1s", "2s", "10s", "1m", "infinite" and
  so on) into milliseconds. "Infinite" means parcels never lose value.
- Remember each parcel's position, value, carrier and when it was seen, and
  estimate its value now: one point less per decay interval since then,
  never below zero.
- Forget a parcel when its tile is in view and the parcel is not there, or
  when its value reaches zero. Parcels being carried are not forgotten this
  way.
- List the free parcels (not carried, still worth something), and the
  parcels a given agent carries.
- Remember other agents' rounded positions and when they were seen. Only
  agents seen in the last few seconds block a tile.
- Hold everything together: the agent itself, the map, parcels and other
  agents, fed by the server's messages. Take the map size from the tiles,
  not from the server's map message, which reports one less. Round the
  agent's own position, which is fractional while it moves. Never store the
  agent itself among the other agents. Mark every tile in view as seen now.
  Block tiles holding a crate for a short time.
- Be "ready" only once the server settings, the map and the agent's own
  position are all known, and announce every change, so the agent can
  rethink.

Tests should show that:

- each decay setting becomes the right number of milliseconds, and an
  infinite one means no decay;
- a parcel loses one point per interval since it was last seen;
- free parcels leave out carried and worthless ones, and a parcel is
  forgotten when its tile is seen empty;
- the parcels carried by an agent are listed;
- only recently seen agents block tiles, at rounded positions;
- the agent's own position is rounded, and it is not counted as another
  agent;
- tiles in view are marked as seen;
- beliefs become ready only when all three pieces have arrived, and every
  update is announced.

- [x] Tests written and seen to fail (23 tests)
- [x] Parcels, agents and combined beliefs written; suite and type check
  pass
- [x] Committed

**Phase 1 is finished when** the agent's whole picture of the world can be
built from server messages and every rule above is covered by a test.

---

## Phase 2: Choosing what to do

Routes, and the scoring that decides what is worth doing
([design.md](design.md), sections 2 and 4). Still no server needed.

**Task 4: A\* path finding** (done)

File: `src/planning/astar.js`, and its tests.

What it should do:

- Find a shortest route between two tiles as a list of moves. The route is
  empty when the agent is already there, and there is no route when the
  target cannot be reached.
- Follow the map's neighbours, so walls, blocked tiles and one-way tiles
  are respected.
- Never enter a tile where an agent was recently seen, or a tile a user
  constraint forbids (Phase 5), not even as the target.
- Given several targets, find the closest one that can be reached, and the
  route to it.

Tests should show: an empty route when already there; the obvious route in
a straight line; a shortest detour around a wall; no route to an
unreachable tile; occupied and forbidden tiles avoided, including as the
target; the closest of several targets picked; and nothing returned when
no target can be reached.

- [x] Tests written and seen to fail (13 tests)
- [x] A\* written; suite and type check pass
- [x] Committed

**Task 5: Scoring and options**

Files: `src/deliberation/utility.js`, `src/deliberation/options.js`, and
their tests.

What it should do:

- Score a trip by the reward expected at delivery: every parcel involved
  loses value for each decay interval the whole trip takes, down to zero,
  and the score is what is left. A move takes the time the server's
  settings say.
- Offer a **pickup** for each free parcel while the agent has room, when the
  parcel can be reached and a delivery tile can be reached from it. The trip
  is the walk to the parcel plus the walk on to the nearest delivery tile.
- Offer **deliver** while the agent carries something and a delivery tile
  can be reached.
- Offer **explore** towards the reachable spawn tile seen longest ago, worth
  zero, only among spawn tiles from which a delivery tile can still be
  reached, so the agent never walks into a one-way dead end (design.md
  section 9).
- Drop other options worth nothing, sort the rest best first, and give each
  a short name so the same option can be recognised later.

Tests should show: decay applied to every parcel for the whole trip; values
stopping at zero, and no decay when it is switched off; the more rewarding
parcel ranked first even when it is further away; deliver offered only
while carrying; no pickup at full capacity; explore heading for the spawn
tile seen longest ago, and never to one with no way on to a delivery tile;
and unreachable parcels, delivery tiles and parcels that could not be
delivered producing no options and no crash.

- [ ] Tests written and seen to fail
- [ ] Scoring and options written; suite and type check pass
- [ ] Committed

**Phase 2 is finished when**, given any set of beliefs, the agent can list
what it could do and how much each option is worth.

---

## Phase 3: Acting

Turning the chosen option into moves, switching when something clearly
better appears, and recovering from failures ([design.md](design.md),
sections 3 and 4). At the end of this phase the agent plays on its own.

**Task 6: Movement and plans**

Files: `src/plans/moveTo.js`, `src/plans/library.js`, a fake game server
added to the test helpers, and the tests.

What it should do:

- Walk to a target one step at a time, planning a fresh route before every
  step and taking only its first move. The route planner is passed in, so
  A\* or PDDL can be used.
- Stop when told to, before each step.
- After a failed or unanswered move, block that tile for a short time and
  try another route; give up after three failures.
- Provide one plan for each kind of option: go to a tile; pick up (walk
  there, pick up, and forget the parcel and fail if it is gone); deliver
  (walk there, put down, and forget the delivered parcels); explore (walk
  there).

The fake game server moves the agent in its beliefs, and can be told to
make moves fail or go unanswered on chosen tiles, and what a pickup
returns.

Tests should show: the agent reaches its target; it stops when told; a
failing tile is blocked and walked around; it gives up when the only route
keeps failing; an unanswered move counts as a failure without crashing;
pickup and deliver walk first and then act; a parcel someone else took
makes pickup fail and is forgotten; and every kind of option has exactly
one plan.

- [ ] Fake game server added
- [ ] Tests written and seen to fail
- [ ] Movement and plans written; suite and type check pass
- [ ] Committed

**Task 7: Intentions and the agent loop**

Files: `src/intentions/intention.js`, `src/intentions/revision.js`,
`src/index.js`, and their tests. The observation demo script is removed.

What it should do:

- An intention holds one option, runs the plan for it, and can be stopped.
  It fails when no plan fits or the plan crashes.
- Decide whether to switch to a new option: never without a better option;
  always when idle; never to the same option; always to a higher priority
  and never to a lower one; otherwise only when the new option is worth
  more than the current one times the margin and at least one point more.
- The loop waits until beliefs are ready, commits to the best option,
  carries it out, and repeats; with no options it waits for beliefs to
  change.
- On every change in beliefs, score the current intention again with fresh
  values, compare it with the best option, and stop it if the switching
  rule says so.
- The start-up file connects to the server, feeds every message into
  beliefs, builds the plans with the chosen mover, and starts the loop.

Tests should show each rule of the switching decision on its own, that an
intention runs the plan that fits, that it fails when none fits or the plan
crashes, and that a running plan notices when its intention is stopped.

- [ ] Tests written and seen to fail
- [ ] Intentions and loop written; suite and type check pass
- [ ] Start-up file written; observation script removed
- [ ] Live run: within two minutes the agent picks up and delivers on its
  own, its score rises, and the log shows it switching when a clearly
  better parcel appears. Note the score after five minutes.
- [ ] Turn the network off and on: the agent reconnects and carries on.
- [ ] Committed

**Phase 3 is finished when** the agent plays a full game on the course
server without help.

---

## Phase 4: External planner

Planning movement with an online PDDL planner ([design.md](design.md),
section 5). This completes Part 1.

**Before starting:** check that the online solver can be reached from your
network and answers within a few seconds. If it cannot, ask the course
staff for another solver address.

**Task 8: PDDL mover**

Files: `src/planning/pddl/domain.pddl`, `src/planning/pddl/problem.js`,
`src/planning/pddl/solve.js`, changes to the movement and start-up files,
and the tests.

What it should do:

- The domain describes movement only: the agent is at a tile, tiles are
  connected in four directions, and one move action exists per direction.
  It must be named "default", the name the planner library always uses.
- The problem is built from beliefs: one object per walkable tile, a
  connection for each possible step (leaving out tiles with agents or
  forbidden by constraints), where the agent is, and where it should be.
- The solver's answer is turned back into moves. No plan, an error, or no
  answer within five seconds all count as "no route". If the agent is
  already at the target, the solver is not asked.
- The PDDL mover keeps its plan between steps and asks again only after a
  failed move or a new target. When the solver gives no route, it says so
  in the log and A\* plans the route instead.
- A setting in `.env` chooses A\* (the default) or PDDL.

Tests use a fake solver and should show: valid tile names; a problem
listing the tiles, connections, start and goal; connections matching the
map and leaving out occupied and forbidden tiles; solver answers turned into
moves; no solver call when already there; no route on no plan, error or
timeout; and the agent still arriving, with A\*, when the solver fails.

- [ ] Solver reachability checked
- [ ] Domain written
- [ ] Tests written and seen to fail
- [ ] Problem, solver call and PDDL mover written; suite and type check
  pass
- [ ] Live run with PDDL: the log shows solver requests and the agent
  plays; note the score after five minutes
- [ ] Committed

**Phase 4 is finished when** the agent can play with either mover, chosen by
a setting, and never stalls when the solver fails.

---

## Phase 5: Instructions in the BDI agent

Teaching the BDI agent to follow goals and respect constraints, written by
hand, before any LLM is involved ([design.md](design.md), section 6).

**Before starting:** Part 2 has not been discussed in detail yet. Go
through the open questions at the end of design section 6 (where
instructions come from, which ones to support, one program or two), update
the design and the requirements, and adjust this phase and the next to
match. The task below follows the current first version.

**Task 9: Goals and constraints**

Files: `src/llm/directives.js`, `src/beliefs/directives.js`, changes to
beliefs, options and the agent loop, and the tests.

What it should do:

- Accept goals (go to a tile, pick up a given parcel, deliver now, pause,
  resume) and constraints (avoid an area, stay in an area, a minimum parcel
  value, a maximum number carried, clear everything).
- Check every instruction against the beliefs and reject, with a reason,
  any that is unknown, points off the map or at a wall, names a parcel the
  agent does not know, or has a meaningless value. Areas are put in order
  and must overlap the map.
- Apply constraints: forbidden tiles for routes and options, cheap parcels
  ignored, a lower carrying limit, no options at all while paused, and
  everything reset by "clear".
- Turn the oldest waiting goal into an option with higher priority than any
  of the agent's own. A goal that cannot be reached, or "deliver now" with
  nothing carried, is marked failed with a reason.
- Track each goal as waiting, in progress, done or failed, and announce
  every change. A stopped goal goes back to waiting.
- With no instructions, nothing changes.

Tests should show: valid instructions accepted and areas put in order;
invalid ones rejected with a reason; options unchanged with no
instructions; a goal outranking a valuable parcel; unreachable goals and
"deliver now" with nothing carried marked failed; each constraint having
its effect; pause, resume and clear working; and goal changes announced.

- [ ] Part 2 questions settled; design, requirements and plan updated
- [ ] Tests written and seen to fail
- [ ] Goals and constraints written; suite (including every earlier test)
  and type check pass
- [ ] Live run: a hand-written pause after 20 seconds and resume after 30
  stop and restart the agent (remove the temporary change afterwards)
- [ ] Committed

**Phase 5 is finished when** hand-written instructions change what the
agent does, and the agent with no instructions plays exactly as before.

---

## Phase 6: The LLM agent

Letting a person give instructions in plain language
([design.md](design.md), section 6). This completes Part 2.

**Task 10: The LLM agent, with a fake LLM**

File: `src/llm/agent.js`, and its tests. No network needed.

What it should do:

- Give the LLM one tool: a list of instructions plus a reply for the user.
- Build the prompt: the LLM's role (it turns requests into instructions and
  never moves the agent), each instruction type with an example, the
  direction rules, the map size, the agent's position and load, the known
  parcels and delivery tiles, and the instructions already active.
- Keep the last ten messages of the conversation.
- Check every instruction first; if any is invalid, apply none and explain
  each problem. Otherwise apply them all and pass on the LLM's reply.
- If the LLM cannot be reached, answers without the tool, or sends
  something malformed, say so and change nothing.

Tests use a fake LLM and should show each of those cases.

- [ ] Tests written and seen to fail
- [ ] LLM agent written; suite and type check pass
- [ ] Committed

**Task 11: The real LLM and the console**

Files: `src/llm/provider.js`, `src/llm/console.js`, and changes to the
settings and start-up file. The LLM connection has no unit tests; it is
checked live.

**Before starting:** choose the LLM and get a key (the course lab uses the
university's OpenAI-compatible service).

What it should do:

- Read the LLM key and model from `.env`.
- Send the prompt, the conversation and the tool to the LLM, ask it to use
  the tool, and hand back what it returned. Give up after 30 seconds.
- Show a prompt in the terminal, pass each line to the LLM agent and print
  the reply. A status command shows active instructions and goals without
  asking the LLM. Print every goal change as it happens.
- Start the console only when an LLM key is set, and keep the agent's own
  logging quiet enough not to bury it.

Live check, comparing with the game view:

| Type | Expect |
|---|---|
| stop for a moment | the agent stops; status shows it paused |
| carry on | it moves again |
| only take parcels worth at least 20 | cheaper parcels are ignored |
| go to the bottom-left corner | it walks there and the console reports done |
| stay out of the top half of the map | it never goes there |
| go to 999, 999 | the reply says the tile does not exist; nothing changes |
| forget all of that | back to normal |
| deliver now, with the network off | the LLM is reported unreachable; the agent keeps playing |

- [ ] LLM chosen and key obtained
- [ ] Settings, LLM connection and console written
- [ ] Live check passed
- [ ] Suite and type check pass; committed

**Phase 6 is finished when** a person can steer the agent in plain language
and always hears back what happened.

---

## Phase 7: Tuning and results

Measuring the finished agent, improving its settings, and writing up the
results.

**Task 12: Tune and document**

- [ ] Measure first: five minutes with A\* and five with PDDL on the same
  map, scores noted.
- [ ] Change one setting at a time and measure again after each:

| Setting | Try | Too low | Too high |
|---|---|---|---|
| Switching margin | 1.0, 1.2, 1.5 | switching back and forth | ignoring much better parcels |
| How long a failed tile stays blocked | 1, 2, 4 s | repeated failed moves | long detours |
| How long a seen agent blocks a tile | 1, 3 s | walking into agents | avoiding empty tiles |
| PDDL time limit | 2, 5 s | falling back to A\* too often | long pauses |

- [ ] Rewrite the README: what the project is, how to set it up, how to
  run each mode and the tests, how the code is organised, the reading
  order of the documents, and a results table (A\* and PDDL scores and the
  map used) with the list of supported instructions.
- [ ] Suite and type check pass; committed.

**Phase 7 is finished when** the README shows measured results and the
settings are the best ones found.

---

## How the plan covers the requirements

| Requirement | Tasks | Shown by |
|---|---|---|
| R1.1 Beliefs | 2, 3 | tests |
| R1.2 Deliberation and intentions | 5, 7 | tests and the live run in Task 7 |
| R1.3 Plans | 6, 7 | tests and the live run in Task 7 |
| R1.4 External planner | 8 | tests and the PDDL live run |
| R1.5 Replanning and revision | 6, 7 | tests and the live run in Task 7 |
| R2.1 Instructions from a person | 11 | live check |
| R2.2 LLM interpretation | 10, 11 | tests with a fake LLM and the live check |
| R2.3 Goals and constraints | 9, 10 | tests |
| R2.4 Coordination with the BDI agent | 9, 10, 11 | tests and the live check |
