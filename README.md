# Autonomous-Software-Agents

A BDI autonomous agent for [Deliveroo.js](https://github.com/unitn-ASA/Deliveroo.js),
built for the Autonomous Software Agents course at the University of Trento.

In Deliveroo.js, agents pick up parcels on a grid and carry them to delivery
tiles for points.

## Status

Early stage. The agent can connect to a server, move, pick up and put down
parcels, and read what the server sends. It does not make its own decisions
yet, so `npm start` and `npm test` have nothing to run.

## Setup

```bash
git clone https://github.com/htmkhue39/Autonomous-Software-Agents.git
cd Autonomous-Software-Agents
npm install
cp .env.example .env
```

Then get a token for your agent:

1. In `.env`, set `AGENT` to the name you want (default `bubble`).
2. Run `npm run observe` and copy the value from the `[token]` line.
3. Paste it into `.env` as `TOKEN_<NAME>`, for example `TOKEN_BUBBLE=...`.

`.env` is git-ignored. Do not commit tokens.

## Commands

| Command | What it does |
| --- | --- |
| `npm run observe` | Logs in and prints what the server sends, then tries a few moves. |
| `npm run path` | Walks a predefined path, then tries a pickup. |
| `npm run deliver` | Finds a parcel, picks it up and carries it to a delivery tile. |
| `npm run typecheck` | Checks the code against the types in `src/types.js`. |

To run as another agent, put its name in front:
`AGENT=milktea npm run path`.

### Predefined path

The path is the `path` list near the top of `src/follow-path.js`. Edit it to
try another route. The moves start from wherever the server places the
agent, so if a wall or another agent is in the way the run stops early with
`blocked going <direction>, stopping`.

## Project layout

```text
src/
  types.js           data structures
  config.js          settings from .env
  client.js          connection to the game
  observe.js         demo: print what the server sends
  follow-path.js     demo: walk a predefined path
  pickup-deliver.js  demo: pick up a parcel and deliver it
```
