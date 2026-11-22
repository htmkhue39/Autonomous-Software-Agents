# Stage 2B verification report

**Source baseline:** `Autonomous-Software-Agents-Stage2A.zip` (66 source/docs/test files). Existing Stage 1.1 BDI entry point, belief revision, utilities, intention controller, PDDL, A*, MovementRunner and PlanLibrary were preserved. Stage 2B extends the Stage 2A LLM tool registry/loop and adds game-specific components and a separate entry point.

## Automated results

- `node --test`: **144 passed / 144 total**.
- `tsc --noEmit -p jsconfig.json`: **passed** (with an available global TypeScript and Node type definition set; `npm ci` could not complete in this isolated container).
- Stage 2B-specific tests: **14 passed**, including argument allowlisting, parcel disappearance, limited capacity, unreachable delivery location, unknown action outcomes, objective parsing, read-only evidence rejection, readiness, and real Stage 1.1 movement/pickup/delivery plans in a deterministic fake game.
- All original **130 Stage 2A and BDI tests remain passing**.
- No new runtime npm packages or external services are required by the Stage 2B source beyond the existing project dependencies, but `npm ci` is required on a fresh Mac checkout.

## Important verification limits

- This environment cannot connect to the user's running local Deliveroo.js server or Ollama model. **A live, independent `milktea` game session has not been demonstrated here.**
- The user previously completed the real Stage 2A native Qwen smoke test (4 LLM calls, 2 tool calls, 0 invalid tools). This establishes Stage 2A model tool capability, **not** Stage 2B real game success.
- Objective completion is currently constrained to local score and delivery criteria; the professor's unpublished challenge objective channel, token-authenticated model endpoint and tool catalog are not implemented.
- Real multiagent communication, shared beliefs and parcel assignment are **Stage 2C** and are not claimed as completed.

## Next acceptance gate

On macOS, follow `docs/stage2b_local_testing.md`. Capture a live `game_objective_result` with `status:"completed"` and `reason:"verified"`, plus a genuine pickup and delivery event from `milktea`. Run the JSON fallback only if necessary. Compare performance only after completing a controlled local scenario and retain the baseline code.
