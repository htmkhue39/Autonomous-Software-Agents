# Design: one PDDL planner per intention

Date: 2026-11-24. Status: approved. The plan this design belongs to is `docs/superpowers/plans/2026-11-24-intention-planner-plan.md`; its steps 1 to 3 are settled there, and this document is step 4.

## Intent

The course slides on planning describe a BDI agent in which an activated intention goes to the Plan Library, the library asks a planner when it has no plan, the planner's plan is archived in the library, and the plan's actions are sent to the game (page 2). The example on page 12 shows one intention, "deliver parcel pack_1 at tile (0,2)", and one plan for the whole trip: moves, `pick_up`, moves, `put_down`.

Our agent does not work this way. Its navigation planner only plans walks, and its task planner chooses the order of several parcels, which is deliberation rather than planning. This design replaces both with one planner that makes the plan for one intention, while keeping the agent as fast as it is now.

## Goals

- One fixed PDDL domain with `move`, `pickup` and `putdown`, and a problem built from the beliefs for each intention.
- A pickup intention covers the whole trip: walk to the parcel, pick it up, walk to the delivery tile, put it down.
- The Plan Library keeps an archive of plans for trips that come again, and asks the planner only when the archive has no plan that still works.
- The agent never waits for the solver, and it falls back to A\* whenever there is no plan.
- Every plan is checked before any of its actions is used.
- The logs show how often a PDDL plan was actually used, and how often the archive had one, so that the report can say it honestly.

## Non-goals

- Only the online solver of the course (`@unitn-asa/pddl-client`, page 50). No local or HTTP solver.
- No BFS. A\* stays the fallback.
- No capacity in PDDL. Deliberation already checks that the agent has room.
- No planning ahead for the next intention. It may come later (see "Later").
- No change to how options are scored.

## Anti-goals

- The agent must not become slower. Waiting for the online solver would cost about 4 s per intention, while a walk takes 0.47 s at the median.
- The documents must not claim that PDDL plans drive the agent if the logs show they rarely do.

## Constraints and facts from step 1

- The online solver takes 2.9 to 7.2 s per call (mean about 4 s), whatever the size of the map.
- A move takes about 103 ms, and 98% of walks end within 4 s. So a plan asked for when an intention starts nearly always arrives after the walk is over. A plan can only drive the agent if it is already in the archive when the intention starts.
- `src/course/validation.js` and the evidence documents count the log events `pddl_call`, `pddl_success`, `pddl_failure` and `planner_fallback`, so these names stay.

## Approaches considered

1. **Wait for the plan, then act.** This follows the slides most literally, but costs about 4 s per intention. Rejected.
2. **Act with A\* at once, ask the planner in the background, and archive its plan for the next time the same trip comes** (chosen). The agent stays fast and calls the planner for every new intention, as the slides ask. The first time a trip comes, A\* drives the agent; from then on the archived PDDL plan does.
3. **Plan ahead for the next intention,** so that its plan is in the archive when it starts. This would also cover trips seen only once, but it is more complex, wastes calls when the guess is wrong, and puts more load on a public service. Left for later.

A local solver was measured (Fast Downward in Docker, about 0.5 s per call) and set aside, because the course uses the online planner and the agent must play well with it.

## Design

### Intentions

| Intention | Option today | What changes |
| --- | --- | --- |
| Trip: deliver parcel P at tile d | `pickup` option | The option also carries the delivery tile d. `listOptions` already finds it (`single.target`) when it scores the pickup, and now keeps it as `deliverX`, `deliverY`. The option's id stays `pickup:<parcelId>`. |
| Deliver what is carried at tile d | `deliver` option | No change. |
| Explore or go to a tile | `explore`, `goto` | No change. The planner is not used for them, since they have no pickup or putdown and A\* already finds the shortest walk. |

The pickup score may already count a second pickup on the way ("one stop ahead"), but the trip plan goes straight to d after the first pickup. This is kept: after the pickup the BDI loop still reconsiders, as it does today, and it may replace the trip with a better pickup. This is the intention revision of page 2.

`PlanLibrary.applicable` keeps its rules. In addition, a trip stops being applicable when its parcel is neither free nor carried by the agent, or when tile d stops being a delivery tile.

### Domain

The domain is one constant, in `src/planning/pddl/domain.js`:

- predicates: `(at ?t)`, one edge predicate per direction (`up`, `down`, `left`, `right`, each `?from ?to`), `(delivery ?t)`, `(parcel-at ?p ?t)`, `(carrying ?p)`, `(delivered ?p)`;
- `move-<direction> ?from ?to`: needs `(at ?from)` and the edge in that direction;
- `pickup ?p ?t`: needs `(at ?t)` and `(parcel-at ?p ?t)`; afterwards `(carrying ?p)` and not `(parcel-at ?p ?t)`;
- `putdown ?p ?t`: needs `(at ?t)`, `(delivery ?t)` and `(carrying ?p)`; afterwards `(delivered ?p)` and not `(carrying ?p)`.

### Problem

