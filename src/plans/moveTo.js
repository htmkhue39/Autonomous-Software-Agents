import { findPath } from '../planning/astar.js';
import { solveNavigation } from '../planning/pddl/solve.js';
import { DIRS, key } from '../beliefs/map.js';

const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/** An action executor that supports cancellation between moves, rejects
 * overlapping actions, and preserves UNKNOWN results without blind retries.
 */
export class MovementRunner {
  /**
   * @param {{ beliefs: import('../beliefs/index.js').Beliefs, client: import('../types.js').Client,
   * gate: import('./action-gate.js').ActionGate, mode?: 'astar'|'pddl',
   * solve?: typeof import('../planning/pddl/solve.js').courseSolver,
   * pddlTimeoutMs?: number, maxMoveRetries?: number,
   * congestionTimeoutMs?:number, congestionRetryMs?:number,
   * log?: (type:string,details:object)=>void }} config
   */
  constructor({ beliefs, client, gate, mode = 'pddl', solve, pddlTimeoutMs = 5000, maxMoveRetries = 3,
    congestionTimeoutMs = 3500, congestionRetryMs = 180, log = () => {} }) {
    this.beliefs = beliefs;
    this.client = client;
    this.gate = gate;
    this.mode = mode;
    this.solve = solve;
    this.pddlTimeoutMs = pddlTimeoutMs;
    this.maxMoveRetries = maxMoveRetries;
    this.congestionTimeoutMs = Math.max(0, congestionTimeoutMs);
    this.congestionRetryMs = Math.max(20, congestionRetryMs);
    this.log = log;
  }

  /**
   * @param {import('../types.js').Position} target
   * @param {import('../types.js').StopSignal} signal
   * @returns {Promise<{status:'completed'|'failed'|'cancelled'|'unknown', reason?:string}>}
   */
  async moveTo(target, signal) {
    /** @type {import('../types.js').Direction[] | null} */
    let planned = null;
    let retries = 0;
    let movesCompleted = 0;
    /** @type {number|null} */ let congestionStarted = null;
    let congestionWaits = 0;
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
      const nextDirection = planned?.[0];
      if (!nextDirection || !map.neighbors(me.x, me.y, now).some(n => n.dir === nextDirection && !paths.occupied.has(key(n.x, n.y)))) {
        // Do not spend seconds calling an external solver when A* can already
        // prove there is no route with the current occupied tiles. If a route
        // exists, PDDL still performs the actual planning as required.
        if (this.mode === 'pddl' && findPath(map, me, target, paths) === null) planned = null;
        else planned = await this.route(me, target, paths);
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
        if (relevant.length && this.congestionTimeoutMs > 0) {
          congestionStarted ??= Date.now();
          const waitedMs = Date.now() - congestionStarted;
          if (waitedMs >= this.congestionTimeoutMs) {
            this.log('navigation_failed', { reason: 'Congestion timeout', ...diagnostic,
              failureKind: 'congestion', waitedMs, attempts: congestionWaits });
            return { status: 'failed', reason: 'Congestion timeout' };
          }
          congestionWaits++;
          if (congestionWaits === 1) this.log('navigation_wait', { ...diagnostic, reason: 'Agent occupying static route' });
          await sleep(Math.min(this.congestionRetryMs, this.congestionTimeoutMs - waitedMs));
          continue;
        }
        congestionStarted = null;
        if (++retries > this.maxMoveRetries) {
          this.log('navigation_failed', { reason: 'No currently usable route', ...diagnostic,
            failureKind: 'temporary_edge_or_other', attempts: retries });
          return { status: 'failed', reason: 'No currently usable route' };
        }
        await sleep(120);
        continue;
      }
      if (congestionStarted !== null) {
        this.log('navigation_recovered', { target, waitedMs: Date.now() - congestionStarted, waits: congestionWaits });
        congestionStarted = null;
        congestionWaits = 0;
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
        await sleep(80);
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
      this.beliefs.onYou({ ...me, ...pos });
      map.moveSucceeded(origin.x, origin.y, dir);
      map.markSeen([pos], this.beliefs.now());
      movesCompleted++;
      this.log('move', { direction: dir, x: pos.x, y: pos.y, target });
      retries = 0;
    }
    return { status: 'failed', reason: 'Navigation action budget exceeded' };
  }

  /** @param {import('../types.js').Position} from
   * @param {import('../types.js').Position} to
   * @param {import('../types.js').PathOptions} options
   */
  async route(from, to, options) {
    if (this.mode === 'pddl') {
      try {
        const map = this.beliefs.map;
        if (!map) throw new Error('Map is not ready');
        return await solveNavigation(map, from, to, options, {
          solve: this.solve,
          timeoutMs: this.pddlTimeoutMs,
          log: this.log,
        });
      } catch (error) {
        this.log('planner_fallback', { reason: String(error instanceof Error ? error.message : error), from, to, fallback: 'astar' });
      }
    }
    const map = this.beliefs.map;
    if (!map) return null;
    return findPath(map, from, to, options);
  }
}
