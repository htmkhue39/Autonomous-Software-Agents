import { findPath, findPushingPath, stepWithCrates } from '../planning/astar.js';
import { DIRS, key } from '../beliefs/map.js';

const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/** An action executor that supports cancellation between moves, rejects
 * overlapping actions, and preserves UNKNOWN results without blind retries.
 *
 * The route is given by the caller (the Plan Library, from a PDDL plan) or,
 * when none is given, found with A*. The caller may also hand over a new
 * route during the walk through `takeRoute`. Whatever its source, the route
 * is checked again before every move with A*, which takes about a
 * millisecond. The agent switches to a new A* route at once when a tile on
 * the rest of its route becomes blocked or occupied, or when a strictly
 * shorter route has opened up. Each switch is logged as 'replan'.
 */
export class MovementRunner {
  /**
   * @param {{ beliefs: import('../beliefs/index.js').Beliefs, client: import('../types.js').Client,
   * gate: import('./action-gate.js').ActionGate, maxMoveRetries?: number,
   * congestionTimeoutMs?:number, congestionRetryMs?:number, yieldAfterWaits?:number,
   * log?: (type:string,details:object)=>void }} config
   *   `yieldAfterWaits` is how many waits for a blocking agent pass before
   *   the agent steps aside to let it through (see stepAside).
   */
  constructor({ beliefs, client, gate, maxMoveRetries = 3,
    congestionTimeoutMs = 3500, congestionRetryMs = 180, yieldAfterWaits = 3, log = () => {} }) {
    this.beliefs = beliefs;
    this.client = client;
    this.gate = gate;
    this.maxMoveRetries = maxMoveRetries;
    this.congestionTimeoutMs = Math.max(0, congestionTimeoutMs);
    this.congestionRetryMs = Math.max(20, congestionRetryMs);
    this.yieldAfterWaits = Math.max(1, yieldAfterWaits);
    this.log = log;
  }

