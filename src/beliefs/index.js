import { GridMap } from './map.js';
import { ParcelBeliefs, decayIntervalMs } from './parcels.js';
import { AgentBeliefs } from './agents.js';

/**
 * @typedef {import('../types.js').AgentState} AgentState
 * @typedef {import('../types.js').Client} Client
 * @typedef {import('../types.js').Sensing} Sensing
 * @typedef {import('../types.js').ServerConfig} ServerConfig
 * @typedef {import('../types.js').Tile} Tile
 */

/**
 * Everything the agent believes, fed by the server's messages. Every update
 * is announced to `onChange` listeners so the agent can rethink.
 */
export class Beliefs {
  /** @type {ServerConfig | undefined} */
  config;
  /** @type {GridMap | undefined} */
  map;
  /** @type {AgentState | undefined} the agent itself, at a rounded position */
  me;
  /** @type {(() => void)[]} */
  #listeners = [];

  /**
   * @param {{ now?: () => number, agentTtlMs: number, blockedTtlMs: number }} options
   */
  constructor({ now = Date.now, agentTtlMs, blockedTtlMs }) {
    this.now = now;
    this.blockedTtlMs = blockedTtlMs;
    this.parcels = new ParcelBeliefs(Infinity);
    this.agents = new AgentBeliefs(agentTtlMs);
  }

  /** The server settings, the map and the agent's own position are all known. */
  get ready() {
    return this.config !== undefined && this.map !== undefined && this.me !== undefined;
  }

  /** @param {() => void} callback */
  onChange(callback) {
    this.#listeners.push(callback);
  }

  /** @param {Client} client */
  listen(client) {
    client.onConfig(config => this.onConfig(config));
    client.onMap((width, height, tiles) => this.onMap(width, height, tiles));
    client.onTile(tile => this.onTile(tile));
    client.onYou(me => this.onYou(me));
    client.onSensing(sensing => this.onSensing(sensing));
  }

  /** @param {ServerConfig} config */
  onConfig(config) {
    this.config = config;
    this.parcels.decayMs = decayIntervalMs(config.GAME.parcels.decaying_event, config.CLOCK);
    this.#changed();
  }

  /**
   * The server reports a size one too small, so it is taken from the tiles.
   * @param {number} _width
   * @param {number} _height
   * @param {Tile[]} tiles
   */
  onMap(_width, _height, tiles) {
    const width = Math.max(...tiles.map(t => t.x)) + 1;
    const height = Math.max(...tiles.map(t => t.y)) + 1;
    this.map = new GridMap(width, height, tiles);
    this.#changed();
  }

  /** @param {Tile} tile */
  onTile(tile) {
    this.map?.updateTile(tile);
    this.#changed();
  }

  /** @param {AgentState} me */
  onYou(me) {
    this.me = { ...me, x: Math.round(me.x), y: Math.round(me.y) };
    this.#changed();
  }

  /** @param {Sensing} sensing */
  onSensing({ positions, agents, parcels, crates, self }) {
    const now = this.now();
    const myId = self?.id ?? this.me?.id;
    this.map?.markSeen(positions, now);
    for (const { x, y } of crates) this.map?.block(x, y, now + this.blockedTtlMs);
    this.parcels.update(parcels, positions, now);
    this.agents.update(agents.filter(a => a.id !== myId), now);
    this.#changed();
  }

  #changed() {
    for (const listener of this.#listeners) listener();
  }
}
