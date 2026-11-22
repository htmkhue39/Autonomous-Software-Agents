import { distancesThroughCrates, findNearest, findPath } from '../planning/astar.js';
import { decayTicks } from './utility.js';
import { key } from '../beliefs/map.js';
import { decayIntervalMs } from '../beliefs/parcels.js';

/**
 * @typedef {import('../beliefs/index.js').Beliefs} Beliefs
 * @typedef {import('../types.js').Option} Option
 * @typedef {import('../types.js').PathOptions} PathOptions
 * @typedef {import('../types.js').Position} Position
 * @typedef {import('../types.js').TileKey} TileKey
 */

/**
 * How the agent weighs picking up more parcels against delivering the ones
 * it already carries.
 * - 'baseline': every option is scored only by the reward expected on
 *   delivery. A pickup counts the parcels already carried as well, so it
 *   nearly always beats going to deliver them.
 * - 'net_gain': an option is worth the reward it delivers minus the value
 *   of the time it takes: U = R - timeValue × T, with T the trip time in
 *   milliseconds and timeValue the agent's earning rate in points per
 *   millisecond (see EarningRate). Time spent on one trip could have earned
 *   points on another, so a long detour for a few points loses, even when
 *   parcels decay slowly. While carrying parcels, a pickup is offered only
 *   when its U beats delivering straight away by at least `minGain` points,
 *   and the BDI agent switches between intentions on the same rule (see
 *   reconsider). Delivering is always offered while carrying, even when its
 *   U is below zero, since not delivering would lose the whole load.
 *   Exploring ranks below every pickup and delivery.
 *   Under 'net_gain' a pickup also looks one stop ahead: it is worth the best
 *   of delivering after it, or picking up the parcels of one more tile first
 *   and then delivering. And a parcel that a rival can reach as soon as the
 *   agent, or sooner, counts only for the chance that the agent gets it
 *   first (see winChance).
 * @typedef {{ strategy?: 'baseline' | 'net_gain', minGain?: number, timeValue?: number,
 *   excluded?: ReadonlySet<string>, deliveryCooldowns?: ReadonlyMap<string, number>,
 *   keep?: string | null }} OptionPolicy
 *   `excluded` holds option ids that must not be offered, such as delivery
 *   tiles that failed recently. `deliveryCooldowns` gives, for excluded
 *   delivery tiles that were only blocked for now, the milliseconds until
 *   their cooldown ends: a pickup trip may still end on such a tile, counting
 *   its time as at least that long. `keep` is the id of the current intention:
 *   it is always scored afresh and never left out by the net gain rule, so
 *   that it is compared with the others at its current value.
 */

/**
 * How many tiles with parcels are scored, the nearest first. Each costs one
 * breadth-first search of the map, and parcels further away than this many
 * others are seldom the best choice.
 */
const MAX_PICKUP_TILES = 20;

/**
 * The id of the option that delivers on the tile (x, y).
 * @param {number} x
 * @param {number} y
 */
export const deliverId = (x, y) => `deliver:${x},${y}`;

/**
 * The chance that the agent reaches a parcel before the nearest rival does,
 * when the agent needs `movesThere` moves and the rival `rivalMoves`. A rival
 * that is two or more moves further away is no threat. The rival's distance
 * is measured without walls, so it is never more than its real route, and the
 * estimate errs toward a parcel being contested.
 * @param {number} movesThere
 * @param {number} rivalMoves  Infinity when no rival is known
 */
export function winChance(movesThere, rivalMoves) {
  const lead = rivalMoves - movesThere;
  if (lead >= 2) return 1;
  if (lead === 1) return 0.8;
  if (lead === 0) return 0.5;
  if (lead === -1) return 0.25;
  return 0.1;
}

