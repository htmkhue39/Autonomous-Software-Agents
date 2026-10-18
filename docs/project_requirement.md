# Deliveroo.js BDI agent: project requirements

Course: Autonomous Software Agents (ASA), University of Trento.
Source: the course slide "The objective of the project" (`ASA/exam.png`).

Related documents:
[design.md](design.md) (how it is built),
[implementation_plan.md](implementation_plan.md) (task by task),
[server_notes.md](server_notes.md) (server facts and open questions).

## Context

An autonomous agent that plays the Deliveroo.js game
(https://deliveroojs.onrender.com/): it moves on a grid, picks up parcels
and delivers them to delivery tiles for points. Parcel rewards decay over
time, and a failed move costs points.

The project has two parts. In Part 2 the LLM does not replace the BDI
agent: it extends how the agent can be instructed and controlled.

## Part 1: Autonomous BDI agent

| ID | Requirement | Accepted when | Tasks |
|---|---|---|---|
| R1.1 | Sense the environment and manage beliefs | The agent keeps a map, known parcels with decayed reward, other agents and its own position, updated from server events. Stale parcels and agents expire. Fractional mid-move positions are rounded. Unit tests pass. | 2, 3 |
| R1.2 | Deliberate and select intentions | Options (`pickup`, `deliver`, `explore`) are generated and scored by expected reward. The best one becomes the intention. With nothing reachable the agent explores instead of failing. | 5, 7 |
| R1.3 | Choose and execute plans | A plan library (`GoTo`, `GoPickUp`, `GoDeliver`, `Explore`) achieves intentions. Each plan states which intentions it applies to. The agent scores points on a live server. | 6, 7 |
| R1.4 | Use an external planner | With `MOVER=pddl`, movement is planned by the online PDDL solver. On a solver timeout or error the agent falls back to A* and logs it. | 8 |
| R1.5 | Replan and revise intentions when needed | A failed move marks the tile blocked and the agent replans. A parcel taken by someone else leaves beliefs and the agent re-deliberates. A new option replaces the current intention only when it is better by a set margin. | 6, 7 |

## Part 2: LLM + BDI agent system

| ID | Requirement | Accepted when | Tasks |
|---|---|---|---|
| R2.1 | Accept high-level instructions from the user | The user types instructions in a terminal console while the agent plays. | 11 |
| R2.2 | Interpret them through an LLM agent | An LLM agent turns the text into structured directives. Invalid output and API errors are reported to the user, and the current directives stay unchanged. | 10, 11 |
| R2.3 | Translate them into goals and constraints | Goals: `goto`, `pickup`, `deliverNow`, `pause`, `resume`. Constraints: `avoidArea`, `stayInArea`, `minParcelReward`, `maxCarried`, `clear`. Directives off the map, on a wall or naming an unknown parcel are rejected with a reason. | 9, 10 |
| R2.4 | Coordinate with the BDI agent | User goals enter the same intention revision with priority over autonomous options. Constraints filter options and mark tiles as forbidden for both movers. The status of each goal (pending, active, done, failed and why) is reported back to the user. | 9, 10 |

Proposed, not yet in the plan: also take instructions from in-game chat
(`socket.onMsg`) and add the directives `deliverAt`, `answer`,
`deliverExactly` and `maxDeliveryReward` to cover the course mission
agents. See "Found in the course repo" in [server_notes.md](server_notes.md).

## Non-functional requirements

| ID | Requirement |
|---|---|
| N1 | Node 25, plain JavaScript, ES modules, JSDoc types, no build step. `npm run typecheck` passes. |
| N2 | `src/client.js` is the only file that imports the Deliveroo SDK. |
| N3 | `src/planning/pddl/solve.js` is the only file that imports `pddl-client`. |
| N4 | `src/llm/provider.js` is the only file that calls an LLM API, so the provider can be swapped. |
| N5 | The LLM never sends moves. It only produces directives. |
| N6 | LLM calls happen only when the user types, never inside the agent loop. |
| N7 | With no directives, behaviour is the same as in Part 1. |
| N8 | The agent never tries a move its beliefs say will fail, because failed moves cost points. |
| N9 | Logic that depends on time takes `now` as an argument, so tests never sleep. |
| N10 | Pure logic has unit tests run with `node --test`. The LLM agent is tested with a fake provider. |

## Scope

In scope: one agent process, Part 1 and Part 2 above, an A* mover and a
PDDL mover, a terminal console for instructions.

Out of scope: a two-agent team, modelling opponents, tuning for one
specific map, the written report.

## Success criteria

- Every requirement above is met and shown either by a passing test or by
  a live run.
- The architecture is clean and easy to defend in the exam: clear units,
  one responsibility each, BDI stages easy to point to in the code.
- The agent scores respectably on the course server. A* and PDDL scores
  over 5 minutes on the same map are recorded in `README.md` (Task 12).
