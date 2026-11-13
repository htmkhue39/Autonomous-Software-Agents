# Stage 3C.2 — Verification report

Source baseline: `Autonomous-Software-Agents-Stage3A1.zip`.

## Scope

- Added `selectDeliveryParking` in `src/llm/game/evacuation.js`: a bounded search of currently reachable tiles with static cut-point avoidance where possible, selecting a non-delivery destination.
- `deliverCarried()` now optionally clears the delivery tile *after acknowledged putdown*, before a model call. All existing delivery tools use this common helper.
- `LLM_DELIVERY_EVACUATION` defaults on only when cooperation is enabled, preserving independent B's legacy action results and execution logic. Explicit true/false override is logged.
- Added CSV/report metrics for LLM evacuation attempts/outcomes, right-censored delivery-tile dwell measurements, and congestion failures attributable to a teammate or NPC.
- Kept Stage 3A.1 timing validity and score-source labeling unchanged.

## Tests

The project now has **236 unit/integration tests** (224 pre-existing + 12 new), all passing. Added nine evacuation checks and three benchmark-telemetry checks, including a real Stage 1.1 simulator path through PlanLibrary/MovementRunner/ActionGate.

Scenarios: acknowledged delivery is followed by a move off the tile; failed putdown cannot trigger evacuation; known evacuation failure preserves delivery; unknown move outcome remains uncertain and cannot retry; occupied exit skipped; one-way edge respected; side-pocket parking preference; disabled baseline identical result shape; high-level collect-and-deliver also evacuates; dwell and congestion metrics exported.

Type checking passed using locally installed Node type definitions. This clean ZIP intentionally excludes `node_modules`. JavaScript syntax checks and patch verification should also pass.

## Not tested yet

- Live Mac + Deliveroo.js + Ollama Stage 3C.2 performance.
- Actual cooperative score improvement. Repeated controlled rounds remain essential.
- Reactive teammate traffic yielding (Layer 2) is not part of this release.
