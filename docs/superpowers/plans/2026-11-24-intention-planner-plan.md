# Plan: one PDDL planner per intention

Date: 2026-11-24. Status: draft. Steps 1 and 2 are done (measured, decided); nothing is built yet.

## Why

The course slides on planning (`11-F-Planning.pdf`) describe how the planner fits into a BDI agent, and our code does not follow them yet.

- **Page 12** shows one intention, `I = {del(pack_1, 0,2)}`: deliver parcel `pack_1` at tile (0,2). The plan for it is the whole trip: `move(UP), move(UP), pick_up(pack_1), move(DOWN), move(LEFT), put_down(pack_1)`.
- **Page 2** shows the architecture. Deliberation sends an intention to the **Plan Library**. When the library has no plan, it asks the **Planner**, and the plan the planner returns is **archived** in the library. The library then selects a plan, the plan sends actions to the environment, and a **plan failure** goes back to the intentions.
- **Page 38** (the Gripper example) models capacity with `free(gripper)` and `carry(ball, gripper)`.
- **Page 50** uses an online planner (planning.domains or paas-uom).
- **Page 10** says model-based planning is less suitable when fast reactive behaviour matters more than deliberation. This is why the agent must not stand still while it waits for the solver.

Today the code uses PDDL in two ways that do not match this. The navigation planner plans only the walk to a tile. The task planner (`TASK_PLANNER=pddl`) chooses the order of several parcels, which is deliberation and not planning for an intention.

## Lessons taken from another team's design

Another team's report describes a similar planner. We take these points from it:

1. **One parcel per intention.** PDDL receives one parcel that deliberation has already chosen, as on page 12. Whether the agent has room to carry it is checked during deliberation, as today, so the PDDL model does not need capacity slots.
2. **The agent starts walking with A\* and switches to the PDDL plan when it arrives.** The agent keeps acting while parcel rewards decay, and the symbolic plan replaces the fallback route once it is ready and valid.
3. **The PDDL problem respects the same rules as A\*.** Forbidden tiles are left out, crate tiles count as blocked, and a move that the game just refused counts as blocked for a while.
4. **A circuit breaker,** so that the agent does not pay the full timeout on every intention while the solver is down.
5. **The report explains planning decisions in tables** of the form "situation, decision, reason".

We do not take these points:

- BFS as the fallback. We keep A\*.
- Relaxing tiles that other agents occupy when no route exists. Our movement code already waits or steps aside (`navigation_wait`, `navigation_yield`), which works better.
- Planning without an archive. We keep the archive from page 2.

## Phase 1: measure first, then decide

**Step 1. Measure how slow the online solver is. Done.**
A throwaway script (kept out of the repository) sent problems to the online solver, five times each:

| Problem | Size | Time (min-max) | Mean |
| --- | --- | --- | --- |
| tile by tile, 5x5 (the page 12 example) | 25 tiles | 3.1-5.6 s | 4.2 s |
| tile by tile, `circuit_directional` 26x26 | 485 tiles, ~33 KB | 3.3-7.2 s | 4.4 s |
| abstract, a few places | 6 places | 2.9-4.9 s | 3.6 s |

What the numbers say:

- Map size barely matters (485 tiles are only about 0.2 s slower than 25). Almost all of the time is the fixed cost of the service: sending the problem takes 2-6 s, fetching the answer 1-2 s.
- On the large map the plan has 192 actions: 190 moves (the same number as A\*, so the solver follows the arrows and does not detour), one pickup and one putdown.
- The abstract problem is only about 0.8 s faster, and its plan no longer has every step as on page 12.
- 3 of the 15 calls took more than 5 s (5.3, 5.6 and 7.2 s), which is more than the current `PDDL_TIMEOUT_MS` of 5 s. About one call in five would have been counted as a failure although the solver answered correctly.
- The game moves one tile every 50 ms, so one call costs about 60 moves. This is why the agent must not wait for the solver (step 9).
- Caveat: 15 calls, one time of day, one map. A much larger map (about 2000 tiles) has not been timed, and the service may be slower when many people use it.

The same problems were then timed with a local solver, Fast Downward (`aibasel/downward`, `lama-first`) in Docker on this Mac, five runs each:

| Problem | Online (mean) | Local, whole run (mean) | Local, search only |
| --- | --- | --- | --- |
| tile by tile, 5x5 | 4.2 s | 0.42 s | 0.08 s |
| tile by tile, `circuit_directional` 26x26 | 4.4 s | 0.54 s | 0.12 s |
| abstract, a few places | 3.6 s | 0.42 s | 0.08 s |

The local plan for the large map is also 192 actions. Most of the local time is starting the planner and translating the problem, not searching.

How long the agent's own walks take was read from the benchmark logs (29,520 moves and 3,365 completed walks on six maps): a move takes about 103 ms, a walk takes 0.47 s at the median, and 98% of walks end within 4 s. So with the online solver the plan almost always arrives after the walk is over, and with a local solver it arrives in time for about the longer half of the walks.

**Step 2. Choose how the map is described to PDDL. Decided: tile by tile, the whole map.**

Every walkable tile is an object and every directed edge is a fact. There is no corridor and no cut of the map around the A\* route. It is the closest to page 12, because the plan contains every move, and the numbers of step 1 show that a smaller problem is not faster, while cutting the map can hide the route and make the solver answer "no plan" although there is one. The abstract problem is not used.

**Step 3. Fix what an intention is.**
An intention is "deliver parcel P at tile d", with exactly one parcel. Its plan is the whole trip: walk to the parcel, pick it up, walk to tile d, put it down. Parcels already carried are put down at d as well.

