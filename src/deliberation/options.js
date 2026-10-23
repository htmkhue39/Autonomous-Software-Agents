import { findNearest, findPath } from '../planning/astar.js';
import { expectedReward } from './utility.js';

/**
 * @typedef {import('../beliefs/index.js').Beliefs} Beliefs
 * @typedef {import('../types.js').Option} Option
 * @typedef {import('../types.js').PathOptions} PathOptions
 */

/**
 * Everything the agent could do now, best first (design.md section 2).
 * Pickups and deliveries are scored by the reward expected on delivery and
 * left out when worth nothing; exploring is always worth nothing. Options
 * that cannot be reached are left out.
 * @param {Beliefs} beliefs
 * @returns {Option[]}
 */
export function listOptions(beliefs) {
  const { config, map, me } = beliefs;
  if (!config || !map || !me) return [];

  const now = beliefs.now();
  /** @type {PathOptions} */
  const paths = { now, occupied: beliefs.agents.occupied(now) };
  const timing = { moveMs: config.GAME.player.movement_duration, decayMs: beliefs.parcels.decayMs };
  const carried = beliefs.parcels.carriedBy(me.id, now).map(p => p.reward);
  const deliveries = map.deliveryTiles();

  /** @type {Option[]} */
  const options = [];

  if (carried.length < config.GAME.player.capacity) {
    for (const parcel of beliefs.parcels.free(now)) {
      const there = findPath(map, me, parcel, paths);
      const onward = there && findNearest(map, parcel, deliveries, paths);
      if (!there || !onward) continue;
      const utility = expectedReward([...carried, parcel.reward], there.length + onward.path.length, timing);
      options.push({ id: `pickup:${parcel.id}`, type: 'pickup', x: parcel.x, y: parcel.y, utility, priority: 0, parcelId: parcel.id });
    }
  }

  if (carried.length > 0) {
    const nearest = findNearest(map, me, deliveries, paths);
    if (nearest) {
      const utility = expectedReward(carried, nearest.path.length, timing);
      options.push({ id: 'deliver', type: 'deliver', ...nearest.target, utility, priority: 0 });
    }
  }

  const worthwhile = options.filter(o => o.utility > 0).sort((a, b) => b.utility - a.utility);
  const explore = exploreOption(beliefs, paths);
  return explore ? [...worthwhile, explore] : worthwhile;
}

/**
 * Head for the reachable spawn tile seen longest ago, other than the one
 * the agent stands on.
 * @param {Beliefs} beliefs
 * @param {PathOptions} paths
 * @returns {Option | undefined}
 */
function exploreOption(beliefs, paths) {
  const map = /** @type {NonNullable<Beliefs['map']>} */ (beliefs.map);
  const me = /** @type {NonNullable<Beliefs['me']>} */ (beliefs.me);
  const spawns = map.spawnTiles()
    .filter(t => t.x !== me.x || t.y !== me.y)
    .sort((a, b) => map.lastSeen(a.x, a.y) - map.lastSeen(b.x, b.y));
  const target = spawns.find(t => findPath(map, me, t, paths) !== null);
  return target && { id: `explore:${target.x},${target.y}`, type: 'explore', x: target.x, y: target.y, utility: 0, priority: 0 };
}
