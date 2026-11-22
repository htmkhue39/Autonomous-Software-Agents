# Stage 2A — Local Ollama smoke test (macOS / zsh)

**Scope:** Stage 2A tests structured LLM planning, a bounded tool loop, a strict tool allowlist, tool feedback, and dynamic memory. **It does not start another Deliveroo.js agent or connect to the game.** The BDI agent is unchanged and can still be tested separately.

## 1. Prerequisites

- macOS and Node.js 22.x (`node -v`)
- Ollama running on the same Mac with model `qwen3.5:4b-q4_K_M`
- Extract the Stage 2A ZIP, or update the files in your working repository. Keep your existing `.env`; never copy a template over your locally issued game token.

Open a terminal in `Autonomous-Software-Agents/`:

```bash
npm ci
npm test
npm run typecheck
ollama list
```

The provided code was verified with **130 passing tests** and a clean strict typecheck in the delivery environment. The model itself was not reachable from that environment. If `ollama list` does not show the model, run `ollama pull qwen3.5:4b-q4_K_M`.

Ensure Ollama's local HTTP service is reachable:

```bash
curl -s http://127.0.0.1:11434/api/tags | head -c 400
```

If it is not running, start it in a separate terminal with `ollama serve` (skip if the desktop app is already serving port 11434).

## 2. Check native tool calling

```bash
npm run llm:smoke
```

This is a harmless **toy-world** test, not a game run. The LLM must produce a short JSON plan, call the registered `read_demo_parcels` tool, use its result, and report completion. The tool deterministically returns two toy parcels; it does not modify a server.

Look for:

- `[llm_plan] ...` with `read_demo_parcels` in planned steps
- `[llm_tool_result] {"name":"read_demo_parcels","ok":true}`
- `Stage 2A result: {"status":"completed", ...}`
- `metrics.successfulTools >= 1`

The exact phrasing of the model's summary is not important. **A conversational `OK` or `Done` without a tool invocation is not a pass.** Model output may vary between attempts. The runner returns nonzero exit status when it fails to validate completion.

## 3. Structured JSON fallback (if native calling is unreliable)

```bash
npm run llm:smoke:json
```

This uses schema-guided JSON decisions rather than native tool_calls. The selected tool name and its arguments are still validated before execution. Report both results; do not silently switch modes when evaluating reliability.

Optional local overrides (in `.env`, or inline in the shell):

```dotenv
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:4b-q4_K_M
LLM_TIMEOUT_MS=120000
OLLAMA_THINK=false
```

The smoke test uses the settings above and currently supports `LLM_PROVIDER=ollama` only. The production course adapter is intentionally not fabricated without its published API contract.

## 4. How to interpret failures

| Output / symptom | What it means | Next check |
| --- | --- | --- |
| `Ollama unreachable` | The Ollama HTTP server cannot be reached | Verify `ollama serve`, API URL, and port 11434 |
| `LLM request timed out` | Generation took longer than the configured deadline | Increase `LLM_TIMEOUT_MS`, inspect Mac resource usage |
| `llm_plan_invalid` | The model didn't produce an allowed structured plan | Try once more; compare native vs JSON mode |
| `unknown_tool` / `invalid_arguments` | The model requested an unauthorized tool or malformed parameters | Check tools and prompt; do not disable validation |
| `status: stalled` | The model replied without using a tool | Try JSON fallback; no successful action was verified |
| `status: limit_reached` | The loop exhausted configured steps/calls | Inspect model decisions; do not raise limits blindly |
| `status: reported_completed` | Model reported completion, but no objective verifier was supplied | Add an external completion checker in Stage 2B |
| `status: completed` | Demo verification confirmed the tool evidence | Stage 2A local smoke passed |

## 5. What Stage 2A does **not** prove

- It does not demonstrate live parcel collection by an LLM-controlled player.
- It does not test sending messages to `bubble`, two game tokens, or the professor's tool server.
- The course API credentials, catalog contract, and objective delivery channel are still unavailable.
- It does not show the model is competitive in a 3-minute tournament.

Once you obtain a successful local smoke test, preserve the terminal output (without tokens) and proceed to a separate **Stage 2B approval**: an independent `milktea` agent using curated game observations and high-level SDK-backed tools. Stage 2C then adds actual BDI–LLM cooperation.

## 6. Recheck Stage 1 if desired

The previously tested BDI command remains `HOST=http://localhost:8080 MOVER=astar npm start`. Stage 2A does not alter `src/index.js`, the utility function, PDDL, or game SDK. The game server is not needed for the Ollama smoke command.
