# Stage 2C.1 — Implementation verification report

## Base

- Source: `Autonomous-Software-Agents-Stage2C.zip` (Stage 2C, 162 tests).
- Existing independent BDI (`bubble`) and LLM (`milktea`) entrypoints retained.
- Coordination remains opt-in (`COORDINATION_ENABLED=true`).

## Changes

1. **Congestion classification and bounded waiting:** When no executable route is found, perform a *diagnostic-only* A* search ignoring temporary occupancy, refused edges, and temporary map blocks. The search **still respects walls and one-way arrows**. If an observed peer occupies the static route, wait up to 3500 ms by default; if the route is statically impossible, fail promptly. Do not send illegal moves or blindly retry unknown SDK outcomes. Log `navigation_wait`, `navigation_recovered`, and structured `navigation_failed` with blocker identities and observation ages.
2. **Delivery-target fallback:** If every delivery tile is temporarily occupied, allow a statically reachable destination to be selected; the movement executor must still wait for safe passage.
3. **Parcel viability:** A pure ranking module scores each known parcel based on static A* pickup/delivery route lengths, movement duration, 4-second assumed action overhead, 2-second safety margin, and estimated reward decay. It labels `viable`, `expectedDeliveryReward`, `blockedNow`, and team-claim status. Unviable targets are rejected by tools before execution; Qwen still selects targets. Values are estimates, not guarantees.
4. **Cooldown and inventory recovery:** Failed pickup targets receive an 8-second cooldown and appear consistently invalidated in subsequent tool lists and model observations. Failed delivery logs a reinspection of carried beliefs. Ambiguous action outcomes remain `outcome_unknown` and are never blindly retried.
5. **Traffic throttling:** STATUS periodic broadcasts at most every 6 seconds (immediate intention changes still broadcast), BELIEF snapshots at least 4 seconds apart during heartbeats with 10-second periodic refresh, while claims continue on the existing 2-second lease renewal cadence. Manual BELIEF sync and HELLO discovery remain immediate.
6. **Metrics:** Add `invalidToolCalls`, `failedGameActions`, `uncertainOutcomes`, retaining `invalidTools` as a **legacy aggregate** for comparisons with Stage 2C. Expand cooperation log summary with navigation and recovery counts.

## Automated validation

- Existing suite: 162 cases.
- New focused Stage 2C.1 cases: 13.
- **Total: 175 passing, 0 failing** using Node.js 22.16.0 `node --test`.
- **Strict JSDoc/JavaScript check passed** using locally installed TypeScript 5.8.3 `tsc -p jsconfig.json`.
- New tests cover static route diagnostics, one-way arrows, fractional occupied positions, congestion clearing, congestion timeout, cancellation, permanently unreachable paths, parcel ranking, low-value rejection, failed-target cooldown, inventory reconciliation, separated metrics, status/belief throttling, and delivery selection with an occupied target.

## Not verified here

- Actual Deliveroo.js SDK communication with two live user tokens.
- Ollama/Qwen inference against the installed local model.
- Saved 3-minute Tournament score or repeated empirical improvement over Stage 2C.
- Performance with a local or external PDDL planner on a live map after congestion handling.

Use `docs/stage2c1_local_testing.md` for the Mac verification sequence and preserve old Stage 2C logs for comparison.
