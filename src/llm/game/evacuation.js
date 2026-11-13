import { key } from '../../beliefs/map.js';

/**
 * Static directed reachability count. Excluding a parking tile can reveal that
 * it disconnects delivery access to other parts of the map. This uses only
 * static walls/one-way rules, not transient agent positions or refused moves.
 * @param {import('../../beliefs/map.js').GridMap} map
 * @param {{x:number,y:number}} start
 * @param {number} now
 * @param {string|null} excluded
 */
function staticReachableCount(map, start, now, excluded = null) {
  const seen = new Set([key(start.x, start.y)]);
  const pending = [start];
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    for (const n of map.neighbors(p.x, p.y, now, { ignoreTemporary: true })) {
      const k = key(n.x, n.y);
      if (k === excluded || seen.has(k)) continue;
      seen.add(k);
      pending.push(n);
    }
  }
  return seen.size;
}

/**
 * Choose a bounded, currently reachable place for the LLM to stand after an
 * acknowledged delivery. This is NOT a task planner: it only clears a shared
 * delivery tile so the other player can enter it while the LLM reasons.
 *
 * Never traverse an occupied tile, a wall, a temporarily refused edge, or a
 * one-way tile in the wrong direction. Prefer ordinary tiles sufficiently far
 * from ALL delivery tiles and away from busy junctions/spawn points. A dead-end
 * is a useful parking place when it is not itself a pickup/delivery tile.
 *
 * No SDK action is issued here: execution and ambiguous acknowledgements are
 * exclusively handled by the existing PlanLibrary/MovementRunner/ActionGate.
 *
 * @param {import('../../beliefs/index.js').Beliefs} beliefs
 * @param {{maxSteps?:number}} [options]
 * @returns {{target:{x:number,y:number},distance:number,deliverySeparation:number,tileType:string}|null}
 */
export function selectDeliveryParking(beliefs, { maxSteps = 7 } = {}) {
  const me = beliefs.me;
  const map = beliefs.map;
  if (!me || !map || !Number.isInteger(me.x) || !Number.isInteger(me.y) ||
      !Number.isInteger(maxSteps) || maxSteps < 1 || map.typeAt(me.x, me.y) !== '2') return null;
  const now = beliefs.now();
  const occupied = beliefs.agents.occupied(now);
  const delivery = map.deliveryTiles();
  if (!delivery.length) return null;
  const baselineReach = staticReachableCount(map, me, now);
  const visited = new Set([key(me.x, me.y)]);
  const queue = [{ x: me.x, y: me.y, steps: 0 }];
  /** @type {Array<{target:{x:number,y:number},distance:number,deliverySeparation:number,tileType:string,quality:number}>} */
  const candidates = [];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (current.steps >= maxSteps) continue;
    for (const n of map.neighbors(current.x, current.y, now)) {
      const k = key(n.x, n.y);
      if (occupied.has(k) || visited.has(k)) continue;
      visited.add(k);
      const steps = current.steps + 1;
      queue.push({ x: n.x, y: n.y, steps });
      const tileType = map.typeAt(n.x, n.y);
      if (tileType === undefined || tileType === '2') continue;
      const separation = Math.min(...delivery.map(t => Math.abs(t.x - n.x) + Math.abs(t.y - n.y)));
      // Count permanent walkable neighbours (ignoring temporary exclusions);
      // small dead-end pockets are preferable to junctions as parking spots.
      const neighbors = map.neighbors(n.x, n.y, now, { ignoreTemporary: true }).length;
      // Strongly discourage parking on a cut tile that would disconnect
      // delivery access to other reachable terrain. Fall back if unavoidable.
      const isChoke = baselineReach - staticReachableCount(map, me, now, k) > 1;
      const quality = (tileType === '3' ? 40 : 0) + (separation >= 3 ? 30 : separation >= 2 ? 10 : 0) +
        (neighbors === 1 ? 20 : neighbors >= 3 ? -10 : 0) - (isChoke ? 80 : 0) - steps * 3;
      candidates.push({ target: { x: n.x, y: n.y }, distance: steps,
        deliverySeparation: separation, tileType, quality });
    }
  }
  candidates.sort((a, b) => b.quality - a.quality || a.distance - b.distance ||
    a.target.x - b.target.x || a.target.y - b.target.y);
  const best = candidates[0];
  return best ? { target: best.target, distance: best.distance,
    deliverySeparation: best.deliverySeparation, tileType: best.tileType } : null;
}