/**
 * Everything the agent could do now, best first (design.md section 2).
 * Pickups and deliveries are scored by the reward expected on delivery and
 * left out when worth nothing; exploring is always worth nothing. Options
 * that cannot be reached are left out.
 *
 * A pickup takes every free parcel on its tile, up to the agent's capacity,
 * so the parcels of one tile are scored together. A trip ends on the
 * delivery tile where it is worth most, which is the nearest one unless the
 * game scores some tiles twice.
 *
 * When the agent stands on the best delivery tile while carrying parcels,
 * delivering there costs no moves at all, so that option gets a higher
 * priority and replaces whatever the agent was doing (design.md section 4).
 * @param {Beliefs} beliefs
 * @param {OptionPolicy} [policy]
 * @returns {Option[]}
 */
export function listOptions(beliefs, { strategy = 'baseline', minGain = 1, timeValue = 0, excluded = new Set(),
  deliveryCooldowns = new Map(), keep = null } = {}) {
  const { config, map, me } = beliefs;
  if (!config || !map || !me) return [];

  const now = beliefs.now();
  /** @type {PathOptions} */
  const paths = { now, occupied: beliefs.agents.occupied(now) };
  const moveMs = config.GAME.player.movement_duration;
  const decayMs = beliefs.parcels.decayMs;
  const netGain = strategy === 'net_gain';
  // The baseline scores reward alone; net_gain charges for the time a trip takes.
  const perMs = netGain ? Math.max(0, timeValue) : 0;
  const rivals = netGain ? beliefs.agents.rivals(now) : [];

  /**
   * @typedef {{ reward: number, chance: number }} Load  a parcel's current
   *   value, and the chance that the agent gets to deliver it
   */
  /** @type {Load[]} */
  const carried = beliefs.parcels.carriedBy(me.id, now).map(p => ({ reward: p.reward, chance: 1 }));
  /** What the parcels are still worth after `tripMs`, before the time cost. @param {Load[]} load @param {number} tripMs */
  const rewardAt = (load, tripMs) => {
    const lost = decayTicks(now, now + tripMs, decayMs);
    return load.reduce((sum, p) => sum + p.chance * Math.max(0, p.reward - lost), 0);
  };

  const loop = playableLoop(map, me, now);
  const deliveries = map.deliveryTiles()
    .filter(t => !loop || loop.deliveries.has(key(t.x, t.y)))
    .map(t => {
      const id = deliverId(t.x, t.y);
      const usable = !excluded.has(id);
      // A tile only blocked for now may still end a pickup trip that reaches it after its cooldown.
      const waitMs = usable ? 0 : deliveryCooldowns.get(id);
      return { x: t.x, y: t.y, id, multiplier: map.deliveryMultiplier(t.x, t.y), usable, waitMs };
    });

  /**
   * The delivery tile where a trip is worth most, and what it is worth. The
   * trip has already taken `movesSoFar` moves and goes on from the tile whose
   * distances are `distances`. With `cooling`, the trip may also end on a tile
   * that is only blocked for now, arriving no sooner than its cooldown ends.
   * @param {Load[]} load
   * @param {Map<TileKey, number>} distances
   * @param {number} movesSoFar
   * @param {boolean} cooling
   */
  const bestDelivery = (load, distances, movesSoFar, cooling) => {
    /** @type {{ target: typeof deliveries[number], moves: number, tripMs: number, value: number } | null} */
    let best = null;
    for (const tile of deliveries) {
      if (!tile.usable && !(cooling && tile.waitMs !== undefined)) continue;
      const leg = distances.get(key(tile.x, tile.y));
      if (leg === undefined) continue;
      const moves = movesSoFar + leg;
      const tripMs = Math.max(moves * moveMs, tile.waitMs ?? 0);
      const value = tile.multiplier * rewardAt(load, tripMs) - perMs * tripMs;
      if (!best || value > best.value || (value === best.value && tripMs < best.tripMs)) {
        best = { target: tile, moves, tripMs, value };
      }
    }
    return best;
  };

  const fromMe = distancesThroughCrates(map, me, paths);
  // The trip that delivers what the agent carries without picking up more.
  const direct = carried.length > 0 ? bestDelivery(carried, fromMe, 0, false) : null;
  // What delivering straight away is worth: the value a pickup must beat.
  const deliverNow = direct ? direct.value : 0;

  /** @type {Option[]} */
  const options = [];

  const capacity = config.GAME.player.capacity;
  const room = capacity === -1 ? Infinity : capacity - carried.length;
  if (room > 0) {
    /** @type {Map<TileKey, { x: number, y: number, k: TileKey, parcels: import('../types.js').Parcel[] }>} */
    const byTile = new Map();
    for (const parcel of beliefs.parcels.free(now)) {
      const k = key(parcel.x, parcel.y);
      if (!byTile.has(k)) byTile.set(k, { x: parcel.x, y: parcel.y, k, parcels: [] });
      byTile.get(k)?.parcels.push(parcel);
    }
    const tiles = [...byTile.values()]
      .filter(t => fromMe.has(t.k))
      .sort((a, b) => /** @type {number} */ (fromMe.get(a.k)) - /** @type {number} */ (fromMe.get(b.k)))
      .slice(0, MAX_PICKUP_TILES);
    for (const tile of tiles) tile.parcels.sort((a, b) => b.reward - a.reward);
    const distancesOf = new Map(tiles.map(t => [t.k, distancesThroughCrates(map, t, paths)]));
    /** Moves the nearest rival needs to reach (x, y), measured without walls. @param {Position} p */
    const rivalMoves = p => Math.min(Infinity, ...rivals.map(r => Math.abs(r.x - p.x) + Math.abs(r.y - p.y)));
    /**
     * The parcels a pickup on `tile` takes when it arrives after `moves` moves with `space` left.
     * @param {typeof tiles[number]} tile @param {number} moves @param {number} space
     * @returns {Load[]}
     */
    const takeFrom = (tile, moves, space) => {
      const chance = netGain ? winChance(moves, rivalMoves(tile)) : 1;
      return tile.parcels.slice(0, space).map(p => ({ reward: p.reward, chance }));
    };
    const keepParcel = keep?.startsWith('pickup:') ? keep.slice('pickup:'.length) : null;

    for (const tile of tiles) {
      const moves = /** @type {number} */ (fromMe.get(tile.k));
      const distances = /** @type {Map<TileKey, number>} */ (distancesOf.get(tile.k));
      const taken = takeFrom(tile, moves, room);
      const single = bestDelivery([...carried, ...taken], distances, moves, true);
      if (!single) continue;
      // Parcels that would reach the delivery tile worthless add nothing.
      if (netGain && rewardAt(taken.map(p => ({ ...p, chance: 1 })), single.tripMs) <= 0) continue;
      let utility = single.value;
      // One stop ahead: the parcels of another tile, then delivering.
      if (netGain && room - taken.length > 0) {
        for (const next of tiles) {
          if (next === tile) continue;
          const between = distances.get(next.k);
          if (between === undefined) continue;
          const load = [...carried, ...taken, ...takeFrom(next, moves + between, room - taken.length)];
          const pair = bestDelivery(load, /** @type {Map<TileKey, number>} */ (distancesOf.get(next.k)), moves + between, true);
          if (pair && pair.value > utility) utility = pair.value;
        }
      }
      // The current intention keeps its id while its parcel lies on this tile.
      const parcelId = tile.parcels.some(p => p.id === keepParcel) ? /** @type {string} */ (keepParcel) : tile.parcels[0].id;
      const id = `pickup:${parcelId}`;
      if (netGain && direct && id !== keep && utility - deliverNow < minGain) continue;
      options.push({ id, type: 'pickup', x: tile.x, y: tile.y, utility, priority: 0, parcelId });
    }
  }

  if (direct) {
    const here = direct.moves === 0;
    options.push({ id: direct.target.id, type: 'deliver', x: direct.target.x, y: direct.target.y, utility: deliverNow, priority: here ? 1 : 0 });
  }

  // The baseline drops options worth nothing. Under net_gain a value below
  // zero only means the time costs more than the average trip earns; such an
  // option is still better than doing nothing, and worthless parcels were
  // already left out above.
  const worthwhile = options.filter(o => (netGain || o.utility > 0) && !excluded.has(o.id))
    .sort((a, b) => b.priority - a.priority || b.utility - a.utility);
  const allowed = loop?.spawns ?? null;
  const explore = netGain
    ? exploreByValue(beliefs, fromMe, perMs, allowed)
    : exploreOldest(beliefs, paths, allowed);
  return explore && !excluded.has(explore.id) ? [...worthwhile, explore] : worthwhile;
}

