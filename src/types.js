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
 * '5' crate sliding tile, '5!' crate spawner, '6' battery spawner, '7' door,
 * '8' key spawner, '9' double delivery, arrows are directional tiles.
 * @typedef {'0' | '1' | '2' | '3' | '4' | '5' | '5!' | '6' | '7' | '8' | '9' | '←' | '↑' | '→' | '↓'} TileType
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
 * @property {Attribute[]} [attributes]  e.g. warnings, energy
 * @property {string} [teamId]
 * @property {string} [teamName]
 */

/**
 * A value the server attaches to an agent. `warnings` counts the agent's
 * refused actions; the server disconnects it at 1000. Failed moves cost no
 * points.
 * @typedef {{ kind: string, value: number | string, max?: number }} Attribute
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
 * @property {string[]} [plugins]  ids of the plugins the game runs, such as 'double-delivery'
 */

/**
 * The `config` event.
 * @typedef {Object} ServerConfig
 * @property {number} CLOCK     milliseconds per frame
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
 * @property {number} minCommitMs     minimum commitment before soft switching
 * @property {number} failedGoalCooldownMs  delay before retrying failed goals
 * @property {number} blockedTtlMs     how long a refused move is first avoided; doubles on each repeat
 * @property {number} maxBlockedMs     the longest a refused move is ever avoided
 * @property {number} agentTtlMs       how long a sighted agent counts as an obstacle
 * @property {number} maxMoveRetries
 * @property {number} [congestionTimeoutMs]
 * @property {number} [congestionRetryMs]
 * @property {number} pddlTimeoutMs
 * @property {'off' | 'pddl'} taskPlanner  whether the PDDL task planner orders pickups and deliveries
 * @property {number} taskPlannerMaxParcels  the most free parcels in one task problem
 * @property {number} taskPlannerTimeoutMs  how long to wait for a task plan
 * @property {number} actionTimeoutMs
 * @property {'baseline' | 'net_gain'} optionStrategy  how pickups are weighed against delivering
 * @property {number} minNetGain  with net_gain, the fewest extra points a switch of goal must earn
 * @property {number | null} timeValuePerS  with net_gain, points one second is worth; null learns it from the score
 * @property {number} deliveryProtection  with net_gain, the gain above which a pickup gives way to delivering
 */

/**
 * The connection to the game (src/client.js). A server refusal returns
 * false/empty arrays; transport exceptions reject and imply unknown outcome.
 * @typedef {Object} Client
 * @property {any} socket  the SDK socket, for anything not wrapped here (messages, token event)
 * @property {(dir: Direction) => Promise<Position | false>} move
 * @property {() => Promise<unknown[]>} pickup   the parcels picked up, without their ids
 * @property {() => Promise<unknown[]>} putdown  the parcels put down, without their ids
 * @property {(callback: (config: ServerConfig) => void) => void} onConfig
 * @property {(callback: (width: number, height: number, tiles: Tile[]) => void) => void} onMap
 * @property {(callback: (tile: Tile) => void) => void} onTile
 * @property {(callback: (sensing: Sensing) => void) => void} onSensing
 * @property {(callback: (me: AgentState) => void) => void} onYou
 * @property {(callback: (frame: number) => void) => void} onPing  the server's frame, about once a second
 * @property {(message: string) => Promise<unknown>} shout
 * @property {(toId: string, message: string) => Promise<unknown>} say
 * @property {(toId: string, message: string) => Promise<unknown>} ask
 * @property {(callback: (id:string,name:string,message:unknown,reply?:((message:unknown)=>void))=>void) => (()=>void)} onMessage
 */

/**
 * Something the agent could commit to, produced by deliberation. A higher
 * `priority` always outranks a lower one, whatever the utilities: 1 marks a
 * user goal or delivering on the tile the agent stands on, and -1 marks
 * exploring under the net_gain strategy.
 * @typedef {Object} Option
 * @property {string} id          short name that stays the same while the option does,
 *                                e.g. 'pickup:p1', 'deliver:0,3', 'explore:4,0'
 * @property {'pickup' | 'deliver' | 'explore' | 'goto'} type
 * @property {number} x
 * @property {number} y
 * @property {number} utility     expected reward on delivery; under net_gain, minus the value of the time taken
 * @property {-1 | 0 | 1} priority
 * @property {string} [parcelId]  for 'pickup'
 */

/**
 * Set to stopped when the running intention is replaced.
 * @typedef {{ stopped: boolean, finishing?: boolean }} StopSignal
 */

/**
 * Limits on pathfinding, shared by the A* and PDDL planners.
 * @typedef {Object} PathOptions
 * @property {number} now                                    milliseconds
 * @property {Set<TileKey>} [occupied]                       tiles held by other agents
 * @property {(x: number, y: number) => boolean} [forbidden] tiles ruled out by directives
 * @property {boolean} [ignoreTemporary] diagnostics only; ignore transient blocks/refusals (NEVER for execution)
 * @property {boolean} [ignoreCrates] treat crates as absent, for optimistic distances
 */

export {};
