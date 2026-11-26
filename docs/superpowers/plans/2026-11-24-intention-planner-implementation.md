# One PDDL Planner per Intention: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the navigation PDDL and the task planner with one planner that makes the whole plan (moves, pickup, moves, putdown) for one intention, archives it by places that repeat, and never makes the agent wait.

**Architecture:** A pure module builds the PDDL problem for an intention and checks the solver's plan. A `PlannerService` calls the course's online solver with a timeout and a circuit breaker. A `PlanArchive` keeps plans by (start tile, parcel tile, delivery tile, carried count). The `PlanLibrary` uses an archived plan at once, or starts with A\* and asks the planner in the background, switching to its plan if it arrives in time. The movement runner no longer plans with PDDL; it only takes a route from the library.

**Tech Stack:** Node.js 22 ES modules, JSDoc types checked by `npm run typecheck`, `node:test`, `@unitn-asa/pddl-client`.

**Spec:** `docs/superpowers/specs/2026-11-24-intention-planner-design.md` (approved). Background and measurements: `docs/superpowers/plans/2026-11-24-intention-planner-plan.md`.

## Global Constraints

- Only the online solver through `@unitn-asa/pddl-client`; no HTTP or local solver.
- `PLANNER` is `disabled` or `online`, default `online`. `MOVER=pddl` means `online` and `MOVER=astar` means `disabled` when `PLANNER` is unset.
- `PDDL_TIMEOUT_MS` default 10000, `PDDL_BREAKER_FAILURES` default 3, `PDDL_BREAKER_COOLDOWN_MS` default 60000, `PLAN_ARCHIVE_SIZE` default 500.
- Log names `pddl_call`, `pddl_success`, `pddl_failure` and `planner_fallback` keep their names. New events: `pddl_breaker_open`, `pddl_breaker_half_open`, `pddl_breaker_closed`, `plan_archive_hit`, `plan_archive_miss`, `pddl_plan_used`, `pddl_plan_unused`.
- The agent never waits for the solver. A\* is the fallback; no BFS.
- Comments and documents are written in plain, full English sentences.
- Commits: never commit without the user's OK. Show the diff, wait, then commit with a one-line title and no body or co-author line.
- Every task ends with `npm test` and `npm run typecheck` passing.

## Review Focus

1. **Solver output in another letter case or spelling** (`MOVE-UP T1_0 T1_1`, extra blank lines): the plan should still decode. Test in Task 1.
2. **The parcel is taken while its plan is being made:** when the plan arrives, nothing is sent to the game, the plan is archived, and `pddl_plan_unused` says `intention ended`. Test in Task 6.
3. **An archived plan crosses an edge the game just refused:** it is not used, a fresh plan is asked for, and it replaces the old one. Test in Task 6.
4. **Two intentions start while the breaker is half-open:** only one solver call goes out; the other is skipped with `planner_fallback`. Test in Task 2.
5. **A trip that starts on the parcel's tile:** the pickup happens at once without the planner, and the walk to the delivery tile still runs. Test in Task 6.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/planning/pddl/domain.js` (create) | The fixed domain text. |
| `src/planning/pddl/problem.js` (rewrite) | `buildProblem`, `decodePlan`, `planStillWorks`, `routeFrom`. Pure functions. The old navigation functions stay until Task 4. |
| `src/planning/pddl/service.js` (create) | `PlannerService`: online calls, timeout, breaker, logs. |
| `src/planning/pddl/solve.js` (shrink) | Only `courseSolver` in the end: `solveNavigation` goes in Task 4, `solveTasks` in Task 7. |
| `src/plans/archive.js` (create) | `PlanArchive` and `archiveKey`. |
| `src/plans/moveTo.js` (modify) | Takes a route from the caller; no PDDL. |
| `src/plans/library.js` (modify) | Trip execution, archive, planner in the background. |
| `src/deliberation/options.js`, `src/types.js` (modify) | Pickup options carry their delivery tile. |
| `src/intentions/agent.js` (modify) | Task planner removed. |
| `src/config.js`, `src/index.js`, `src/llm-agent.js`, `src/llm/game/runtime.js`, `src/course/validation-runner.js`, `src/course/audit.js` (modify) | Settings and wiring. |
| `src/planning/pddl/task-problem.js` (delete) | Task planner. |
| Tests | `test/pddl-problem.test.js` (create; `test/pddl.test.js` deleted in Task 4), `test/planner-service.test.js`, `test/pddl-client.test.js`, `test/plan-archive.test.js`, `test/plan-library-planner.test.js` (create); `test/pddl-task.test.js`, `test/task-planning-agent.test.js` (delete); `test/config.test.js`, `test/plans.test.js`, `test/stage1-helpers.js` (modify). |
| Docs | `docs/SETUP.md`, `.env.example`. |