`buildProblem(beliefs, intention)` in `src/planning/pddl/problem.js` builds the problem from the beliefs at the moment it is called:

- objects: every tile the agent may enter, the parcel `target` for a trip, and one object per carried parcel;
- `(at s)` for the agent's tile s;
- for a trip, `(parcel-at target p)` for the parcel's tile p;
- `(carrying c)` for every carried parcel;
- `(delivery t)` for every delivery tile;
- the directed edges, as `map.neighbors` gives them, so that arrow tiles are respected.

Parcels have generic names (`target`, `carried1`, `carried2`, ...), not their game ids, so that a plan does not depend on which parcel it was made for and can be reused for the next parcel on the same tile.

Left out, so that the solver cannot use them:

- tiles occupied by other agents;
- forbidden tiles, from the `forbidden` test in the path options the movement code receives (set by directives, for example for the LLM agent);
- tiles with a crate. They must be left out explicitly, because `map.neighbors` allows a step onto a crate that can be pushed, and the domain does not model pushing. Pushing a crate stays with A\*;
- edges of moves the game refused recently (`map.failMove`), which `map.neighbors` already leaves out.

The goal is `(delivered x)` for the target and for every carried parcel, and `(at d)`. For a deliver intention there is no target.

Other parcels on tile p are not modelled. The game's pickup takes them as well, and its putdown drops everything, so they are delivered with the target.

### Checking a plan

`decodePlan(plan, problem)` in the same module accepts a plan only when all of these hold, and otherwise throws, which counts as a solver failure:

- every action is `move-<direction>`, `pickup` or `putdown`, with the right number of arguments;
- every move starts on the tile the agent is on at that point and follows an edge of the problem;
- `pickup` and `putdown` happen on the tile the agent is on, and `pickup` only where the problem placed that parcel;
- at the end, every goal fact holds.

It returns a list of steps, each `{ action: 'move', dir }`, `{ action: 'pickup' }` or `{ action: 'putdown' }`, together with the tiles the plan passes through.

### The solver

`src/planning/pddl/service.js` holds one `PlannerService` per agent. It calls the online solver through `@unitn-asa/pddl-client`, which is the only solver client in the code. It is either on (`PLANNER=online`, the default) or off (`PLANNER=disabled`). It is on by default because the slides ask for the planner to be called for every intention, and the agent never waits for it: without a network the breaker opens after a few failures and the agent goes on with A\*.

Each call has a timeout, `PDDL_TIMEOUT_MS`, 10 s by default (3 of 15 calls took more than 5 s in step 1). Each call is logged as `pddl_call`, then `pddl_success` with `durationMs` and the number of actions, or `pddl_failure` with the reason.

The circuit breaker:

- counts only real failures: a timeout, a network or solver error, or a plan that `decodePlan` rejects;
- does not count calls that were never made (no route for A\*, standing on the target, a plan found in the archive, breaker open);
- opens after `PDDL_BREAKER_FAILURES` failures in a row (default 3), and then skips the solver for `PDDL_BREAKER_COOLDOWN_MS` (default 60 s);
- after the cooldown lets one call through; success closes it and failure opens it again;
- resets the count of failures after any success;
- logs `pddl_breaker_open`, `pddl_breaker_half_open` and `pddl_breaker_closed`. A skip while open is logged as `planner_fallback` with `reason: 'circuit breaker open'`.

### The archive

The archive is the Plan Library's store of plans, as on page 2. Its key is made of places that come back again and again, not of parcels, which are delivered once:

- a trip: the tile where the agent starts, the parcel's tile, the delivery tile, and the number of carried parcels;
- a delivery: the tile where the agent starts, the delivery tile, and the number of carried parcels.

These places do repeat: after a delivery the agent starts from a delivery tile, and parcels appear on the same spawn tiles. The number of carried parcels is in the key because the plan has one `putdown` per carried parcel.

The archive keeps at most `PLAN_ARCHIVE_SIZE` plans (default 500). When it is full, the plan unused for the longest time is dropped. A plan stays in the archive when its intention ends.

Before an archived plan is used, it is checked against the beliefs of that moment: every move must still follow an edge the map allows now (no agent in the way, no refused move, no new crate). A plan that fails this check is not used this time, a fresh plan is asked for, and the new plan replaces it in the archive.

Each lookup is logged as `plan_archive_hit` or `plan_archive_miss`, with the key, so that the hit rate on each map can be reported. On maps with few spawn tiles the hit rate should be high; on `circuit_directional`, which has many, it will be lower.

### The Plan Library

When an intention starts, `PlanLibrary.execute` does this:

1. If the agent already stands where the intention's next action happens (on the parcel's tile for a trip, on d for a delivery), it acts at once, without the planner.
2. It looks in the archive. A plan found there that passes the check is used at once. The solver is not called.
3. With no usable plan, it asks the planner in the background and starts at once with an A\* route.
4. When the planner's plan arrives and passes `decodePlan`, it is archived. If the agent is still on its first walk of this intention and its tile is on the plan's path, the rest of the plan from that tile replaces the rest of the A\* route. Otherwise the A\* route is kept, and the plan waits in the archive for the next time.

