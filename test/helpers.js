import { DIRS, GridMap, key } from '../src/beliefs/map.js';
import { Beliefs } from '../src/beliefs/index.js';

/**
 * Tiles from rows of tile characters. The first row is the top of the map
 * (highest y), so the picture in a test reads like the game view.
 * @param {string[]} rows
 * @returns {import('../src/types.js').Tile[]}
 */
export function tilesFromRows(rows) {
  const height = rows.length;
  /** @type {import('../src/types.js').Tile[]} */
  const tiles = [];
  rows.forEach((row, i) =>
    [...row].forEach((type, x) =>
      tiles.push({ x, y: height - 1 - i, type: /** @type {import('../src/types.js').TileType} */ (type) })));
  return tiles;
}

/**
 * Build a map from rows of tile characters, as `tilesFromRows` reads them.
 * @param {string[]} rows
 * @param {{ blockedTtlMs?: number, maxBlockedMs?: number }} [options]
 * @returns {GridMap}
 */
export function mapFromRows(rows, options) {
  return new GridMap([...rows[0]].length, rows.length, tilesFromRows(rows), options);
}

/**
 * Ready beliefs on a map drawn as rows, with the agent 'me' at `me`. The
 * game clock stands still at 0 unless `clock.t` is changed.
 * @param {string[]} rows
 * @param {import('../src/types.js').Position} me
 * @param {{ capacity?: number }} [settings]
 */
export function readyBeliefs(rows, me, { capacity = 5 } = {}) {
  const clock = { t: 0 };
  const beliefs = new Beliefs({ now: () => clock.t, agentTtlMs: 3000, blockedTtlMs: 2000 });
  beliefs.onConfig({
    CLOCK: 50,
    PENALTY: 1,
    AGENT_TIMEOUT: 10000,
    GAME: {
      title: 'test',
      description: '',
      parcels: { generation_event: '2s', decaying_event: '1s', max: 5, reward_avg: 30, reward_variance: 10 },
      player: { movement_duration: 200, observation_distance: 5, capacity },
    },
  });
  beliefs.onMap(0, 0, tilesFromRows(rows));
  beliefs.onYou({ id: 'me', name: 'me', x: me.x, y: me.y, score: 0 });
  return { beliefs, clock };
}

/**
 * A game server for tests, playing against the beliefs: a move that works
 * moves the agent in them, as the server's sensing would. Moves into a wall
 * fail. Moves into `refuseInto` tiles are refused; moves into `lateInto`
 * tiles happen but are answered too late, so the client reports failure.
 * `parcelsAt` holds the parcels really lying on each tile, which a pickup
 * takes; a putdown drops all carried parcels.
 * @param {import('../src/beliefs/index.js').Beliefs} beliefs
 * @param {{ refuseInto?: string[], lateInto?: string[], parcelsAt?: Record<string, string[]>, carried?: string[] }} [setup]
 */
export function fakeGame(beliefs, { refuseInto = [], lateInto = [], parcelsAt = {}, carried = [] } = {}) {
  const game = {
    /** @type {import('../src/types.js').Direction[]} every move tried */
    moves: [],
    refused: 0,
    carried: [...carried],
    /** @type {string[]} parcels put down on a delivery tile */
    delivered: [],
    /** @type {(() => void) | undefined} called after every move */
    onMove: undefined,
    client: {
      /** @param {import('../src/types.js').Direction} dir */
      async move(dir) {
        game.moves.push(dir);
        const me = /** @type {import('../src/types.js').AgentState} */ (beliefs.me);
        const to = { x: me.x + DIRS[dir].dx, y: me.y + DIRS[dir].dy };
        const into = key(to.x, to.y);
        const type = beliefs.map?.typeAt(to.x, to.y);
        /** @type {import('../src/types.js').Position | false} */
        let result = false;
        if (type === undefined || type === '0' || refuseInto.includes(into)) {
          game.refused++;
        } else {
          beliefs.onYou({ ...me, ...to });
          if (!lateInto.includes(into)) result = to;
        }
        game.onMove?.();
        return result;
      },
      async pickup() {
        const me = /** @type {import('../src/types.js').AgentState} */ (beliefs.me);
        const here = parcelsAt[key(me.x, me.y)] ?? [];
        parcelsAt[key(me.x, me.y)] = [];
        game.carried.push(...here);
        return here.map(id => ({ id }));
      },
      async putdown() {
        const me = /** @type {import('../src/types.js').AgentState} */ (beliefs.me);
        const dropped = game.carried;
        game.carried = [];
        if (beliefs.map?.typeAt(me.x, me.y) === '2') game.delivered.push(...dropped);
        else parcelsAt[key(me.x, me.y)] = [...(parcelsAt[key(me.x, me.y)] ?? []), ...dropped];
        return dropped.map(id => ({ id }));
      },
    },
  };
  return game;
}
