# Stage 2B.1 — targeted repair report

**Baseline:** `Autonomous-Software-Agents-Stage2B.zip` (Stage 2A included).
**Evidence:** real user log 2026-11-12 UTC: pickup `p47` confirmed
10:01:13.426; first delivery movement 10:01:21.582; target reached
10:01:22.910; `deliver_parcels` failed; subsequent `get_game_state`
showed no carried parcels, score stayed zero. LLM ended
`stalled/no_tool_calls` at 10:01:53.925. Parcel expiry is a reasonable
hypothesis because `oval_counterclockwise` decays reward every second, but
the log does not contain the server expiration event.

## Changes

1. Added LLM-visible `collect_and_deliver(parcel_id)` tool. Pickup and
   delivery use the *existing* validated Stage 1.1 plans and same action
   gate; no second LLM decision after pickup. Failed or vanished parcels
   cannot be reported as delivered. This is a high-level tool selected by
   the LLM, not a new hardcoded game-play BDI policy.
2. Added bounded native-tool-call retry: one corrective prompt after a
   prose-only reply, then stop if the model again declines tool calls.
   Never treats prose as evidence of success.
3. Refreshes observations after tool failures when the outcome is known;
   unknown outcomes remain blocked. Logs truncated `errorMessage`.
4. Documented recovery and exposed `llm_no_tool_calls` in summarizer.

## Verification in this environment

- `node --test`: **150 tests passed, 0 failed** (including original Stage 1
  and Stage 2A tests, disappearing parcel cases, native prose recovery,
  macro tool behavior, and genuine Stage 1.1 movement/putdown test fixture).
- `tsc -p jsconfig.json`: **passed**, no errors.
- Real local Ollama + Deliveroo.js retest: **NOT performed here**.

## Remaining caveats

- The precise reason `p47` disappeared is unconfirmed without server-side
  parcel lifecycle events or its pickup-time remaining reward.
- Some low-value parcels may still expire even when there is no additional
  LLM delay; later optimize selection using ETA and predicted reward.
- A 4B model can still choose separate tools or decline to call tools, so
  the single-run success rate must be measured locally.
- Stage 2C communication is not implemented in this patch.
