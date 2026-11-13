# Stage 1 and Stage 1.1 verification record

This document distinguishes **previous real-game evidence supplied by the team** from **automated verification of the newly modified Stage 1.1 code**. Passing tests do not certify the final Challenge 1 evaluation.

## Previous Stage 1 live evidence (team's macOS machine, 2026-11-11)

- The official Deliveroo.js game ran at `http://localhost:8080` and the browser displayed the map, agents, parcels and scores.
- The BDI agent connected using the official SDK, navigated, picked up and delivered parcels, and increased its score in A* mode. A screenshot displayed `bubble` with 1,060 points; that value was visible after the round, so treat it as an **observed screen score** until the saved Tournament result is separately verified.
- In PDDL mode, the agent made real external planning calls to `https://solver.planning.domains:5001/`, received `pddl_success`, and executed solver-provided `MOVE_*` directions. The supplied log excerpt included successful deliveries and a score increase from 39 to 55.
- That PDDL excerpt showed successful plan latency around 3–4 seconds and repeated premature intention cancellation; pickup intentions were also falsely reported as failed even though the corresponding parcels were subsequently delivered.
- On `gamekit_test`, repeated `move_refused` / `No reachable route to destination` failures and immediate goal reselection were observed.

These observations were made with the **previous** Stage 1 code, not the fixes below.

## Stage 1.1 implementation and verification

The revised source makes targeted changes without replacing the existing BDI/A*/PDDL architecture:

1. **Pickup reconciliation** (`src/plans/library.js`, `src/beliefs/index.js`): preserve all acknowledged pickups, log acknowledgment IDs/shape, and accept the target only after an explicit acknowledgment or a positive `carriedBy === self` sensing update within a bounded interval. Missing target without evidence remains a failure.
2. **Intention stability** (`src/intentions/agent.js`): preserve applicable exploration/delivery intentions when the top option changes; commit to deliveries unless they truly become invalid or higher-priority directives override them; prevent nonurgent utility-based switches for the initial commitment interval.
3. **Failed-goal cooldown** (`src/intentions/agent.js`): after a failed/unknown plan, temporarily avoid its goal so unreachable exploration/pickup targets aren't retried immediately.
4. **Navigation diagnostics** (`src/plans/moveTo.js`): record failed edges, tile types, destination and cancellation progress while preserving the single-flight action safety contract and the required external planner invocation.
5. **Local log summary** (`scripts/summarize-run.js`): count relevant events and report successful PDDL latency without installing a dashboard or changing the game server.

Verification run on this uploaded ZIP's isolated working copy:

- `npm test`: **105 tests passed, 0 failures**, including 12 new Stage 1.1 regression tests and the previous 93 tests.
- `tsc -p jsconfig.json`: **passed** strict JS/JSDoc type checking with Node.js v22.16.0, TypeScript 5.8.3, and local Node type definitions available from the uploaded dependency snapshot.
- `node scripts/summarize-run.js <log-file>`: verified against the team's supplied PDDL excerpt (the excerpt is not a full timed round and may start/end mid-event).
- No game server or real external solver was executed **with this revised source** in the delivery environment. Post-fix live acceptance remains necessary.

## Local acceptance gate (not yet checked for Stage 1.1)

- [ ] `npm ci`, `npm test`, and `npm run typecheck` pass on the local Mac after replacing files.
- [ ] A* mode: local agent reliably collects/delivers, and the new `pickup_ack` / `pickup` events accurately reflect actual carried parcels.
- [ ] Failed route/target: cooldown prevents immediate restart of the same goal; alternative reachable goals continue.
- [ ] PDDL mode: a fresh real `pddl_success` is followed by execution of the returned moves.
- [ ] Browser's three-minute round completed, saved score recorded, and logs summarized for both modes.

For commands, expected events, tokens, browser viewer and troubleshooting, follow **[stage1_1_local_testing.md](stage1_1_local_testing.md)**.
