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
  /** @type {{x:number,y:number}|undefined} raw self position for action reconciliation */
  rawMe;
  get positionStable() { return !!this.rawMe && Number.isInteger(this.rawMe.x) && Number.isInteger(this.rawMe.y); }
  /** @type {(() => void)[]} */
  #listeners = [];

  /**
   * @param {{ now?: () => number, agentTtlMs: number, blockedTtlMs: number, maxBlockedMs?: number }} options
   *   `now` is the local clock, which carries the game time between frames
   */
  constructor({ now = Date.now, agentTtlMs, blockedTtlMs, maxBlockedMs }) {
    this.clock = new GameClock(now);
    this.agentTtlMs = agentTtlMs;
    this.blockedTtlMs = blockedTtlMs;
    this.maxBlockedMs = maxBlockedMs;
    this.parcels = new ParcelBeliefs(Infinity);
    this.agents = new AgentBeliefs(agentTtlMs);
  }

  /**
   * `ms`, but never less than `moves` moves of the current game. The game's
   * settings can be changed by hand, and a wait that is long enough at 50 ms
   * per move may not cover a single move in a slower game. So every wait that
   * is about agents moving is set in milliseconds, with this as its floor.
   * @param {number} ms
   * @param {number} moves
   */
  atLeastMoves(ms, moves) {
    const moveMs = this.config?.GAME.player.movement_duration;
    return typeof moveMs === 'number' && moveMs > 0 ? Math.max(ms, moves * moveMs) : ms;
  }

  /**
   * `ms`, but never less than `frames` frames of the server's clock, for
   * waits on the next sensing message.
   * @param {number} ms
   * @param {number} frames
   */
  atLeastFrames(ms, frames) {
    const frameMs = this.config?.CLOCK;
    return typeof frameMs === 'number' && frameMs > 0 ? Math.max(ms, frames * frameMs) : ms;
  }

  /** Set how long sightings and refused moves count, from the game's speed. */
  #applyTimings() {
    this.agents.ttlMs = this.atLeastMoves(this.agentTtlMs, 6);
    if (this.map) {
      this.map.blockedTtlMs = this.atLeastMoves(this.blockedTtlMs, 4);
      this.map.maxBlockedMs = this.atLeastMoves(this.maxBlockedMs ?? 30_000, 60);
    }
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
    // Temporary listeners (e.g. waiting for a pickup sensing update) must
    // be removable; the autonomous controller's permanent listener remains.
    return () => {
      const index = this.#listeners.indexOf(callback);
      if (index !== -1) this.#listeners.splice(index, 1);
    };
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
    if (this.map) this.map.doubleDelivery = this.#doubleDelivery();
    this.#applyTimings();
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
    this.map.doubleDelivery = this.#doubleDelivery();
    this.#applyTimings();
    this.#changed();
  }

  /** @param {Tile} tile */
  onTile(tile) {
    this.map?.updateTile(tile);
    this.#changed();
  }

  /** @param {AgentState} me */
  onYou(me) {
    this.rawMe = { x: me.x, y: me.y };
    this.me = { ...me, x: Math.round(me.x), y: Math.round(me.y) };
    this.#changed();
  }

  /** @param {Sensing} sensing */
  onSensing({ frame, positions, agents, parcels, crates, self }) {
    if (frame !== undefined) this.clock.onFrame(frame);
    const now = this.now();
    const myId = self?.id ?? this.me?.id;
    this.map?.markSeen(positions, now);
    this.map?.updateCrates(crates ?? [], positions);
    this.parcels.update(parcels, positions, now, myId);
    // An agent seen carrying a parcel collects parcels, so it competes for them.
    for (const { carriedBy } of parcels) if (carriedBy && carriedBy !== myId) this.agents.markCollector(carriedBy);
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
   * The agent's pickup returned these parcels. When every returned parcel
   * carries its id, exactly those parcels are now carried by the agent.
   * The server's reply may carry no ids (design.md section 9), and then
   * only whether it is empty counts: if not, the free parcels believed on
   * the agent's tile are now carried by it; if so, they are gone.
   * @param {unknown[]} picked
   */
  onPickup(picked) {
    if (!this.me) return;
    const { x, y } = this.me;
    const ids = picked.map(p => (p && typeof p === 'object' ? /** @type {{ id?: unknown }} */ (p).id : undefined));
    if (picked.length > 0 && ids.every(id => typeof id === 'string')) {
      this.parcels.pickedUp(/** @type {string[]} */ (ids), this.me.id);
    } else if (picked.length > 0) {
      this.parcels.pickedUpAt({ x, y }, this.me.id);
    } else {
      this.parcels.forgetFreeAt({ x, y });
    }
    this.#changed();
  }

  /**
   * The agent's putdown returned these parcels. If any, everything it carried
   * is on its tile now: delivered and forgotten on a delivery tile, else
   * left there, free.
   * @param {unknown[]} dropped
   */
  onPutdown(dropped) {
    if (!this.me || dropped.length === 0) return;
    const { x, y } = this.me;
    this.parcels.putDownAll(this.me.id, { x, y }, { delivered: (this.map?.deliveryMultiplier(x, y) ?? 0) > 0 });
    this.#changed();
  }

  /**
   * A putdown dropped nothing, so the server says the agent carries nothing.
   * Sensing never corrects this belief, because the agent's own load is
   * tracked from its pickups and putdowns, so it is corrected here.
   * @returns {number} how many believed parcels were forgotten
   */
  onNothingCarried() {
    if (!this.me) return 0;
    const count = this.parcels.forgetCarriedBy(this.me.id);
    if (count) this.#changed();
    return count;
  }

  /** @param {import('../types.js').Parcel[]} parcels @param {number} observedAt */
  onSharedParcels(parcels, observedAt) {
    const added = this.parcels.mergeShared(parcels, observedAt, this.now());
    if (added) this.#changed();
    return added;
  }

  /** @param {string} id */
  onPeerCollected(id) {
    if (this.me && this.parcels.get(id, this.now())?.carriedBy === this.me.id) return;
    if (this.parcels.forget(id)) this.#changed();
  }

  /** Whether the game runs the plugin that scores '9' tiles twice. */
  #doubleDelivery() {
    return this.config?.GAME.plugins?.includes('double-delivery') ?? false;
  }

  #changed() {
    for (const listener of this.#listeners) listener();
  }
}