/**
 * The delivery tiles the agent may deliver on now: those it can go on
 * playing from (see playableLoop), less those in `excluded`, such as tiles
 * that failed recently.
 * @param {Beliefs} beliefs
 * @param {ReadonlySet<string>} excluded  option ids, as deliverId gives them
 * @returns {Position[]}
 */
export function usableDeliveryTiles(beliefs, excluded) {
  const { map, me } = beliefs;
  if (!map || !me) return [];
  const loop = playableLoop(map, me, beliefs.now());
  return map.deliveryTiles()
    .filter(t => !loop || loop.deliveries.has(key(t.x, t.y)))
    .filter(t => !excluded.has(deliverId(t.x, t.y)));
}

/**
 * The tiles the agent should keep to, so that it never walks into a one-way
 * trap (see GridMap.sustainableTiles): only delivery and spawn tiles from
 * which play can go on for ever. Pickups are then only offered when the
 * parcel can be carried on to one of those delivery tiles.
 *
 * Returns null when no such rule should apply: when the map has no such
 * tiles, or when the agent is already inside a trap and cannot get back to
 * them. Every tile is then allowed again, so that the agent still delivers
 * whatever it can reach.
 * @param {NonNullable<Beliefs['map']>} map
 * @param {Position} me
 * @param {number} now
 */
