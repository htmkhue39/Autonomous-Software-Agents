# Stage 4C — Local End-to-End Course Readiness

**Results:** 1/1 scenarios passed.

| Scenario | Result | Evidence |
|---|---|---|
| bdi_pddl | PASS | bdiIntentions=1, pddlCalls=2, pddlSuccess=1 |

## Evidence gaps

- No missing evidence within these local scenarios.

## Interpretation and limitations

- These scenarios use local live Deliveroo.js servers. A separate mock-server process test is NOT live evidence.
- The result is **course readiness**, not official Challenge 1/2 certification.
- External PDDL success depends on the real external online solver being reachable.
- Optional external instructor LLM/MCP endpoints are **not verified**; local Ollama and SDK tools are used here.
- Objective replacement uses a local stdin NDJSON test channel; the official delivery contract remains unspecified.
- Scenario timeouts are maximum observation windows, not comparable fixed-duration performance benchmarks.
- Failure recovery is covered by deterministic simulator/regression tests separately and should not be called a live fault-injection success.
- Retain raw logs locally; do not publish JWTs or private runtime evidence without review.

## Raw evidence

Each scenario directory contains `server.log`, agent JSONL logs and `result.json` with individual pass/fail checks.
