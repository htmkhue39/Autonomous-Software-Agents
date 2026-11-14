# Autonomous-Software-Agents

A BDI autonomous agent for [Deliveroo.js](https://github.com/unitn-ASA/Deliveroo.js),
built for the Autonomous Software Agents course at the University of Trento.

In Deliveroo.js, agents pick up parcels on a grid and carry them to delivery
tiles for points.

## Status

In progress. The agent plays on its own with `npm start`: it builds its
picture of the world from what the server sends, lists and scores what it
could do, commits to the best option and switches only when a clearly
better one appears (steps 1 to 6 below, covered by `npm test`). Next come
movement planned by an external PDDL planner and instructions from a
person through an LLM.

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
2. Run `npm start` and copy the value from the `[token]` line.
3. Paste it into `.env` as `TOKEN_<NAME>`, for example `TOKEN_BUBBLE=...`.

`.env` is git-ignored. Do not commit tokens.

To try other tuning values without editing code, set them in `.env` or in
front of a command, for example `REPLACE_MARGIN=1.5 npm start`. The list of
variables and their defaults is at the end of `.env.example`.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Runs the agent. Stop it with Ctrl+C, which prints the score. |
| `npm run server` | Runs a local copy of the course server on port 8080 (`GAME=<map>` picks the map; install it first with `npm run server:install`). Point the agent at it with `HOST=http://localhost:8080 npm start`. |
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
  intentions/        step 5: the intention, the loop and the switching rule
  plans/             step 6: walking, picking up and delivering
  index.js           start-up: connects the parts and runs the loop
  follow-path.js     demo: walk a predefined path
  pickup-deliver.js  demo: pick up a parcel and deliver it
test/                tests, run without a server
docs/
  project_requirement.md  what the agent must do, and why it is hard
  design.md               how the agent works, and why it was built that way
  implementation_plan.md  the order it is built in
```

To understand the project, read the three documents in that order.
