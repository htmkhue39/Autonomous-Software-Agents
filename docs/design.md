# How the agent works

This document follows the agent through one turn of its decision loop and
explains each choice made along the way, with the alternatives that were
turned down. What the agent must do is in
[project_requirement.md](project_requirement.md); the build order is in
[implementation_plan.md](implementation_plan.md).

## Key ideas

| Term | Meaning | In this game |
|---|---|---|
| **Beliefs** | What the agent thinks is true. They can be out of date or wrong. | "A parcel worth about 18 is at (4,2)." |
| **Desires**, or options | Things the agent could do right now, each with a score. | Pick up a given parcel, deliver what it carries, explore. |
| **Intention** | The one option the agent has committed to and is working on. | "I am going to pick up the parcel at (4,2)." |
| **Plan** | A recipe that achieves an intention. | "Walk to the tile, then pick up." |
| **Agent loop** | The cycle repeated all game: sense, update beliefs, list and score options, keep or switch intention, act. | One pass per move. |
| **A\*** | The standard way to find a shortest route on a grid. | A route around walls and other agents. |
| **PDDL** | A language for describing a planning problem to a general-purpose planner. | "The agent is at (3,1); get it to (7,4)." |
| **Directive** | A user instruction, checked and turned into a goal or a constraint. | "Go to (0,0)", "ignore parcels worth less than 20". |

## The loop at a glance

```
        ┌──────────────────────────────────────────────────────┐
        ▼                                                      │
   SENSE        the server reports what the agent can see
        │
   BELIEVE      update the picture of the world              (section 1)
        │
   DELIBERATE   list the options and score each one          (section 2)
        │
   COMMIT       keep the current intention or switch         (section 3)
        │
   ACT          take the next step of the plan               (sections 4, 5)
        └──────────────────────────────────────────────────────┘
```

The server does not wait for the agent. It sends news whenever something
changes, including while the agent is walking, so beliefs are updated in
the background and the agent decides how often to rethink.

## 1. What the agent believes

The agent keeps four kinds of belief, all updated from what the server
reports:

- **The map.** Every tile and its type. On top of the fixed map, the agent
  remembers two things that change: tiles it should avoid for a while
  because a move into them just failed (section 4), and when each tile was
  last in view (used for exploring, section 2).