Shared types, defined in `src/types.js` in Task 1 and used by every later task:

```js
/** @typedef {{ kind: 'trip', parcelAt: Position, deliverAt: Position }
 *          | { kind: 'deliver', deliverAt: Position }
 *          | { kind: 'pickup', parcelAt: Position }} PlanGoal */
/** @typedef {{ action: 'move', dir: Direction } | { action: 'pickup' } | { action: 'putdown' }} PlanStep */
/** @typedef {{ steps: PlanStep[], path: Position[] }} DecodedPlan
 *   path[0] is the start tile; each move adds the tile it reaches. */
/** @typedef {{ domain: string, problem: string, from: Position, goal: PlanGoal, carried: number,
 *   edges: Set<string>, deliveries: Set<string> }} ProblemSpec
 *   edges holds 'x,y,dir' for every move the problem allows. */
```

The `pickup` goal (`(carrying target)` and no `(at d)`) is for the LLM agent's pickup tool, whose options have no delivery tile. The spec's table does not list it; this is the builder's call, and it uses the same domain.

---

### Task 1: Domain, problem and plan check

**Files:**
- Create: `src/planning/pddl/domain.js`, `test/pddl-problem.test.js`
- Modify: `src/planning/pddl/problem.js` (add the new functions; keep `buildNavigationProblem` and `decodeNavigationPlan` until Task 4)
- Modify: `src/types.js` (add the shared types above)

**Interfaces:**
- Produces: `DOMAIN: string`; `buildProblem({ map, from, paths, carried, goal }): ProblemSpec | null`; `decodePlan(plan: unknown, spec: ProblemSpec): DecodedPlan` (throws on a bad plan); `planStillWorks(plan: DecodedPlan, map: GridMap, paths: PathOptions): boolean`; `routeFrom(plan: DecodedPlan, at: Position, leg: 0 | 1): Direction[] | null` (the moves from `at` up to the plan's next pickup or putdown in that leg, or null when `at` is not on that leg's path).

- [ ] **Step 1: Write the failing tests** in `test/pddl-problem.test.js`, on `mapFromRows` maps:

```js
test('a trip problem has the start, the parcel, the delivery tile and directed edges', () => {
  const map = mapFromRows(['2333']);
  const spec = buildProblem({ map, from: { x: 3, y: 0 }, paths: { now: 0 }, carried: 0,
    goal: { kind: 'trip', parcelAt: { x: 1, y: 0 }, deliverAt: { x: 0, y: 0 } } });
  assert.match(spec.problem, /\(at t3_0\)/);
  assert.match(spec.problem, /\(parcel-at target t1_0\)/);
  assert.match(spec.problem, /\(delivery t0_0\)/);
  assert.match(spec.problem, /\(left t1_0 t0_0\)/);
  assert.match(spec.problem, /\(:goal \(and \(delivered target\) \(at t0_0\)\)\)/);
});
test('carried parcels get generic names and must be delivered', () => { /* carried: 2 → objects carried1 carried2, (carrying carried1), goal has (delivered carried2) */ });
test('arrow tiles only allow the moves they point to', () => { /* rows with '→': no edge against the arrow */ });
test('occupied, forbidden and crate tiles are left out', () => { /* paths.occupied, paths.forbidden, map.updateCrates → tile absent from :objects */ });
test('a refused move is left out of the edges', () => { /* map.failMove(…, now) → that edge absent */ });
test('a correct plan decodes to steps and the path it walks', () => {
  // plan: move-left t3_0 t2_0, move-left t2_0 t1_0, pickup target t1_0, move-left t1_0 t0_0, putdown target t0_0
  // steps: left, left, pickup, left, putdown; path: (3,0) (2,0) (1,0) (0,0)
});
test('the decoder accepts the client format and plain text in any letter case', () => {
  // [{ action: 'MOVE-LEFT', args: ['T3_0', 'T2_0'] }] and ['(move-left t3_0 t2_0)'] both decode
});
test('wrong plans are rejected', () => {
  // unknown action → /Unknown PDDL action/; move along a missing edge → /not an edge/;
  // pickup off the parcel tile → /pickup/; plan that stops short of the goal → /goal/
});
test('planStillWorks fails once an agent stands on the path or a move was refused', () => {});
test('routeFrom gives the moves of a leg from a tile on its path, and null off the path', () => {});
```

