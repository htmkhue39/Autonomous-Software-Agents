# Autonomous-Software-Agents

A BDI autonomous agent for [Deliveroo.js](https://github.com/unitn-ASA/Deliveroo.js),
built for the Autonomous Software Agents course at the University of Trento.

In Deliveroo.js, agents pick up parcels on a grid and carry them to delivery
tiles for points.

## Status

In progress. The agent can build its picture of the world from what the
server sends, find routes, and list and score what it could do (steps 1 to
4 below, covered by `npm test`). Choosing an intention and acting on it
(steps 5 and 6) are not written yet, so `npm start` has nothing to run.

## How the agent works

The agent repeats one loop for the whole game. Details are in
[docs/design.md](docs/design.md).

```text
        ┌──────────────────────────────────────────────┐
        │              Deliveroo server                │
        └───────┬──────────────────────────────▲───────┘
                │ sensing: tiles in view,      │ move, pickup,
                │ parcels, agents, self        │ putdown
                ▼                              │
 ┌──────────────────────────────┐              │
 │ 1. Observe the world         │              │
 │    receive what is in view   │              │
 └──────────────┬───────────────┘              │
                ▼                              │
 ┌──────────────────────────────┐              │
 │ 2. Update beliefs            │◄─────────┐   │
 │    map: tiles, refused moves │          │   │
 │    parcels: value, carrier   │          │   │
 │    agents: recent positions  │          │   │
 └──────────────┬───────────────┘          │   │
                ▼                          │   │
 ┌──────────────────────────────┐          │   │
 │ 3. Generate options          │          │   │
 │    pickup each free parcel   │          │   │
 │    deliver what is carried   │          │   │
 │    explore oldest spawn tile │          │   │
 └──────────────┬───────────────┘          │   │
                ▼                          │   │
 ┌──────────────────────────────┐          │   │
 │ 4. Score and rank            │          │   │
 │    A* route length →         │          │   │
 │    reward left at delivery   │          │   │
 └──────────────┬───────────────┘          │   │
                ▼                          │   │
 ┌──────────────────────────────┐          │   │
 │ 5. Choose intention          │          │   │
 │    keep current unless a new │          │   │
 │    one is clearly better;    │          │   │
 │    drop if parcel is taken   │          │   │
 └──────────────┬───────────────┘          │   │
                ▼                          │   │
 ┌──────────────────────────────┐          │   │
 │ 6. Plan and act              │──────────┘   │
 │    fresh A* route, take one  │  move failed │
 │    step, report the result   │  or worked   │
 └──────────────┬───────────────┘              │
                └──────────────────────────────┘
```

The loop runs again after every step. The arrow from step 6 back to step 2
is how the agent learns from its moves: a refused move goes into the
beliefs, and the next route avoids it.

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
| `npm test` | Runs the tests. |
| `npm run typecheck` | Checks the code against the types in `src/types.js`. |

To run as another agent, put its name in front:
`AGENT=milktea npm run path`.

## Project layout

```text
src/
  types.js           data structures
  config.js          settings from .env
  client.js          connection to the game
  beliefs/           step 2: map, parcels, other agents
  deliberation/      steps 3 and 4: options and their scores
  planning/          A* route finding
  observe.js         demo: print what the server sends
  follow-path.js     demo: walk a predefined path
  pickup-deliver.js  demo: pick up a parcel and deliver it
test/                tests, run without a server
docs/
  project_requirement.md  what the agent must do, and why it is hard
  design.md               how the agent works, and why it was built that way
  implementation_plan.md  the order it is built in
```

To understand the project, read the three documents in that order.
