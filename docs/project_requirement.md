# Project requirements

What the agent has to do, and why that is harder than it sounds. For how
it works, read [design.md](design.md) next; for the order it is built in,
[implementation_plan.md](implementation_plan.md).

Course: Autonomous Software Agents, University of Trento.

## The game

Deliveroo.js is played on a grid of tiles. Some tiles are walls, some are
**spawn tiles** where parcels appear, and some are **delivery tiles** where
parcels are dropped off for points.

```
 ┌───┬───┬───┬───┬───┐
 │ D │   │ ▓ │   │ S │     D  delivery tile
 ├───┼───┼───┼───┼───┤     S  spawn tile
 │   │   │ ▓ │ p │   │     ▓  wall
 ├───┼───┼───┼───┼───┤     p  parcel
 │ S │ A │   │   │ D │     A  our agent
 └───┴───┴───┴───┴───┘
```

Our agent moves one tile at a time, picks parcels up, carries several at
once, and scores a parcel's value when it puts it down on a delivery tile.
Four things make this a real decision problem rather than a simple route:

- **Parcels lose value over time.** On the course server a parcel loses one
  point every second, and a typical parcel starts around 30. Slow choices
  cost points on everything the agent carries. The server's game clock
  drives this: its settings give the decay interval, and its frames count
  the time, so the agent must follow the server's clock, not its own.
- **The agent only sees nearby.** It sees 5 tiles around itself. Anything
  further away it has to remember, and its memory can be out of date.
- **Other agents share the map.** They block tiles and may take a parcel
  first.
- **Mistakes cost points.** A move into a wall or another agent fails and
  costs one point.

Other numbers from the course server: the agent carries at most 5 parcels,
a move takes about 0.2 seconds, and a new parcel appears every 2 seconds,
up to 5 on the map at once.

## What the course asks for

The course defines two parts. In Part 2 the LLM does not replace the BDI
agent: it extends how the agent can be instructed and controlled.

### Part 1: an autonomous BDI agent

| | Requirement | Met when |
|---|---|---|
| R1.1 | Sense the environment and manage beliefs | The agent keeps a current picture of the map, parcels and their decaying value, other agents and itself, and forgets what is no longer true. |
| R1.2 | Deliberate and select intentions | The agent lists what it could do, scores each option, and commits to the best one. With nothing to pick up it explores instead of standing still. |
| R1.3 | Choose and execute plans | Each kind of intention has a plan that carries it out, and the agent scores points on the course server. |
| R1.4 | Use an external planner | The agent can plan its movement with an online PDDL planner, and keeps playing if the planner fails. |
| R1.5 | Replan and revise intentions | A failed move leads to a detour, a parcel taken by someone else is dropped from the agent's plans, and a clearly better option replaces the current intention. |

### Part 2: LLM + BDI agent system

| | Requirement | Met when |
|---|---|---|
| R2.1 | Accept high-level instructions from the user | A person can give the agent instructions in plain language while it plays. |
| R2.2 | Interpret them through an LLM agent | An LLM agent turns the instruction into structured commands. If the LLM fails or answers nonsense, the user is told and nothing changes. |
| R2.3 | Translate them into goals and constraints | Instructions become goals (for example "go to this tile", "deliver now", "pause") and constraints (for example "avoid this area", "ignore cheap parcels"). Commands that make no sense in the current world are rejected with a reason. |
| R2.4 | Coordinate with the BDI agent | User goals are pursued through the same BDI machinery, ahead of the agent's own options. Constraints shape what the agent chooses. The user hears back whether each goal succeeded or why it failed. |

Which instructions Part 2 must support, and where they come from (a
terminal, in-game chat, or both), is still to be decided; see the open
questions in [design.md](design.md).

## Rules we hold ourselves to

- The LLM never moves the agent. It only produces goals and constraints.
- The LLM is called only when the user gives an instruction, never in the
  agent's own decision loop, so the agent is never slowed down by it.
- With no instructions, the agent behaves exactly as in Part 1.
- The agent never tries a move it believes will fail.
- The code is plain JavaScript with no build step, and everything that does
  not need the live server is covered by automated tests.

## Out of scope

A team of two cooperating agents, predicting what opponents will do,
tuning for one particular map, and the written report.

## What success looks like

- Every requirement above can be shown, by an automated test or by a live
  run.
- The design is easy to explain: each part of the BDI cycle can be pointed
  to in the code, and each design choice has a reason.
- The agent scores well on the course server, and its scores with A\* and
  with the PDDL planner are recorded side by side in the README.