  /**
   * @param {import('../types.js').Position} target
   * @param {import('../types.js').StopSignal} signal
   * @param {{ route?: import('../types.js').Direction[] | null,
   *   takeRoute?: (() => import('../types.js').Direction[] | null) | null,
   *   onReplaced?: ((reason: string) => void) | null }} [given]
   *   `route` is followed instead of an A* route from the start. `takeRoute`
   *   is asked before every move; a route it returns replaces the rest of
   *   the current one, from the agent's tile. `onReplaced` is told when A*
   *   replaces a route that came from the caller, with the reason.
   * @returns {Promise<{status:'completed'|'failed'|'cancelled'|'unknown', reason?:string}>}
   */
  async moveTo(target, signal, { route = null, takeRoute = null, onReplaced = null } = {}) {
    /** @type {import('../types.js').Direction[] | null} */
    let planned = route ? [...route] : null;
    // Whether the route being followed is the caller's.
    let callers = !!route;
    let retries = 0;
    let movesCompleted = 0;
    /** @type {number|null} */ let congestionStarted = null;
    let congestionWaits = 0;
    // Whether the agent already stepped aside in the current wait.
    let yielded = false;
    let yielding = false;
    const cancelled = () => {
      this.log('navigation_cancelled', { target, movesCompleted });
      return { status: /** @type {const} */ ('cancelled') };
    };
    const { map } = this.beliefs;
    if (!map) return { status: 'failed', reason: 'No known map' };
    const maxActions = Math.max(12, map.width * map.height * 4);
    for (let step = 0; step < maxActions; step++) {
      if (signal.stopped) return cancelled();
      const { me } = this.beliefs;
      if (!me) return { status: 'failed', reason: 'Self position unknown' };
      if (me.x === target.x && me.y === target.y) return { status: 'completed' };
      const now = this.beliefs.now();
      const paths = { now, occupied: this.beliefs.agents.occupied(now) };
      const handed = takeRoute?.();
      if (handed) { planned = [...handed]; callers = true; }
      if (planned?.length) {
        // Check the rest of the route against the latest beliefs. A blocked
        // route is replaced by the best one there is, pushing crates if need
        // be; a route that still works only by a shorter one without pushes.
        /** @type {boolean} */
        const blocked = !followable(map, me, planned, paths);
        /** @type {import('../types.js').Direction[] | null} */
        const fresh = blocked ? workingRoute(map, me, target, paths) : simpleRoute(map, me, target, paths);
        const reason = blocked ? 'blocked' : fresh && fresh.length < planned.length ? 'shorter' : null;
        if (reason) {
          this.log('replan', { reason, planner: 'astar', from: { x: me.x, y: me.y }, target,
            previousMoves: planned.length, moves: fresh?.length ?? null });
          if (callers) { callers = false; onReplaced?.(reason); }
          planned = fresh;
        }
      } else {
        planned = workingRoute(map, me, target, paths);
      }
      if (signal.stopped) return cancelled();
      if (!planned?.length) {
        // An occupancy-free, temporary-block-free A* path is DIAGNOSTIC ONLY.
        // It still respects static walls and directional tiles. Never issue
        // moves along this path while another agent occupies a tile.
        const staticPath = findPath(map, me, target, { now, ignoreTemporary: true });
        const blockers = this.beliefs.agents.occupiedDetails(now);
        const staticTiles = new Set();
        let px = me.x; let py = me.y;
        for (const dir of staticPath ?? []) {
          px += DIRS[dir].dx; py += DIRS[dir].dy;
          staticTiles.add(key(px, py));
        }
        const relevant = blockers.filter(b => b.tiles.some(t => staticTiles.has(key(t.x, t.y))));
        const diagnostic = { from: { x: me.x, y: me.y }, target, occupiedTiles: paths.occupied.size,
          blockers: relevant.slice(0, 8), fromTileType: map.typeAt(me.x, me.y) };
        if (staticPath === null) {
          this.log('navigation_failed', { reason: 'Static route impossible', ...diagnostic, failureKind: 'static' });
          return { status: 'failed', reason: 'Static route impossible' };
        }
        // Waits are measured in milliseconds, but never shorter than some moves of this game.
        const congestionTimeoutMs = this.congestionTimeoutMs > 0 ? this.beliefs.atLeastMoves(this.congestionTimeoutMs, 10) : 0;
        const congestionRetryMs = this.beliefs.atLeastMoves(this.congestionRetryMs, 1);
        if (relevant.length && congestionTimeoutMs > 0) {
          congestionStarted ??= Date.now();
          const waitedMs = Date.now() - congestionStarted;
          if (waitedMs >= congestionTimeoutMs) {
            this.log('navigation_failed', { reason: 'Congestion timeout', ...diagnostic,
              failureKind: 'congestion', waitedMs, attempts: congestionWaits });
            return { status: 'failed', reason: 'Congestion timeout' };
          }
          congestionWaits++;
          if (congestionWaits === 1) this.log('navigation_wait', { ...diagnostic, reason: 'Agent occupying static route' });
          const aside = yielded ? null : stepAside(map, me, staticTiles, paths, relevant, congestionWaits, this.yieldAfterWaits);
          if (aside) {
            // Make way: step off the route the blocking agent needs, then plan again from there.
            yielded = true;
            yielding = true;
            this.log('navigation_yield', { ...diagnostic, direction: aside });
            planned = [aside];
          } else {
            await sleep(Math.min(congestionRetryMs, congestionTimeoutMs - waitedMs));
            continue;
          }
        } else {
          congestionStarted = null;
          if (++retries > this.maxMoveRetries) {
            this.log('navigation_failed', { reason: 'No currently usable route', ...diagnostic,
              failureKind: 'temporary_edge_or_other', attempts: retries });
            return { status: 'failed', reason: 'No currently usable route' };
          }
          await sleep(this.beliefs.atLeastMoves(120, 1));
          continue;
        }
      }
      if (yielding) {
        // The wait goes on after stepping aside: its time still counts.
        yielding = false;
      } else if (congestionStarted !== null) {
        this.log('navigation_recovered', { target, waitedMs: Date.now() - congestionStarted, waits: congestionWaits });
        congestionStarted = null;
        congestionWaits = 0;
        yielded = false;
      }
      const dir = planned.shift();
      if (!dir) continue;
      const origin = { x: me.x, y: me.y };
      const response = await this.gate.call('move', () => this.client.move(dir));
      if (response.status !== 'ok') {
        this.log('action_unknown', { action: 'move', direction: dir, reason: response.status === 'unknown' ? response.reason : response.status });
        return { status: 'unknown', reason: response.status === 'unknown' ? response.reason : response.status };
      }
      if (response.value === false) {
        map.failMove(origin.x, origin.y, dir, this.beliefs.now());
        this.log('move_refused', { direction: dir, from: origin,
          to: { x: origin.x + DIRS[dir].dx, y: origin.y + DIRS[dir].dy },
          fromTileType: map.typeAt(origin.x, origin.y),
          toTileType: map.typeAt(origin.x + DIRS[dir].dx, origin.y + DIRS[dir].dy),
          occupiedTiles: paths.occupied.size });
        if (++retries > this.maxMoveRetries) {
          this.log('navigation_failed', { reason: 'Too many refused moves', from: origin, target, attempts: retries });
          return { status: 'failed', reason: 'Too many refused moves' };
        }
        planned = null;
        await sleep(this.beliefs.atLeastMoves(80, 1));
        continue;
      }
      const pos = response.value;
      const expected = { x: origin.x + DIRS[dir].dx, y: origin.y + DIRS[dir].dy };
      // An acknowledged move can pass through transitional coordinates; only
      // promote a completed integer tile to a confirmed step.
      if (!pos || !Number.isInteger(pos.x) || !Number.isInteger(pos.y) || pos.x !== expected.x || pos.y !== expected.y) {
        this.log('action_unknown', { action: 'move', direction: dir, reason: 'Unexpected move acknowledgement', received: pos });
        return { status: 'unknown', reason: 'Move result requires sensing reconciliation' };
      }
      map.cratePushed(pos.x, pos.y, dir);
      this.beliefs.onYou({ ...me, ...pos });
      map.moveSucceeded(origin.x, origin.y, dir);
      map.markSeen([pos], this.beliefs.now());
      movesCompleted++;
      this.log('move', { direction: dir, x: pos.x, y: pos.y, target });
      retries = 0;
    }
    return { status: 'failed', reason: 'Navigation action budget exceeded' };
  }
}