- [ ] **Step 2: Run** `node --test test/pddl-problem.test.js`. Expected: FAIL (`buildProblem` is not exported).

- [ ] **Step 3: Implement** `DOMAIN` as in the spec's "Domain" section (actions named `move-up`, `move-down`, `move-left`, `move-right`, `pickup`, `putdown`), then `buildProblem`, `decodePlan`, `planStillWorks` and `routeFrom` in `problem.js`, and add the types to `src/types.js`. Tile objects are `t<x>_<y>`. Tiles come from `map.isWalkable(x, y, now)`; crates from `map.crateTiles()` are left out explicitly; edges come from `map.neighbors(x, y, now)` between kept tiles. `buildProblem` returns null when the start or a goal tile is not among the kept tiles.

- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Stop for review.** Show the diff. After the user's OK, commit `feat: build and check PDDL plans for one intention`.

### Task 2: Planner service with timeout and circuit breaker

**Files:**
- Create: `src/planning/pddl/service.js`, `test/planner-service.test.js`, `test/pddl-client.test.js`
- Uses `courseSolver` from `src/planning/pddl/solve.js` unchanged

**Interfaces:**
- Consumes: `DOMAIN`, `decodePlan`, `ProblemSpec`, `DecodedPlan` from Task 1.
- Produces: `class PlannerService { constructor({ solve = courseSolver, timeoutMs = 10_000, breakerFailures = 3, breakerCooldownMs = 60_000, now = Date.now, log = () => {} }); plan(spec: ProblemSpec): Promise<{ status: 'ok', plan: DecodedPlan, durationMs: number } | { status: 'skipped', reason: string } | { status: 'failed', reason: string }>; get breaker(): 'closed' | 'open' | 'half-open' }`. `plan` never throws.

- [ ] **Step 1: Write the failing tests** in `test/planner-service.test.js` with a fake `solve` and a fake clock:

```js
test('a good plan is returned and logged as pddl_call then pddl_success', async () => {});
test('a timeout fails and is logged as pddl_failure', async () => { /* solve never resolves, timeoutMs: 10 */ });
test('a plan that fails the check counts as a failure', async () => {});
test('three failures in a row open the breaker and later calls are skipped', async () => {
  // after 3 failures: breaker === 'open', events include 'pddl_breaker_open';
  // 4th call → { status: 'skipped' }, solve not called, 'planner_fallback' with reason 'circuit breaker open'
});
test('after the cooldown one call goes through; success closes the breaker', async () => {
  // clock += 60_000 → 'pddl_breaker_half_open'; success → breaker 'closed', 'pddl_breaker_closed'
});
test('a failed trial call opens the breaker again', async () => {});
test('while the trial call is running, other calls are skipped', async () => {});
test('a success resets the count of failures', async () => { /* fail, fail, ok, fail, fail → still closed */ });
```

And in `test/pddl-client.test.js`, a local fake planning.domains server on a free port answering POST `/package/dual-bfws-ffparser/solve` with `{ result: '/check/1' }` and GET `/check/1` with `{ status: 'ok', result: { stdout: ' --- OK.\n', call: 'dual-bfws-ffparser', output: { plan: '(move-left t1_0 t0_0)\n; cost = 1\n' } } }`:

```js
test('courseSolver reaches the solver set by PAAS_HOST and returns the plan', async () => {
  // set process.env.PAAS_HOST before the first import of solve.js (dynamic import inside the test)
  // const plan = await courseSolver(DOMAIN, problem) → [{ action: 'move-left', args: ['t1_0', 't0_0'] }]
});
```

- [ ] **Step 2: Run** `node --test test/planner-service.test.js test/pddl-client.test.js`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `PlannerService` in `service.js` following the spec's "The solver" section. Log `pddl_call` with the problem's size (`objects`, `edges`), `pddl_success` with `durationMs` and `actions`, `pddl_failure` with `reason` and `durationMs`.

