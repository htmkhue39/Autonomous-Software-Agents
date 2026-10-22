/**
 * Every data structure the agent works with, defined once. Other files
 * refer to these with `import('./types.js').Name` in JSDoc.
 *
 * The server types describe what the course server actually sends (observed
 * with `npm run observe`), which differs in places from the SDK's own types.
 */

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

/**
 * A tile coordinate. `right` is x + 1, `up` is y + 1.
 * @typedef {{ x: number, y: number }} Position
 */

/** @typedef {'up' | 'down' | 'left' | 'right'} Direction */

/**
 * Key of a tile in maps and sets: `${x},${y}`.
 * @typedef {string} TileKey
 */

// ---------------------------------------------------------------------------
// What the server sends
// ---------------------------------------------------------------------------

/**
 * '0' wall, '1' parcel spawner, '2' delivery, '3' walkable, '4' base,
 * '5' crate sliding tile, '5!' crate spawner, arrows are directional tiles.
 * @typedef {'0' | '1' | '2' | '3' | '4' | '5' | '5!' | '←' | '↑' | '→' | '↓'} TileType
 */

/**
 * @typedef {Object} Tile
 * @property {number} x
 * @property {number} y
 * @property {TileType} type
 */

/**
 * An agent as the server reports it. Coordinates are fractional while the
 * agent is between two tiles (for example y: 18.6).
 * @typedef {Object} AgentState
 * @property {string} id
 * @property {string} name
 * @property {number} x
 * @property {number} y
 * @property {number} score
 * @property {number} [penalty]
 * @property {string} [teamId]
 * @property {string} [teamName]
 */

/**
 * @typedef {Object} Parcel
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} reward
 * @property {string | null} [carriedBy]  id of the carrying agent, null when free
 */

/**
 * @typedef {Object} Crate
 * @property {string} id
 * @property {number} x
 * @property {number} y
 */

/**
 * One `sensing` event: everything within observation distance. Sent when
 * something changes, not on a timer.
 * @typedef {Object} Sensing
 * @property {number} [frame]
 * @property {Position[]} positions   tiles currently observed
 * @property {AgentState[]} agents    other agents in view
 * @property {Parcel[]} parcels
 * @property {Crate[]} crates
 * @property {AgentState} [self]      this agent's own state
 */

/**
 * How often something happens on the server clock.
 * @typedef {'frame' | '1s' | '2s' | '5s' | '10s' | '1m' | '1h' | 'infinite'} ClockEvent
 */

/**
 * @typedef {Object} ParcelRules
 * @property {ClockEvent} generation_event
 * @property {ClockEvent} decaying_event   a parcel loses 1 reward per event
 * @property {number} max
 * @property {number} reward_avg
 * @property {number} reward_variance
 */

/**
 * @typedef {Object} PlayerRules
 * @property {number} movement_duration     milliseconds per move
 * @property {number} observation_distance  tiles
 * @property {number} capacity              parcels carried at once
 */

/**
 * @typedef {Object} EnergyRules
 * @property {number} initial
 * @property {number} move_cost
 * @property {number} pickup_cost
 * @property {number} putdown_cost
 * @property {ClockEvent} recharge_event
 * @property {number} recharge_amount
 * @property {ClockEvent} batteries_generation_event
 */

/**
 * @typedef {Object} GameRules
 * @property {string} title
 * @property {string} description
 * @property {{ width: number, height: number, tiles: string[] }} [map]  one string per row
 * @property {ParcelRules} parcels
 * @property {PlayerRules} player
 * @property {EnergyRules} [energy]
 */

/**
 * The `config` event.
 * @typedef {Object} ServerConfig
 * @property {number} CLOCK     milliseconds per frame
 * @property {number} PENALTY   points lost per wrong move
 * @property {number} AGENT_TIMEOUT
 * @property {GameRules} GAME
 */

// ---------------------------------------------------------------------------
// Our own structures
// ---------------------------------------------------------------------------

/**
 * Settings from `.env` and tuning constants (src/config.js).
 * @typedef {Object} AppConfig
 * @property {string} host
 * @property {string | undefined} token
 * @property {string} name
 * @property {'astar' | 'pddl'} mover
 * @property {number} replaceMargin    a new option must beat the current one by this factor
 * @property {number} blockedTtlMs     how long a refused move is first avoided; doubles on each repeat
 * @property {number} maxBlockedMs     the longest a refused move is ever avoided
 * @property {number} agentTtlMs       how long a sighted agent counts as an obstacle
 * @property {number} maxMoveRetries
 * @property {number} pddlTimeoutMs
 */

/**
 * The connection to the game (src/client.js). Actions never reject: a
 * failed move is `false`, a failed pickup or putdown is `[]`.
 * @typedef {Object} Client
 * @property {any} socket  the SDK socket, for anything not wrapped here (messages, token event)
 * @property {(dir: Direction) => Promise<Position | false>} move
 * @property {() => Promise<{ id: string }[]>} pickup
 * @property {() => Promise<{ id: string }[]>} putdown
 * @property {(callback: (config: ServerConfig) => void) => void} onConfig
 * @property {(callback: (width: number, height: number, tiles: Tile[]) => void) => void} onMap
 * @property {(callback: (tile: Tile) => void) => void} onTile
 * @property {(callback: (sensing: Sensing) => void) => void} onSensing
 * @property {(callback: (me: AgentState) => void) => void} onYou
 */

/**
 * Something the agent could commit to, produced by deliberation.
 * `priority` 1 marks a user goal, which outranks any autonomous option.
 * @typedef {Object} Option
 * @property {string} id          short name that stays the same while the option does,
 *                                e.g. 'pickup:p1', 'deliver', 'explore:4,0'
 * @property {'pickup' | 'deliver' | 'explore' | 'goto'} type
 * @property {number} x
 * @property {number} y
 * @property {number} utility     expected reward on delivery
 * @property {0 | 1} priority
 * @property {string} [parcelId]  for 'pickup'
 * @property {string} [goalId]    set when the option comes from a user goal
 */

/**
 * Set to stopped when the running intention is replaced.
 * @typedef {{ stopped: boolean }} StopSignal
 */

/**
 * Limits on pathfinding, shared by the A* and PDDL planners.
 * @typedef {Object} PathOptions
 * @property {number} now                                    milliseconds
 * @property {Set<TileKey>} [occupied]                       tiles held by other agents
 * @property {(x: number, y: number) => boolean} [forbidden] tiles ruled out by directives
 */

/**
 * @typedef {{ x1: number, y1: number, x2: number, y2: number }} Rect
 */

/**
 * An instruction from the user, produced by the LLM agent and validated
 * before use.
 * @typedef {{ type: 'goto', x: number, y: number }
 *   | { type: 'pickup', parcelId: string }
 *   | { type: 'deliverNow' }
 *   | { type: 'pause' } | { type: 'resume' } | { type: 'clear' }
 *   | { type: 'avoidArea', rect: Rect }
 *   | { type: 'stayInArea', rect: Rect }
 *   | { type: 'minParcelReward', value: number }
 *   | { type: 'maxCarried', value: number }} Directive
 */

/** @typedef {'pending' | 'active' | 'done' | 'failed'} GoalStatus */

/**
 * A user goal being tracked by the agent.
 * @typedef {Object} Goal
 * @property {string} id
 * @property {Directive} directive
 * @property {GoalStatus} status
 * @property {string} [reason]  why it failed
 */

export {};