Every plan is logged as `pddl_plan_used` with `from: 'archive' | 'solver'` when it drives the agent, or as `pddl_plan_unused` with `reason: 'walk finished' | 'off the plan path' | 'intention ended'` when it does not. These events show how often PDDL plans really drive the agent.

### Running the plan

The steps of the plan are carried out with the code that already works:

- moves go through `MovementRunner.moveTo`, which gets the PDDL moves as its route instead of computing one, and still replaces a route that becomes blocked;
- `pickup` and `putdown` use the existing code in `PlanLibrary`, including how it settles uncertain outcomes and the delivery on the way (`deliverOnTheWay`, which is on for the LLM agent and off for the BDI agent, as today);
- a trip runs as two walks inside one intention: to the parcel, pick up, then to d, put down. If the pickup fails, the intention fails, as today;
- when the beliefs show that the plan no longer works (the parcel was taken, d is no longer a delivery tile), the intention fails with a plan failure, and the BDI loop chooses again.

The report should say that the PDDL plan is checked and decides the actions, and that the Plan Library sends them to the game through the SDK.

### The LLM agent

`src/llm/game/runtime.js` builds its own `MovementRunner` and `PlanLibrary`. It is given the same kind of planner service and its own archive, so the LLM agent uses the same planner. Its tools keep calling `plans.execute`.

### Settings

| Setting | Values | Default |
| --- | --- | --- |
| `PLANNER` | `disabled`, `online` | `online` |
| `PDDL_TIMEOUT_MS` | milliseconds | 10000 |
| `PDDL_BREAKER_FAILURES` | count | 3 |
| `PDDL_BREAKER_COOLDOWN_MS` | milliseconds | 60000 |
| `PLAN_ARCHIVE_SIZE` | count | 500 |

`MOVER` is still read for old scripts: `MOVER=pddl` means `PLANNER=online` and `MOVER=astar` means `PLANNER=disabled`, unless `PLANNER` is set. The benchmark runner and the course validator always pass `MOVER`, so the new default does not change them; the `bdi_pddl` scenario of the validator sets `PLANNER=online`. A local `.env` with `MOVER=astar` keeps the planner off.

### What is removed

- `src/planning/pddl/task-problem.js`, `solveTasks`, `#taskChoice`, `#nextPlannedOption` and the task plan state in `src/intentions/agent.js`, the `TASK_PLANNER*` settings, and `test/pddl-task.test.js` and `test/task-planning-agent.test.js`;
- the old navigation problem and decoder in `src/planning/pddl/problem.js`, `solveNavigation` in `solve.js`, and `route()` and `plannerCalled` in `src/plans/moveTo.js`;
- the task planner section of `docs/SETUP.md` and the matching lines of `.env.example`.

## Tests

Besides the unit tests of each module (problem, check, breaker, archive, Plan Library), one test runs the real `@unitn-asa/pddl-client` against a small fake server on localhost that answers in the planning.domains format, by pointing the client at it with `PAAS_HOST`. This checks the whole path of the client without the internet. The client reads `PAAS_HOST` once, when its module is first loaded, so the variable must be set before the first import, and that test must run in its own process (`node --test` runs each test file in its own process). The real online solver is used in step 16.

## What the report must say plainly

- The first time a trip comes, A\* drives the agent. The PDDL plan arrives later (about 4 s, while the walk takes about 0.5 s) and is only archived. Only when the same trip comes again does the PDDL plan drive the agent.
- So at the start of each game, and on large maps where the same (start, parcel, delivery) combination rarely comes back, PDDL plans are used little. The hit rate is not known yet; the logs of step 16 give it per map.
- The key contains the starting tile. The agent starts from a delivery tile right after a delivery, which is when keys repeat most; at other times (just after a pickup, or when an intention is replaced halfway) keys repeat less.
- The online solver is not always quick (3 of 15 calls took more than 5 s, measured at one time of day). The 10 s timeout, the breaker and the A\* fallback are what keep the agent playing.

## Risks

- **A trip intention changes how the agent plays.** Today, after a pickup, the BDI loop chooses again with fresh scores; now the trip goes on to d unless something better replaces it. The score may change either way. Step 16 compares the new agent with the current one on the benchmark maps before anything is claimed.
- **The archive may rarely hit on maps with many spawn tiles,** so PDDL plans would rarely drive the agent there. The hit counts show this, and the report says it.
- **A\* and PDDL may choose different equal-length paths,** so the agent may already be off the plan's path when a plan arrives. This only matters for the first time a trip comes, since later the archived plan is used from the start.
- **The public solver may be slow or down** during a game. The breaker and the A\* fallback keep the agent playing.

## Later

- Planning ahead for the next intention (approach 3), if the logs show that PDDL plans are rarely used and this matters for the grade.
- Asking the professor whether calling the planner for every new intention, and reusing archived plans, is what the slides ask for.

## Left to the builder

- The names of functions and modules where this document does not give them.
- Which A\* helper produces the fallback route, as long as it respects the same rules as the problem.
