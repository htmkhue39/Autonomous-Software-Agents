import { findNearest, findPath } from '../planning/astar.js';
import { expectedReward } from './utility.js';

/**
 * @typedef {import('../beliefs/index.js').Beliefs} Beliefs
 * @typedef {import('../types.js').Option} Option
 * @typedef {import('../types.js').PathOptions} PathOptions
 */

/**
 * The longer a parcel is out of sight, the more likely someone else has
 * taken it (design.md section 2). Its value is multiplied by the chance
 * that it is still there.
 * @typedef {Object} Fading
 * @property {number} [halfLifeMs]  after this many milliseconds out of
 *   sight, the chance is 50% (with no other agent around). Each other agent
 *   makes the chance drop faster. Default `Infinity`: the chance stays 100%.
 * @property {number} [minChance]  a parcel whose chance is below this
 *   (e.g. 0.2 = 20%) is not offered at all
 */

/**
 * Everything the agent could do now, best first (design.md section 2).
 * Pickups and deliveries are scored by the reward expected on delivery and
 * left out when worth nothing; exploring is always worth nothing. For a
 * pickup, the new parcel's value is multiplied by the chance it is still
 * there (see `Fading`). Left out: options that cannot be reached, and
 * parcels another agent will probably get to first.
 * @param {Beliefs} beliefs
 * @param {Fading} [fading]
 * @returns {Option[]}
 */
export function listOptions(beliefs, { halfLifeMs = Infinity, minChance = 0 } = {}) {
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
    const others = beliefs.agents.count;
    for (const parcel of beliefs.parcels.free(now)) {
      const unseen = beliefs.parcels.unseenFor(parcel.id, now);
      const chance = unseen === 0 || halfLifeMs === Infinity ? 1 : 0.5 ** (unseen * (1 + others) / halfLifeMs);
      if (chance < minChance) continue;
      const there = findPath(map, me, parcel, paths);
      if (!there || beliefs.agents.beatsUsTo(parcel, there.length, now)) continue;
      const onward = findNearest(map, parcel, deliveries, paths);
      if (!onward) continue;
      const moves = there.length + onward.path.length;
      const utility = expectedReward(carried, moves, timing) + chance * expectedReward([parcel.reward], moves, timing);
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
