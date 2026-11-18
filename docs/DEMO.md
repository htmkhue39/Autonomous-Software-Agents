# Oral-exam demonstration (local game)

**Goal:** show the professor actual autonomy, not just a slide presentation or an LLM text response. Use a separate server checkout, two distinct private agent tokens, Ollama with the configured model, and a prepared terminal. Prefer a short live demonstration followed by clear saved evidence.

## Before the presentation

1. Run `npm ci`, `npm test`, `npm run typecheck`, and `npm run release:check` on the release checkout. Confirm the report is **10 pages**.
2. Start Ollama and verify the model with `ollama list`. Confirm the external PDDL service is reachable if presenting live PDDL.
3. Run the live four-scenario validator locally **before the exam**, saving `report.md`, `scenarios.csv`, and logs in a private directory. Check no JWT is in files to be shared.
4. Stop the game server before letting `course:validate` launch new game servers. Do not claim the mock `course:smoke` test is live-game evidence.

## Live demonstration sequence

**A. BDI and planning.** Show a local game, the agent's changing beliefs, pickup/delivery intentions, and route execution. For external planning, run `bdi_pddl` via the validator and point to **actual** `pddl_call` followed by `pddl_success`. If the online solver is unreachable, explain that failure transparently and show the previously recorded local successful result rather than calling an A* fallback a PDDL success.

**B. Independent LLM.** Present a natural-language objective to `milktea`. Show the Plan–Act–Observe loop: the model proposes a named tool, the application executes a validated SDK-backed plan, and a confirmed game event—not a model claim—establishes a delivery.

**C. Cooperation.** Start both players with coordination enabled; point out `BELIEF`, `CLAIM` and `RELEASE` communication, separate intentions, and a confirmed evacuation from a shared delivery tile. This behavior depends on opportunities to deliver and may not trigger during a short random game; use recorded evidence when needed.

**D. Evaluation.** Explain why an ablation changes only `LLM_DELIVERY_EVACUATION`. Display the **20-trial randomized-order results** in `evidence/ablation_trials.csv`: mean observed score C0=243.7 vs C1=376.3 (+54.4%), teammate congestion 4.7 vs 1.7 failures/round. State clearly that game seeds were uncontrolled and these were not official tournament scores.

## Backup if the live game is slow

- Use **sanitized** `evidence/local_validation_scenarios.csv` (4/4 scenarios, 60/60 checks) and the 10-page report diagrams.
- Show the exact validator commands and expected events; never show private tokens or raw log dumps without review.
- Explain one failure limitation (PDDL network, Ollama latency, blocked path or unverified official API).

## Presentation narrative

1. The environment and two independent agents.
2. Beliefs → options → intentions → plans; why the BDI approach suits reactive navigation.
3. LLM objective → memory → model → allowlisted tool → verified game event.
4. Cooperation via SDK messages; why task allocation alone did not prevent a physical bottleneck.
5. Automatic post-delivery evacuation and measured changes in congestion and throughput.
6. Reproduction steps, limitations, and future official integration work.

The exam deck is under `submission/`. It deliberately excludes internal development-stage labels. The official challenge/LLM/MCP specifications and exact deadline were not verifiable from the supplied course material; confirm directly with the instructor before submission.