- [ ] **Step 4: Run** both test files, then `npm test` and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Stop for review,** then commit `feat: call the online solver with a timeout and a circuit breaker`.

### Task 3: Plan archive

**Files:**
- Create: `src/plans/archive.js`, `test/plan-archive.test.js`

**Interfaces:**
- Consumes: `PlanGoal`, `DecodedPlan`.
- Produces: `archiveKey(goal: PlanGoal, from: Position, carried: number): string` (for example `trip 3,0>1,0>0,0 c0`, `deliver 3,0>0,0 c2`, `pickup 3,0>1,0 c1`); `class PlanArchive { constructor({ size = 500 }); get(key: string): DecodedPlan | undefined; set(key: string, plan: DecodedPlan): void; delete(key: string): void; get count(): number }`.

- [ ] **Step 1: Write the failing tests:**

```js
test('the key is made of the start, parcel and delivery tiles and the carried count', () => {
  assert.equal(archiveKey({ kind: 'trip', parcelAt: { x: 1, y: 0 }, deliverAt: { x: 0, y: 0 } }, { x: 3, y: 0 }, 0), 'trip 3,0>1,0>0,0 c0');
  assert.notEqual(archiveKey(goal, from, 0), archiveKey(goal, from, 1));
});
test('a stored plan is found again', () => {});
test('when full, the plan unused for longest is dropped', () => {
  // size 2: set a, set b, get a, set c → b gone, a and c kept
});
```

- [ ] **Step 2: Run** `node --test test/plan-archive.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** with a `Map` in use order (delete and set again on `get`).
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Stop for review,** then commit `feat: archive plans by the places they connect`.

### Task 4: Movement takes its route from the caller

**Files:**
- Modify: `src/plans/moveTo.js` (remove `route()`, `plannerCalled`, `mode`, `solve`, `pddlTimeoutMs` and the `solveNavigation` import)
- Modify: `src/planning/pddl/solve.js` (delete `solveNavigation`), `src/planning/pddl/problem.js` (delete `buildNavigationProblem`, `decodeNavigationPlan`)
- Modify: `src/index.js`, `src/llm/game/runtime.js` (stop passing `mode` and `pddlTimeoutMs` to `MovementRunner`; the settings themselves change in Task 7)
- Modify: `test/stage1-helpers.js` (drop `mode` and `solve`), `test/plans.test.js` (drop PDDL-mode cases, add the new ones)
- Delete: `test/pddl.test.js`

**Interfaces:**
- Produces: `MovementRunner#moveTo(target: Position, signal: StopSignal, { route = null, takeRoute = null }?: { route?: Direction[] | null, takeRoute?: (() => Direction[] | null) | null }): Promise<{ status, reason? }>`. `route` is used as the first route instead of A\*. `takeRoute` is asked before every move; a non-null answer becomes the route from the agent's current tile. Both routes are still checked with `followable` before each move, and replaced by A\* when blocked, as today.

- [ ] **Step 1: Write the failing tests** in `test/plans.test.js`:

```js
test('moveTo follows a route it is given instead of computing one', async () => {
  // stage1World({ rows: ['3333', '2333'], x: 3 }) starts at (3,0); target (0,1).
  // Give route ['up', 'left', 'left', 'left'] (A* would also accept left-first);
  // the moves sent are exactly up, left, left, left.
});
test('moveTo switches to the route takeRoute returns', async () => {
  // takeRoute returns null for the first move, then a route; the moves after match it
});
test('a given route that becomes blocked is replaced by A*', async () => {});
```

- [ ] **Step 2: Run** `node --test test/plans.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the options in `moveTo` and remove the PDDL code. Update the class comment to say routes come from the Plan Library.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS. Tests that used `mode: 'pddl'` in `stage1World` are deleted in this task, since their behaviour moves to Task 6.
- [ ] **Step 5: Stop for review,** then commit `refactor: let the movement runner take its route from the plan library`.

### Task 5: Pickup options carry their delivery tile

**Files:**
- Modify: `src/deliberation/options.js:225`, `src/types.js` (Option gets `deliverX?: number`, `deliverY?: number`, "for a pickup: where the trip delivers")
- Test: `test/options.test.js`

**Interfaces:**
- Produces: every `pickup` option from `listOptions` has `deliverX`, `deliverY`, taken from `single.target` (the delivery tile of the direct trip).

- [ ] **Step 1: Write the failing test:**

```js
test('a pickup option names the delivery tile its trip ends on', () => {
  // readyBeliefs(['2331332'], { x: 3, y: 0 }) with a free parcel on (5,0):
  // the direct trip ends on the delivery tile (6,0), so option.deliverX === 6 and option.deliverY === 0
});
```

- [ ] **Step 2: Run** `node --test test/options.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** by adding `deliverX: single.target.x, deliverY: single.target.y` to the pushed option.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Stop for review,** then commit `feat: keep the delivery tile of a pickup trip on its option`.