function playableLoop(map, me, now) {
  const loop = map.sustainableTiles();
  if (loop.deliveries.size === 0) return null;
  const targets = [...loop.deliveries, ...loop.spawns].map(k => {
    const [x, y] = k.split(',').map(Number);
    return { x, y };
  });
  const back = findNearest(map, me, targets, { now, ignoreTemporary: true });
  return back ? loop : null;
}

/**
 * The baseline's exploring: head for the reachable spawn tile seen longest
 * ago, other than the one the agent stands on.
 * @param {Beliefs} beliefs
 * @param {PathOptions} paths
 * @param {ReadonlySet<string> | null} allowed  the spawn tiles to keep to, or
 *   null for all of them
 * @returns {Option | undefined}
 */
function exploreOldest(beliefs, paths, allowed) {
  const map = /** @type {NonNullable<Beliefs['map']>} */ (beliefs.map);
  const me = /** @type {NonNullable<Beliefs['me']>} */ (beliefs.me);
  const spawns = map.spawnTiles()
    .filter(t => !allowed || allowed.has(key(t.x, t.y)))
    .filter(t => t.x !== me.x || t.y !== me.y)
    .sort((a, b) => map.lastSeen(a.x, a.y) - map.lastSeen(b.x, b.y));
  const target = spawns.find(t => findPath(map, me, t, paths) !== null);
  return target && { id: `explore:${target.x},${target.y}`, type: 'explore', x: target.x, y: target.y, utility: 0, priority: 0 };
}

/**
 * The net_gain strategy's exploring: head for the spawn tile from which the
 * agent would see the most parcels it does not know of yet, after the time
 * to walk there. Standing on a tile shows every tile within the observation
 * distance (Manhattan, as the server's Sensor.js counts it), so a target is
 * worth what all the spawn tiles in that area are expected to hold, not
 * only its own. A spawn tile not seen for a while has had time to get a
 * parcel: one appears on some spawn tile every generation interval, so on a
 * given tile about once per interval times the number of spawn tiles. Time
 * unseen counts up to that, so that a tile is expected to hold one parcel at
 * most, and up to a parcel's lifetime, since a parcel lasts only until it
 * has decayed to nothing. A tile never seen counts as unseen for that long.
 *
 * The value only ranks the spawn tiles: the option itself is worth nothing
 * and ranks below every pickup and delivery, so that any of them replaces it.
 * @param {Beliefs} beliefs
 * @param {Map<TileKey, number>} fromMe  moves to every tile the agent can reach
 * @param {number} perMs  the value of time, in points per millisecond
 * @param {ReadonlySet<string> | null} allowed  the spawn tiles to keep to, or
 *   null for all of them
 * @returns {Option | undefined}
 */