- **Parcels.** Where each parcel is, what it was worth when last seen, and
  who carries it. The agent does not see a parcel all the time, so it
  *estimates* its current value: the last seen value minus one point per
  decay interval since then (one second on the course server; the interval
  comes from the server's settings). A parcel is forgotten when its
  estimated value reaches zero, or when the agent looks at the tile where
  it was last seen and it is not there. That rule holds for a parcel
  another agent carries too: it has moved on with its carrier or been
  delivered, and either way the agent cannot use it. The parcels the agent
  carries itself are known from its own pickup and putdown results, so
  they do not depend on what sensing reports; parcels it delivers are
  forgotten right after the putdown.
- **Other agents.** Where each was last seen and when. A tile where an
  agent was seen in the last few seconds counts as blocked; after that the
  agent has probably moved on. An agent seen between two tiles, at a
  fractional position, blocks both: until its move finishes it holds the
  tile it is leaving as well as the one it is entering. As with parcels,
  an agent is forgotten sooner if the agent looks at the tiles where it
  was last seen and it is not there.
- **Itself.** Position, score and the parcels it carries.

They are *beliefs*, not facts, because they can be wrong: a parcel seen ten
seconds ago may already have been taken. The rest of the design is built to
cope with that.

**Time is the server's game time.** Parcel values change on the server's
clock, so every time in the beliefs (when a parcel or agent was seen, how
long a move stays avoided) is measured on it. Sensing messages and pings
carry the server's frame number, and the frame times the server's `CLOCK`
(milliseconds per frame) gives the game time. Between messages the local
clock carries it forward. The local clock alone would drift from the
server's whenever messages are delayed, and the server can be slow: it
once took 17 seconds to answer.

## 2. What the agent could do, and what each option is worth

At any moment the agent has three kinds of option:

- **Pick up** a particular parcel it knows about, if it has room to carry
  it.
- **Deliver** what it carries to the nearest delivery tile.
- **Explore**, when there is nothing better to do.

To choose, the agent needs a number for each option. The obvious rules
don't work well. Going for the *nearest* parcel chases cheap ones. Going
for the *most valuable* walks across the map for a parcel that has lost
most of its value by the time it is delivered.

So each option is scored by **the reward the agent expects when the
parcels are finally delivered**: every parcel involved (the ones it
carries plus the one it would pick up) loses value for the whole trip,
from here to the parcel and on to the nearest delivery tile. The score is
what is left.

An example. Parcel p1 is worth 10 and is 2 steps away. Parcel p2 is worth
30 and is 12 steps away. Both are 5 steps from a delivery tile. Nearest-first
picks p1 and earns about 9; expected reward sees that p2 still earns about
27 after its longer trip, and picks p2.

This rule also decides **when to deliver**, with no extra logic. Delivering
is just another option, scored the same way. When the agent carries
several parcels, every detour costs it decay on all of them, so "deliver
now" soon becomes the best option. When it carries little and a good parcel
is nearby, collecting wins.

**Exploring.** With no parcel in sight, every pickup scores zero. Standing
still wastes time, and wandering at random revisits the same places. The
agent heads instead for the **spawn tile it has not seen for the longest
time**: where its information is oldest, a new parcel is most likely to be
waiting unnoticed. Exploring always scores zero, so any real option takes
over the moment one appears.

Options that cannot be reached are simply left out. If nothing at all can
be reached, the list is empty and the agent waits for its beliefs to
change.

## 3. When the agent changes its mind

Picking the best option is only half the story; the agent must also decide
when to *drop* the intention it is working on. Two extremes fail:

- Never changing until the intention is finished keeps the agent walking
  towards a parcel someone else has just taken, or past a much better one.
- Always switching to whatever scores highest makes it turn back and forth
  over tiny differences and waste moves.

The agent therefore **switches only when a new option is clearly better**:
worth more than the current one by a margin (20% to start with) and by at
least one point. The second condition stops it hopping between options
that are all worth zero, such as two places to explore. The margin is
tuned in live runs.

Every time beliefs change, the current intention is scored again with
fresh values (its parcel may have lost value or vanished) and compared with
the best option. An intention to pick up a parcel that is gone, or that
another agent now carries, is dropped at once without this comparison:
worth zero, it would otherwise be kept against an explore option also
worth zero, and the agent would walk on to an empty tile. User goals from Part 2 have a higher priority and always
win over the agent's own options (section 6).

## 4. How the agent moves

Every option has a target tile, and the agent uses **A\*** to find a route
there. A\* keeps a list of tiles it could step to next, and always tries
first the one with the smallest "steps taken so far plus a straight-line
guess of the steps left". This steers it straight towards the target
instead of searching in every direction, and on a 20 × 20 map it takes
well under a millisecond. The route length is also the distance used in
scoring.

Walls are avoided because they are not walkable. Other agents are avoided
because their recent tiles count as blocked. A\* treats the target the same
way, so it will not plan to walk into an agent standing on it.

**The agent plans a fresh route before every step**, with its latest
beliefs, and takes only the first step of it. Planning once and following
the route blindly would walk into an agent that stepped into the way after
the route was made. Because A\* is so fast, replanning costs nothing, and
each step is also a natural moment to check whether the intention is still
worth pursuing.

**When a move fails**, the agent does not simply retry, because every
failed move costs a point. Instead the failure becomes a belief: that
move (from this tile, in this direction) is avoided for about two seconds,
and the next route goes around it. Only the move is avoided, not the tile,
since the tile may still be enterable from another side. If the same move
is refused again it is avoided twice as long (4 s, 8 s, ... up to 30 s),
and a move that works clears the record. A passing agent is soon forgotten,
while a passage that never works stops luring the agent back. A fixed
time could not tell the two apart: the agent forgot real dead ends as fast
as passing agents, and kept walking back into them. Assuming every
tile is passable until shown otherwise, and correcting the map from what
fails, is the usual way to move through terrain only partly known (the
"freespace assumption" of D\* Lite, Koenig and Likhachev).
After about three failures on the way to the same target, the agent gives
up the intention and deliberates again. A move the server does not answer
within one second is treated as a failed move, so the agent never crashes
on a slow network.

**Before every step the agent also acts on the spot**, whatever it is
walking for: it picks up free parcels on its tile while it has room, and
puts everything down when it stands on a delivery tile while carrying. A
parcel passed on the way is never left behind, and the pickup and deliver
plans only walk and then check that the parcels were picked up or
delivered. Delivering heads for the nearest delivery tile that can be
reached, so one occupied by another agent is simply passed over.

The other surprises are handled the same way: the beliefs are corrected
and the loop carries on.

| What goes wrong | What the agent does |
|---|---|
| A move fails or is not answered | Avoids that move for a while, longer each time it fails again, and finds a detour; gives up after a few failures |
| The parcel is gone on arrival | Forgets the parcel and chooses again |
| There is no route to the target | Leaves that option out and chooses again |
| The connection drops | The game library reconnects, and beliefs rebuild from what the server sends next |

## 5. Using an external planner

A\* is search code written for this one problem. The course also asks for
an **external planner**: a general-purpose solver that knows nothing about
this game and works out a plan from a description of the problem.

The description is written in **PDDL** and has two parts. The *domain*
states the rules once: there are tiles, the agent is at one of them, tiles
can be connected up, down, left or right, and a move takes the agent from a
tile to a connected one. The *problem* describes the current situation and
is rebuilt from beliefs each time: these are the walkable tiles and how
they connect, the agent is here, it should end up there. Both are sent to
an online solver, which replies with a sequence of moves.

PDDL is used **for movement only**: it plans the route to a target that
deliberation has already chosen. It could plan whole tasks, such as which
parcels to pick up and in which order, but then the planner and the scoring
of section 2 would both be deciding what to do, and the larger problems
would take longer to solve while parcels lose value. Keeping it to
movement means deliberation decides *what* to do and the planner decides
*how to get there*.

The solver is slow compared with A\*: each request goes over the internet
and can take seconds. So the PDDL mover keeps its plan and only asks again
when a move fails or the target changes. If the solver fails or takes more
than five seconds, A\* plans that route instead, so the agent never stalls.
A setting chooses which mover the agent uses, which makes a fair comparison
possible: the same agent, the same map, and only the mover changed.

## 6. Taking instructions from a person (Part 2)

*This part has not been discussed in detail yet. What follows is the first
version, kept as a starting point.*

A person types an instruction such as "stay out of the top half of the map"
or "go to the bottom-left corner". An **LLM agent** turns it into one or
more **directives**: a fixed list of goals (go to a tile, pick up a given
parcel, deliver now, pause, resume) and constraints (avoid an area, stay in
an area, ignore parcels worth less than a value, carry at most a number of
parcels, clear everything).

Every directive is checked against the agent's beliefs before it is used.
One that points off the map, at a wall, or at a parcel the agent does not
know about is rejected with a reason. If any directive in an answer is
invalid, none is applied, so the agent never half-follows an instruction.
If the LLM cannot be reached, the user is told and nothing changes.

The BDI agent uses directives through the same machinery as everything
else:

- A **goal** becomes an option with a higher priority than the agent's own,
  so it wins at the commitment step (section 3) and is still carried out
  with replanning and failure handling. If it cannot be reached, it is
  marked failed with the reason and the user is told.
- A **constraint** changes which options exist and which tiles A\* and PDDL
  may use.

The LLM never moves the agent, and it is called only when the user types,
so the decision loop never waits for it. With no directives the agent
behaves exactly as in Part 1.

**Still to decide:**

- **Where instructions come from.** The course's own "mission agents"
  announce missions to all players through in-game chat and award bonus or
  penalty points. The missions are: go to given coordinates, deliver at a
  given tile, answer a question in chat, deliver exactly N parcels at a
  time, deliver parcels whose total reward is under a limit, one agent picks
  up and another delivers, and "red light, green light" (stop until told to
  go). Listening to chat as well as a terminal, and adding directives for
  these missions, would match how Part 2 may be evaluated.
- **Which LLM.** The course lab uses an OpenAI-compatible service run by
  the university; a key is needed.
- **One program or two.** Whether the LLM agent may run inside the BDI
  agent's program, or must be a separate game agent that sends it messages.

## 7. How the code is organised

```
server events ─> Beliefs ─> Options ─> Intention revision ─> Plans ─> moves
                    ^          ^              ^                 │
                    │          └─ directives  └──── failures ───┘
                    │                ^
              status reports ──> LLM agent <── user instruction
```

| Part | Files (under `src/`) | Role |
|---|---|---|
| Connection | `config.js`, `client.js` | Settings from `.env`; the only code that talks to the game server |
| Beliefs | `beliefs/` (map, parcels, agents, directives, and one object holding them all) | Section 1 |
| Deliberation | `deliberation/` (expected reward, option list) | Section 2 |
| Intentions | `intentions/` (one intention, the loop and the switching rule) | Section 3 |
| Plans | `plans/` (go to, pick up, deliver, explore, step-by-step movement) | Section 4 |
| Path finding | `planning/astar.js`, `planning/pddl/` (domain, problem builder, solver call) | Sections 4 and 5 |
| LLM | `llm/` (directive checks, LLM agent, LLM connection, console) | Section 6 |
| Start-up | `index.js` | Connects the parts and starts the loop |

Each part depends only on the parts before it. Only `client.js` talks to
the game server, only the solver file talks to the PDDL planner, and only
one file talks to the LLM, so each outside service can be replaced in one
place.

## 8. Testing

Everything that does not need the live server is checked by automated
tests: the map, parcel value estimates, A\*, scoring and options,
exploring, movement and plans (against a fake game server that can be told
to fail), the switching rule, the PDDL problem, directive checks and the
effect of each constraint. The LLM agent is tested with a fake LLM that
returns prepared answers, including broken ones.

The rest is checked in live runs on the course server: the agent with
A\*, with PDDL, and with a fixed list of typed instructions. A\* and PDDL
are compared by score over five minutes on the same map.

## 9. Notes on the server and open questions

Things learned by connecting to the course server (map `long_hallways`,
20 × 20, October 2026, and the demo map `missions_tournament`, 10 × 8, on
23 October) that the code has to work around:

- The server does not send a separate "you" message. The agent's own
  position and score arrive inside each sensing message.
- The map size it reports is one too small (19 for a 20-wide map), so the
  size is taken from the tiles instead.
- While moving, positions are fractional (for example 18.6), so they are
  rounded before any path finding.
- Sensing messages are sent only when something changes.
- A move succeeds in about 0.2 s and a move into a wall fails in about
  0.04 s, well within the one-second limit.
- Connecting by name creates a new agent each time; the token the server
  sends back is saved in `.env` so the agent keeps its identity.
- The planner library always names its domain "default", so the domain file
  must use that name.
- The map can contain arrow and crate tiles (map `tree`, 25 × 25, has many
  arrows). No movement rule is assumed for them: every tile except a wall
  is treated as walkable, and a move the server refuses is avoided for a
  while, as for any failed move (section 4). Tiles where a crate is seen
  are blocked as a whole for a short time.
- Each parcel arrives as `id`, `x`, `y`, `reward` and `carriedBy` only:
  there is no timer field, the reward is the timer.
- Sensing messages carry a `frame` number and an `entities` list, and the
  server sends a `ping` with the frame about once a second.
- Settings differ from map to map and are read from the server, never
  assumed. On `missions_tournament` parcels never decay ("infinite"),
  energy is on, a move takes 0.1 s, and the settings give no `PENALTY`.
  Its `missions` plugin runs a red light / green light game announced by
  messages from "mission-master": moving on red costs 15 points.

Open questions:

- **Points lost.** Failed-move penalties, energy (active on
  `missions_tournament`: 100 to start, 1 per move, pickup or putdown, 10
  back every 5 s; the agent's own level is not reported) and mission
  penalties all cost points the scoring does not count yet. Left until the
  base agent plays on its own; energy to ask the course staff about.
- **Own carried parcels in sensing.** Whether sensing reports the parcels
  the agent carries itself. The design does not rely on it (section 1);
  to check in the first live run.
- **The PDDL solver.** Whether the online solver is reachable and fast
  enough from our network. To check before building the PDDL mover.
- **Part 2.** The questions listed at the end of section 6.
