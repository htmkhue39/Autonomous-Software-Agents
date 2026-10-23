import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

/**
 * @typedef {import('./types.js').AppConfig} AppConfig
 * @typedef {import('./types.js').Client} Client
 * @typedef {import('./types.js').Direction} Direction
 * @typedef {import('./types.js').AgentState} AgentState
 * @typedef {import('./types.js').Sensing} Sensing
 * @typedef {import('./types.js').ServerConfig} ServerConfig
 * @typedef {import('./types.js').Tile} Tile
 */

/**
 * Connect to the Deliveroo.js server. This is the only file that imports the
 * SDK; everything else uses the returned client and the types in types.js.
 * The actions never reject: a failed or timed-out move is `false`, a failed
 * pickup or putdown is `[]`.
 * @param {Pick<AppConfig, 'host' | 'token' | 'name'>} config
 * @returns {Client}
 */
export function connect(config) {
  const socket = DjsConnect(config.host, config.token, config.name);

  /** @param {Direction} dir */
  async function move(dir) {
    try {
      return await socket.emitMove(dir);
    } catch {
      return false;
    }
  }

  async function pickup() {
    try {
      return await socket.emitPickup();
    } catch {
      return [];
    }
  }

  async function putdown() {
    try {
      return await socket.emitPutdown();
    } catch {
      return [];
    }
  }

  /** @param {(config: ServerConfig) => void} callback */
  function onConfig(callback) {
    socket.on('config', callback);
  }

  /** @param {(width: number, height: number, tiles: Tile[]) => void} callback */
  function onMap(callback) {
    socket.on('map', callback);
  }

  /** @param {(tile: Tile) => void} callback */
  function onTile(callback) {
    socket.on('tile', callback);
  }

  /** @param {(sensing: Sensing) => void} callback */
  function onSensing(callback) {
    socket.on('sensing', callback);
  }

  /**
   * The course server reports the agent's own state as `sensing.self` and
   * does not emit the SDK's `you` event, so listen to both.
   * @param {(me: AgentState) => void} callback
   */
  function onYou(callback) {
    socket.on('you', callback);
    onSensing((sensing) => {
      if (sensing.self) callback(sensing.self);
    });
  }

  /**
   * The server pings about once a second with its current frame.
   * @param {(frame: number) => void} callback
   */
  function onPing(callback) {
    socket.on('ping', (/** @type {{ frame?: number }} */ ping) => {
      if (typeof ping?.frame === 'number') callback(ping.frame);
    });
  }

  return { socket, move, pickup, putdown, onConfig, onMap, onTile, onSensing, onYou, onPing };
}