### Task 6: The Plan Library runs trips with archived and solver plans

**Files:**
- Modify: `src/plans/library.js`
- Create: `test/plan-library-planner.test.js`

**Interfaces:**
- Consumes: `buildProblem`, `planStillWorks`, `routeFrom` (Task 1); `PlannerService` (Task 2); `PlanArchive`, `archiveKey` (Task 3); `moveTo(target, signal, { route, takeRoute })` (Task 4); `Option.deliverX/deliverY` (Task 5).
- Produces: `new PlanLibrary({ ...today's setup, planner = null, archive = null })`, where `planner` is a `PlannerService` or null (off). `execute(option, signal)` keeps its signature and outcomes.

Behaviour, from the spec's "The Plan Library" and "Running the plan" sections:
- The goal of an option: `pickup` with `deliverX` is a `trip`; `pickup` without it is a `pickup` goal; `deliver` is a `deliver` goal; `explore` and `goto` never use the planner.
- Standing where the next action happens: act at once, without the planner.
- Archive hit that passes `planStillWorks`: log `plan_archive_hit` and `pddl_plan_used` with `from: 'archive'`, walk its legs with `route`. A hit that fails the check counts as a miss, and its entry is deleted.
- Miss: log `plan_archive_miss`, start the A\* walk at once, and call `planner.plan(spec)` without awaiting it. When it answers `ok`, archive the plan under the key of the intention's start; if the intention is still on that walk and `routeFrom` gives a route from the agent's tile, `takeRoute` hands it over once and `pddl_plan_used` is logged with `from: 'solver'`; otherwise `pddl_plan_unused` with `walk finished`, `off the plan path` or `intention ended`.
- A trip is two legs in one intention: walk to the parcel, the existing pickup code, walk to `(deliverX, deliverY)`, the existing putdown code. It completes only after the putdown.
- `applicable` for a trip: the parcel is free or carried by the agent, and the delivery tile still has a delivery multiplier above 0.

- [ ] **Step 1: Write the failing tests** with `stage1World` (a `planner` built on a fake `solve` that answers a fixed plan, resolving after a delay the test controls):

```js
test('a trip picks up, walks to its delivery tile and puts down in one intention', async () => {
  // option { type:'pickup', parcelId:'p', x:1, y:0, deliverX:0, deliverY:0 } → completed; actions: moves, pickup, move, putdown
});
test('on a miss the agent walks with A* at once and archives the plan that arrives later', async () => {
  // the solver resolves only after the walk ends → plan_archive_miss, pddl_plan_unused 'walk finished', archive.count === 1
});
test('the next same trip uses the archived plan without calling the solver', async () => {
  // plan_archive_hit, pddl_plan_used from 'archive', solver calls still 1
});
test('a plan that arrives during the walk takes over from the agent's tile', async () => {});
test('an archived plan over a refused move is not used and is replaced', async () => {});
test('a parcel taken while planning: nothing is sent, the plan is archived, unused says intention ended', async () => {});
test('a trip that starts on the parcel tile picks up at once and still walks to deliver', async () => {});
test('with the planner off, trips run on A* and nothing is logged about plans', async () => {});
test('explore and goto never call the planner', async () => {});
```

- [ ] **Step 2: Run** `node --test test/plan-library-planner.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** in `library.js`. Keep `#confirmCarried`, `#putdown`, `#navigate` and `deliverOnTheWay` as they are; pass `route` and `takeRoute` through `#navigate` to `moveTo`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS (including `test/plans.test.js`, whose pickup options have no `deliverX` and so keep today's behaviour).
- [ ] **Step 5: Stop for review,** then commit `feat: run trips from archived or background PDDL plans in the plan library`.