**Step 4. Rewrite the design document with these decisions** and get it approved. If a question for the professor is needed (for example, whether calling the planner once per intention is enough), it is asked at this step.

## Phase 2: the planner

**Step 5. A fixed domain** with three kinds of action: move (one per direction, along directed edges so that arrow tiles are respected), pickup and putdown. There are no capacity slots, because an intention holds one parcel and deliberation has already checked capacity. That check reads the capacity from the game settings (`config.GAME.player.capacity`, where -1 means no limit), as `src/deliberation/options.js` does today. No constant stands for the capacity anywhere in the planner. The old `TASK_PLANNER_MAX_PARCELS` (default 5) was only a limit on the size of the task problem and is removed with the task planner.

**Step 6. Build the problem from the beliefs.** It contains:

- the agent's position;
- the chosen parcel and its tile;
- the parcels the agent carries;
- the delivery tile d;
- the walkable tiles and the directed edges between them, following the arrow tiles;
- tiles occupied by other agents, left out;
- forbidden tiles (from missions or strategy), left out;
- tiles with a crate, counted as blocked, since pushing a crate is left to A\*;
- moves the game refused recently (`map.failMove`), counted as blocked edges.

The goal is that the chosen parcel and every carried parcel are delivered, and that the agent stands on tile d.

**Step 7. Check the plan before using it.** Every move must follow an edge of the problem from where the agent would be at that point, pickup and putdown must happen on the right tiles, and the plan must end in the goal state. If any part is wrong, the whole plan is rejected.

**Step 8. The solver service.** It is either off or calls the online solver of the course through `@unitn-asa/pddl-client`, which stays the only solver client in the code. A local or HTTP solver is not used: it was measured in step 1, but the course uses the online planner (page 50) and the agent must play well with it. Each call has a timeout, by default 10 s (step 1 measured 3 calls in 15 above 5 s), and is logged as `pddl_call`, then `pddl_success` or `pddl_failure`. It also has a circuit breaker:

- only real failures count: a timeout, a network or solver error, or a plan that step 7 rejects;
- after a number of failures in a row, the solver is skipped for a while;
- after that, one call is tried; if it works the breaker closes, and if not it opens again.

In the measurements no call failed, so the breaker only protects against a solver that is down, not against normal slowness.

## Phase 3: connect it to the agent, following page 2

**Step 9. The agent never stands still waiting for the solver.** It chooses its intention by utility, as today. The task planner (`#taskChoice`) is removed from deliberation. When an intention starts, the agent begins walking along an A\* route while the solver works. When a valid PDDL plan arrives, the agent uses it if it is still on the plan's route (the plan was made from the position where the agent started, and the agent has walked on since). If it has left that route, it keeps the A\* route for this intention. For plain walking the PDDL plan and the A\* route have the same length, so the value of the plan lies in its `pickup` and `putdown` actions.

Decided: the agent never waits for the solver. A plan asked for when a trip is new will rarely arrive in time (see step 1), so it is archived for the next time the same trip comes (step 10), and from then on it drives the agent at once. The report must say plainly how often this happens. Planning ahead for the next intention, so that even a new trip finds its plan in the archive, is left for later, if PDDL plans need to be used more often.

**Step 10. The Plan Library looks for a plan first and asks the planner only when it has none.** This is the archive of page 2. A key made of the parcel would almost never match again, because a delivered parcel never comes back, so the key is made of places that repeat: the tile where the agent starts, the parcel's tile, the delivery tile, and the number of carried parcels. These repeat because the agent starts from a delivery tile after each delivery and parcels appear on the same spawn tiles. Parcels get generic names in the problem, so that a plan works for the next parcel on the same tile. A plan stays in the archive after its intention ends, up to a limit (default 500, the least recently used dropped first). Before an archived plan is used it is checked against the current beliefs; if it no longer works, a fresh plan is asked for and replaces it. Hits and misses are logged, so that step 16 can report the hit rate per map. If the planner fails, the library uses a plan built with A\*.

**Step 11. Run the plan step by step.** Pickup and putdown keep using the current code, including how it handles uncertain outcomes. When the beliefs show that the plan no longer works, a plan failure goes back to the intention and a new plan is made.

**Step 12. The LLM agent uses the same Plan Library.** Check that delivering on the way (putting parcels down when the agent passes a delivery tile) still works.

## Phase 4: clean up

**Step 13.** Remove the old navigation PDDL, the task planner, `plannerCalled` in `src/plans/moveTo.js`, the `TASK_PLANNER*` settings, and their tests.

**Step 14.** Add the setting `PLANNER=disabled|online`. `MOVER` is still accepted under its old name so that existing scripts keep working. Update `.env.example`, `docs/SETUP.md`, `src/types.js`, and the `bdi_pddl` scenario of the course validator. The log names `pddl_call`, `pddl_success`, `pddl_failure` and `planner_fallback` stay the same, because the validator and the evidence documents count them.

## Phase 5: tests and evidence

**Step 15. Tests:**

- the problem built for each kind of intention, with and without carried parcels;
- forbidden tiles, crate tiles and refused moves left out of the problem;
- wrong plans rejected;
- the Plan Library: a plan in the archive, no plan in the archive, an archived plan that no longer works, and the A\* fallback when the planner fails;
- the agent keeps moving while the solver works, and switches to the PDDL plan when it arrives;
- each state of the circuit breaker;
- the whole agent with a fake solver.

**Step 16. Run it for real** with the online solver, recording how long each call takes, how often archived plans are hit, and how often PDDL plans drive the agent. Compare the score with the current agent on the benchmark maps. Then run it on the bears server (over the university VPN). Only then write "passed" in the documents, and correct any sentence in the report that claims more than the code does. Planning decisions in the report are explained in "situation, decision, reason" tables.
