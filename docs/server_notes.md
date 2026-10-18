# Server and SDK notes

Facts gathered while building the agent, and questions still open. Update
this file after every live check. Design: [design.md](design.md).

## Facts confirmed from the package sources

- `DjsConnect(host, token, name)` reads `HOST`, `TOKEN`, `NAME` from env by
  default. Connecting with a name and no token makes the server issue a
  token through the `token` event.
- `socket.onSensing(({ positions, agents, parcels, crates }) => ...)`:
  one event carries everything in view; `positions` lists the observed
  tiles.
- `socket.emitMove(direction)` resolves to `{x, y}` or `false`, and
  **rejects** if the server does not acknowledge within 1000 ms. `emitPickup`
  and `emitPutdown` resolve to arrays of parcels.
- Server config holds `PENALTY` (points lost for a wrong move) and
  `GAME.player.movement_duration`, `observation_distance`, `capacity`, and
  `GAME.parcels.decaying_event` (`1s`, `2s`, `5s`, `10s`, `infinite`, ...).
  Because failed moves cost points, the agent must avoid moves it believes
  will fail rather than rely on retrying.
- `onlineSolver(domainString, problemString)` resolves to
  `[{ parallel, action, args }]` or `undefined`, and has no timeout of its
  own. `PddlProblem.toPddlString()` hard-codes the domain name `default`.

## Observed on the course server (Task 1, 2026-10-13)

Map `long_hallways`, 20 x 20, via `npm run observe`.

- **No `you` event.** The server reports the agent's own state as
  `sensing.self` (`id`, `name`, `x`, `y`, `score`, `penalty`, `rotation`,
  `attributes`). `client.onYou` in `src/client.js` covers both sources.
- **`socket.token` and `socket.me` are undefined** on the socket that
  `DjsConnect` returns. Listen for the `token` event directly. A token is
  sent only when connecting by name; each such connection creates a new
  agent id, so the token is saved in `.env`.
- **`onMap` reports 19 x 19 for a 20 x 20 map** (it sends the highest index,
  not the size). Derive width and height from the tiles: highest `x` plus 1
  and highest `y` plus 1. The map also arrives as 400 separate `tile`
  events.
- **Sensing is sent on change**, not continuously, and also carries `frame`
  and `entities`. A free parcel has `carriedBy: null`.
- **Positions are fractional mid-move** (for example `y: 18.6`).
- `movement_duration` is 50 ms; a successful move took 150 to 200 ms round
  trip and a move into a wall returned `false` in about 40 ms, so the
  1000 ms acknowledgement timeout is not a concern here.
- `decaying_event` is `1s`, `generation_event` `2s`, at most 5 parcels,
  `reward_avg` 30, `capacity` 5, `observation_distance` 5, `PENALTY` 1,
  `CLOCK` 50, one random NPC.
- Tile types present: `0`, `1`, `2`, `3` only. No arrow or crate tiles on
  this map.
- The agent is placed on a different tile at each connection.

## Found in the course repo (unitn-ASA/DeliverooAgent.js, read 2026-10-13)

- **Client confirmed.** Lab 1 and every example import
  `DjsConnect` from `@unitn-asa/deliveroo-js-sdk/client`, with SDK 1.3.10
  and `pddl-client` 1.7.7, the versions used here. The repo's top-level
  README still mentions `deliveroo-js-client`; that line is out of date.
- **Lab 1's event list is partly out of date.** It shows `you`,
  `agentsSensing` and `parcelsSensing`; the server observed in Task 1 sends
  one `sensing` event instead.
- **LLM provider.** `lab8-LLMs` uses the `openai` npm package against an
  OpenAI-compatible LiteLLM endpoint: `LITELLM_BASE_URL` (default
  `https://llm.bears.disi.unitn.it/v1`), `LITELLM_API_KEY`, and model
  `LOCAL_MODEL` (default `llama-3.3-70b-lmstudio`).
- **Instructions arrive as in-game chat.** `missionAgents/` holds moderator
  agents that shout a natural-language mission to all agents and award
  bonus or penalty points: go to given coordinates, deliver at a given
  tile, answer a question by chat, deliver exactly N parcels at a time,
  deliver parcels with total reward at or below a threshold, one agent
  picks up and another delivers, and red light / green light (stop moving
  until told to go). A `challenge2` folder holds maps for these.
- Other course hosts: `https://deliveroojs.azurewebsites.net/` and
  `https://deliveroojs.bears.disi.unitn.it/` (university VPN).

**Proposed change to Part 2, not yet applied to the plan:** take
instructions from `socket.onMsg` as well as the terminal, and extend the
directive set to cover the missions above: `deliverAt(x, y)`,
`answer(text)` sent with `emitSay`/`emitShout`, `deliverExactly(n)`,
`maxDeliveryReward(n)`. `goto`, `pause` and `resume` already cover the
coordinate and red-light missions.

## Open items

- **Energy.** The config has a `GAME.energy` section (`initial` 100,
  `move_cost` 1, `pickup_cost` 1, `putdown_cost` 1, recharge 10 every 5 s,
  `batteries_generation_event` 5s). The agent's energy level did not appear
  in `sensing.self`, and this design does not model it. Ask the course
  staff whether energy is active and how to read it; if it is, moves become
  a budgeted resource and the utility function needs an energy term.
- The movement rule on directional tiles (`← ↑ → ↓`) and crates; not
  testable on this map. Until confirmed, treat crate tiles and tiles
  holding a crate as not walkable.
- Confirm with the course staff that the Part 2 evaluation uses the
  mission agents, and get a `LITELLM_API_KEY`.
- Whether `solver.planning.domains:5001` is reachable and fast enough from
  the user's network, or a different `PAAS_HOST` is needed.