### Task 7: Remove the task planner and wire the new settings

**Files:**
- Modify: `src/intentions/agent.js` (remove `taskPlanning`, `taskPlan`, `taskDeclined`, `#taskChoice`, `#nextPlannedOption` and the call in `start()`), `src/config.js`, `src/types.js` (AppConfig), `src/index.js`, `src/llm-agent.js`, `src/llm/game/runtime.js`, `src/course/validation-runner.js:109`, `src/course/audit.js:10`, `.env.example`, `docs/SETUP.md`
- Delete: `src/planning/pddl/task-problem.js`, `solveTasks` in `src/planning/pddl/solve.js` (leaving only `courseSolver`), `test/pddl-task.test.js`, `test/task-planning-agent.test.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `AppConfig` gains `planner: 'disabled' | 'online'`, `pddlTimeoutMs` (default 10000), `pddlBreakerFailures` (3), `pddlBreakerCooldownMs` (60000), `planArchiveSize` (500), and loses `mover` and every `taskPlanner*` field. `createGameRuntime` takes `planner?: PlannerService | null` instead of `mover` and `pddlTimeoutMs`.

- [ ] **Step 1: Write the failing tests** in `test/config.test.js` (replacing the `MOVER is pddl unless…` and task planner tests):

```js
test('PLANNER is online by default', () => assert.equal(loadConfig({}).planner, 'online'));
test('MOVER still works when PLANNER is unset', () => {
  assert.equal(loadConfig({ MOVER: 'astar' }).planner, 'disabled');
  assert.equal(loadConfig({ MOVER: 'pddl' }).planner, 'online');
  assert.equal(loadConfig({ MOVER: 'astar', PLANNER: 'online' }).planner, 'online');
});
test('PLANNER rejects other values', () => assert.throws(() => loadConfig({ PLANNER: 'http' }), /PLANNER must be disabled or online/));
test('planner timings and archive size have their defaults', () => {
  const c = loadConfig({});
  assert.equal(c.pddlTimeoutMs, 10000); assert.equal(c.pddlBreakerFailures, 3);
  assert.equal(c.pddlBreakerCooldownMs, 60000); assert.equal(c.planArchiveSize, 500);
});
```

- [ ] **Step 2: Run** `node --test test/config.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the settings, then the wiring: `index.js` and `runtime.js` each build one `PlannerService` (when `planner === 'online'`) and one `PlanArchive`, and pass them to their `PlanLibrary`; `index.js` logs `planner` instead of `mode` at startup; `validation-runner.js` also sets `PLANNER` from the scenario (`pddl` → `online`, else `disabled`); `audit.js` P1-04 points at `src/planning/pddl/service.js`, `src/plans/library.js` and `test/plan-library-planner.test.js`. Remove the task planner from `agent.js` and delete its files. In `docs/SETUP.md`, replace the task planner section with a "Planner" section listing the settings table from the spec and the new log events; in `.env.example`, replace `MOVER=pddl` and the `TASK_PLANNER*` lines with `PLANNER=online` and commented defaults.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck` and `npm run release:check`. Expected: all pass; `grep -rn "TASK_PLANNER\|taskPlann\|solveNavigation\|task-problem" src test docs/SETUP.md .env.example` prints nothing.
- [ ] **Step 5: Stop for review,** then commit `refactor: remove the task planner and configure the online planner`.

### Task 8: Live check with the online solver

**Files:** none changed unless a defect is found.

- [ ] **Step 1:** Start a local Deliveroo.js server (`docs/SETUP.md` section 2) on `empty_10`, then run `AGENT=bubble PLANNER=online npm start 2>&1 | tee logs/planner-live.jsonl` for 3 minutes.
- [ ] **Step 2:** Count the events: `grep -c` for `pddl_call`, `pddl_success`, `pddl_failure`, `plan_archive_hit`, `plan_archive_miss`, `pddl_plan_used`, `pddl_plan_unused`. Expected: at least one `pddl_success` and one `plan_archive_hit`, and no move ever waits on the solver (the gap between `intention_activated` and the first `move` stays under 1 s).
- [ ] **Step 3:** Report the counts to the user. Comparing scores with the current agent on the benchmark maps, and the bears server run, are step 16 of the roadmap plan and come after this plan.
