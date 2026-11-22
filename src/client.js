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
 * SDK-reported refusals return false/empty arrays. Transport errors propagate:
 * the caller must treat them as uncertain outcomes, not as definite refusals.
 * @param {Pick<AppConfig, 'host' | 'token' | 'name'>} config
 * @returns {Client}
 */
export function connect(config) {
  const socket = DjsConnect(config.host, config.token, config.name);

  /** @param {Direction} dir */
  async function move(dir) {
    return socket.emitMove(dir);
  }

  async function pickup() {
    return socket.emitPickup();
  }

  async function putdown() {
    return socket.emitPutdown();
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
    socket.on('you', (/** @type {any[]} */ ...args) => {
      if (args.length === 1 && args[0] && typeof args[0] === 'object') callback(args[0]);
      else if (args.length >= 5) {
        const [id, name, x, y, score] = args;
        callback({ id, name, x, y, score });
      }
    });
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

  /** @param {string} message */
  function shout(message) { return socket.emitShout(message); }

  /** @param {string} toId @param {string} message */
  function say(toId, message) { return socket.emitSay(toId, message); }

  /** @param {string} toId @param {string} message */
  function ask(toId, message) { return socket.emitAsk(toId, message); }

  /** @param {(id:string,name:string,message:unknown,reply?:((message:unknown)=>void))=>void} callback */
  function onMessage(callback) {
    socket.onMsg(callback);
    return () => socket.off('msg', callback);
  }

  return { socket, move, pickup, putdown, onConfig, onMap, onTile, onSensing, onYou, onPing,
    shout, say, ask, onMessage };
}