/**
 * A shortest route without pushing any crate, or null.
 * @param {import('../beliefs/map.js').GridMap} map
 * @param {import('../types.js').Position} from
 * @param {import('../types.js').Position} to
 * @param {import('../types.js').PathOptions} paths
 */
function simpleRoute(map, from, to, paths) {
  const route = findPath(map, from, to, paths);
  return route && followable(map, from, route, paths) ? route : null;
}

/**
 * A route the server will let the agent follow, or null. The plain search
 * treats crates as standing still, which is right unless its route pushes
 * the same crate twice or into another crate; then a search that follows the
 * crates is asked instead (findPushingPath), which takes longer.
 * @param {import('../beliefs/map.js').GridMap} map
 * @param {import('../types.js').Position} from
 * @param {import('../types.js').Position} to
 * @param {import('../types.js').PathOptions} paths
 */
function workingRoute(map, from, to, paths) {
  const route = findPath(map, from, to, paths);
  if (map.crateTiles().size === 0) return route;
  if (route && followable(map, from, route, paths)) return route;
  return findPushingPath(map, from, to, paths);
}

/**
 * Whether every move of `route`, taken from `from`, is still allowed by the
 * map and enters no tile that another agent occupies. Crates pushed by the
 * route are followed along it, so a route that pushes a crate out of the way
 * stays followable after the push.
 * @param {import('../beliefs/map.js').GridMap} map
 * @param {import('../types.js').Position} from
 * @param {import('../types.js').Direction[]} route
 * @param {import('../types.js').PathOptions} paths
 */
function followable(map, from, route, paths) {
  /** @type {{ x: number, y: number, crates: ReadonlySet<string> }} */
  let at = { x: from.x, y: from.y, crates: map.crateTiles() };
  for (const dir of route) {
    const next = stepWithCrates(map, at, dir, at.crates, paths);
    if (!next) return false;
    at = next;
  }
  return true;
}

/**
 * Where to step aside so that a blocking agent can pass, or null to keep
 * waiting. In a narrow passage two agents heading towards each other can
 * block each other until one gives up; stepping onto a side tile that the
 * agent's own route does not use clears the way. The agent only does this
 * after `afterWaits` waits, and only when a blocking agent is at most two
 * tiles away, since a blocker further off may still turn away by itself.
 * @param {import('../beliefs/map.js').GridMap} map
 * @param {import('../types.js').Position} me
 * @param {Set<string>} routeTiles  the tiles of the agent's route without the other agents
 * @param {import('../types.js').PathOptions} paths
 * @param {{ tiles: import('../types.js').Position[] }[]} blockers  agents on that route
 * @param {number} waits
 * @param {number} afterWaits
 * @returns {import('../types.js').Direction | null}
 */
export function stepAside(map, me, routeTiles, paths, blockers, waits, afterWaits) {
  if (waits < afterWaits) return null;
  const near = blockers.some(b => b.tiles.some(t => Math.abs(t.x - me.x) + Math.abs(t.y - me.y) <= 2));
  if (!near) return null;
  const side = map.neighbors(me.x, me.y, paths.now)
    .find(n => !routeTiles.has(key(n.x, n.y)) && !paths.occupied?.has(key(n.x, n.y)));
  return side?.dir ?? null;
}