function exploreByValue(beliefs, fromMe, perMs, allowed) {
  const map = /** @type {NonNullable<Beliefs['map']>} */ (beliefs.map);
  const me = /** @type {NonNullable<Beliefs['me']>} */ (beliefs.me);
  const config = /** @type {NonNullable<Beliefs['config']>} */ (beliefs.config);
  const now = beliefs.now();
  const allSpawns = map.spawnTiles();
  const spawns = allSpawns
    .filter(t => !allowed || allowed.has(key(t.x, t.y)))
    .filter(t => (t.x !== me.x || t.y !== me.y) && fromMe.has(key(t.x, t.y)));
  if (spawns.length === 0) return undefined;

  const { reward_avg: rewardAvg, generation_event: generation } = config.GAME.parcels;
  let generationMs = Infinity;
  try { generationMs = decayIntervalMs(generation, config.CLOCK); } catch { /* an unknown event: parcels are not expected */ }
  // Points expected per millisecond a spawn tile stays unseen, and how long that counts.
  const perUnseenMs = Number.isFinite(generationMs) ? rewardAvg / (generationMs * allSpawns.length) : 0;
  const longestUnseenMs = Math.min(rewardAvg * beliefs.parcels.decayMs, generationMs * allSpawns.length);
  const moveMs = config.GAME.player.movement_duration;
  const seen = config.GAME.player.observation_distance;
  // With unlimited observation every spawn tile is always in view.
  const radius = seen < 0 ? 0 : seen;

  // Expected points on each spawn tile, summed over the area seen from a
  // target. In the coordinates u = x + y and v = x - y, the tiles within
  // Manhattan distance r form a square, so a table of running sums gives the
  // total of any such area at once, however many spawn tiles the map has.
  const size = map.width + map.height;
  const offset = map.height;
  const sums = new Float64Array((size + 1) * (size + 1));
  const at = (/** @type {number} */ u, /** @type {number} */ v) => u * (size + 1) + v;
  for (const t of allSpawns) {
    const expected = perUnseenMs === 0 ? 0 : perUnseenMs * Math.min(now - map.lastSeen(t.x, t.y), longestUnseenMs);
    sums[at(t.x + t.y + 1, t.x - t.y + offset + 1)] += expected;
  }
  for (let u = 1; u <= size; u++) {
    for (let v = 1; v <= size; v++) sums[at(u, v)] += sums[at(u - 1, v)] + sums[at(u, v - 1)] - sums[at(u - 1, v - 1)];
  }
  /** The expected points within `radius` of (x, y). @param {Position} t */
  const inView = ({ x, y }) => {
    const clamp = (/** @type {number} */ n) => Math.max(0, Math.min(size, n));
    const u0 = clamp(x + y - radius), u1 = clamp(x + y + radius + 1);
    const v0 = clamp(x - y + offset - radius), v1 = clamp(x - y + offset + radius + 1);
    return sums[at(u1, v1)] - sums[at(u0, v1)] - sums[at(u1, v0)] + sums[at(u0, v0)];
  };

  /** @param {Position} t */
  const value = t => inView(t) - perMs * /** @type {number} */ (fromMe.get(key(t.x, t.y))) * moveMs;
  let target = spawns[0];
  let best = value(target);
  for (const t of spawns.slice(1)) {
    const v = value(t);
    const nearer = /** @type {number} */ (fromMe.get(key(t.x, t.y))) < /** @type {number} */ (fromMe.get(key(target.x, target.y)));
    if (v > best || (v === best && nearer)) { target = t; best = v; }
  }
  return { id: `explore:${target.x},${target.y}`, type: 'explore', x: target.x, y: target.y, utility: 0, priority: -1 };
}
