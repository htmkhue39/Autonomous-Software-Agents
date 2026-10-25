import { GridMap } from './map.js';
import { ParcelBeliefs, decayIntervalMs } from './parcels.js';
import { AgentBeliefs } from './agents.js';
import { GameClock } from './clock.js';

/**
 * @typedef {import('../types.js').AgentState} AgentState
 * @typedef {import('../types.js').Client} Client
 * @typedef {import('../types.js').Sensing} Sensing
 * @typedef {import('../types.js').ServerConfig} ServerConfig
 * @typedef {import('../types.js').Tile} Tile
 */

/**
 * Everything the agent believes, fed by the server's messages and the
 * results of its own pickups and putdowns. Times are the server's game time
 * (`now()`). Every update is announced to `onChange` listeners so the agent
 * can rethink.
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
   * @param {{ now?: () => number, agentTtlMs: number, blockedTtlMs: number, maxBlockedMs?: number }} options
   *   `now` is the local clock, which carries the game time between frames
   */
  constructor({ now = Date.now, agentTtlMs, blockedTtlMs, maxBlockedMs }) {
    this.clock = new GameClock(now);
    this.blockedTtlMs = blockedTtlMs;
    this.maxBlockedMs = maxBlockedMs;
    this.parcels = new ParcelBeliefs(Infinity);
    this.agents = new AgentBeliefs(agentTtlMs);
  }

  /** The server's game time, in milliseconds. */
  now() {
    return this.clock.now();
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
    client.onPing(frame => this.onPing(frame));
  }

  /** @param {ServerConfig} config */
  onConfig(config) {
    this.config = config;
    this.clock.setFrameMs(config.CLOCK);
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
    this.map = new GridMap(width, height, tiles, { blockedTtlMs: this.blockedTtlMs, maxBlockedMs: this.maxBlockedMs });
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
  onSensing({ frame, positions, agents, parcels, crates, self }) {
    if (frame !== undefined) this.clock.onFrame(frame);
    const now = this.now();
    const myId = self?.id ?? this.me?.id;
    this.map?.markSeen(positions, now);
    for (const { x, y } of crates) this.map?.block(x, y, now + this.blockedTtlMs);
    this.parcels.update(parcels, positions, now, myId);
    this.agents.update(agents.filter(a => a.id !== myId), positions, now);
    this.#changed();
  }

  /**
   * A ping only moves the game clock on; nothing to rethink.
   * @param {number} frame
   */
  onPing(frame) {
    this.clock.onFrame(frame);
  }

  /**
   * The parcels the agent's pickup returned are now carried by it.
   * @param {{ id: string }[]} picked
   */
  onPickup(picked) {
    if (!this.me) return;
    this.parcels.pickedUp(picked.map(p => p.id), this.me.id);
    this.#changed();
  }

  /**
   * The parcels the agent's putdown returned are no longer carried; on a
   * delivery tile they are delivered and forgotten.
   * @param {{ id: string }[]} dropped
   */
  onPutdown(dropped) {
    if (!this.me) return;
    const { x, y } = this.me;
    this.parcels.putDown(dropped.map(p => p.id), { x, y }, { delivered: this.map?.typeAt(x, y) === '2' });
    this.#changed();
  }

  #changed() {
    for (const listener of this.#listeners) listener();
  }
}
