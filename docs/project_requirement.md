# Project requirements

This document describes **what the final system must demonstrate**. It separates the course's required capabilities from the team's optional design choices. See [design.md](design.md) for the chosen architecture and [implementation_plan.md](implementation_plan.md) for tasks and status.

## Goal and environment

Build autonomous JavaScript software for Deliveroo.js that earns points by collecting parcels and delivering them while handling changing observations, other agents, and failures. The environment is partially observable, and the game configuration can change between scenarios.

Use the course's Deliveroo.js SDK (`@unitn-asa/deliveroo-js-sdk`) for ordinary game sensing, actions, and communication. Game rules such as parcel decay, carrying capacity, observation range, movement duration, penalties, plugins, and delivery tiles must be read from the actual server configuration when exposed; values observed on one map are not universal rules.

## Part 1 — BDI autonomous agent

| ID | Required capability | Evidence of completion |
|---|---|---|
| P1-01 | Maintain beliefs from sensing, including belief revision | Map, self, agents and parcels update from events; stale or contradictory observations are handled. |
| P1-02 | Generate/select goals and intentions, including intention revision | The agent can commit, continue, reconsider, abandon and select new intentions when beliefs change. |
| P1-03 | Use predefined plans to achieve intentions | A plan library has applicable plans, executes actions, and handles failures. |
| P1-04 | Extend the agent with an **external automated planner** | **When an intention is activated**, the agent invokes an external planner for an executable plan; calls and results are observable in logs. |
| P1-05 | Execute plans and replan/redeliberate in a changing environment | Failed/unavailable actions or changed objectives trigger safe recovery and appropriate replanning. |
| P1-06 | Validate against the course's predefined simulations | Part 1 has repeatable test evidence and is ready for Challenge 1. |

The course specifies **planner invocation at intention activation**. An internal A* implementation alone does not meet the automated-planning extension. The particular PDDL domain, solver endpoint, route representation, utility equation, and fallback policy are implementation decisions.

## Part 2 — second LLM-based software agent

Part 2 **extends** Part 1 with a **second software agent**, not only a natural-language prompt parser attached to the BDI process.

| ID | Required capability | Evidence of completion |
|---|---|---|
| P2-01 | Second LLM-based agent | Both agents have independent identities/connections and meaningful autonomous behavior in the same game. |
| P2-02 | Interpret natural-language objectives | The LLM agent reads and interprets changing objectives supplied through the evaluation environment. |
| P2-03 | Dynamic LLM memory/context | Context incorporates the current objective, game observations, available tools, tool results and relevant teammate beliefs; it changes as events arrive. |
| P2-04 | LLM planning, tool execution and replanning | The agent uses the LLM to construct/refine a tool-executable plan, executes it, checks results and replans after important changes or failures. |
| P2-05 | Use the course-provided tool catalog | The agent can query/use the catalog supplied by the course's tool server and validate tool calls before execution. |
| P2-06 | Share information and coordinate with the BDI agent | Agents exchange beliefs and intentions and use that information to avoid contradictory or redundant tasks. |
| P2-07 | Validate against the course's predefined simulations | Part 2 demonstrates coordinated behavior and is ready for Challenge 2. |

The slides explicitly leave the **LLM-agent architecture** open. ReAct, reflection, structured planning, local memory formats, provider adapters, and task allocation algorithms are choices, not individually mandated techniques.

The course describes token-authenticated LLM infrastructure and an extended tool catalog available from a server. The exact endpoint, authentication, tool schemas and evaluation objective channel must be verified when provided. A local Ollama model is suitable for development but should **not be assumed equivalent to course infrastructure** without confirmation.

## Submission

- JavaScript source code.
- Final report of **no more than 10 pages**, explaining what was built and how it works.
- Oral project presentation.
- Project submission by the date announced by the instructors (slides say at least one week before the exam; the exact deadline is to be provided).

## Team-selected baselines (not course mandates)

The following design decisions are documented in [design.md](design.md), not imposed by the course:

- Keep the existing timestamped beliefs, A*, expected-reward utility and option generation as the baseline.
- Use a configurable, stable intention-revision rule initially based on `replaceMargin = 1.2`.
- Use the course PDDL client for the external planner; keep A* for route estimates and fallback/comparison.
- Build two cooperative agents with separate game identities, sharing reusable SDK and execution modules.
- Use local Ollama (`qwen3.5:4b-q4_K_M`) during development through a provider interface, with a second adapter for the course LLM service.
- Prefer official SDK messaging for belief and intention exchange.
- Implement advanced policies **after** both parts work, then benchmark fairly.

## External integration details to confirm

**Open course details to verify:** final LLM endpoint/model policy, tool catalog and auth, objective delivery method, enabled plugins/scenarios, challenge evaluation details, and submission deadline. Do not invent these values in code or documentation.
