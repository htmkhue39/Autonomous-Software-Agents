import { findNearest, findPath } from '../../planning/astar.js';

/** @typedef {import('../../beliefs/index.js').Beliefs} Beliefs */

/**
 * Rank currently KNOWN parcels by estimated reward on delivery. This is a
 * conservative feasibility hint, not an authoritative claim about the world.
 * Static routes ignore temporary occupancy, but never ignore walls/arrows;
 * no movement is ever executed using such diagnostic routes.
 * @param {Beliefs} beliefs
 * @param {{coordination?:import('../../coordination/controller.js').CoordinationController|null,
 *  overheadMs?:number,safetyMs?:number,minExpectedReward?:number,
 *  cooldowns?:Map<string,number>,directFreshMs?:number,peerFreshMs?:number}} [options]
 */
export function parcelOpportunities(beliefs, { coordination = null, overheadMs = 4000,
  safetyMs = 2000, minExpectedReward = 1, cooldowns = new Map(),
  directFreshMs = 3000, peerFreshMs = 1500 } = {}) {
  const { me, map, config } = beliefs;
  if (!me || !map || !config) return [];
  const now = beliefs.now();
  const moveMs = Math.max(1, config.GAME.player.movement_duration);
  const decayMs = beliefs.parcels.decayMs;
  const carrying = beliefs.parcels.carriedBy(me.id, now).length;
  const capacity = config.GAME.player.capacity;
  const deliveries = map.deliveryTiles();
  const occupied = beliefs.agents.occupied(now);
  return beliefs.parcels.free(now).map(p => {
    const path = findPath(map, me, p, { now, ignoreTemporary: true });
    const delivery = findNearest(map, p, deliveries, { now, ignoreTemporary: true });
    const reachable = path !== null && delivery !== null;
    const pickupSteps = path?.length ?? null;
    const deliverySteps = delivery?.path.length ?? null;
    const estimatedTimeMs = path !== null && delivery !== null ? (path.length + delivery.path.length) * moveMs + overheadMs + safetyMs : null;
    const expectedDeliveryReward = !reachable ? 0 : Number.isFinite(decayMs)
      ? Math.max(0, p.reward - Math.ceil((estimatedTimeMs ?? Infinity) / decayMs)) : p.reward;
    const freshness = beliefs.parcels.freshness(p.id, now);
    const observedAgeMs = freshness?.ageMs ?? Infinity;
    const source = freshness?.source ?? 'unknown';
    // Current parcel IDs are transient: older reports can still inform an
    // exploration direction, but should not drive an immediate pickup action.
    const freshForAction = observedAgeMs <= (source === 'peer' ? peerFreshMs : directFreshMs);
    const onCooldown = (cooldowns.get(p.id) ?? -Infinity) > now;
    const claimedByTeammate = coordination ? !coordination.canTarget(p.id, p) : false;
    const atCapacity = capacity >= 0 && carrying >= capacity;
    const viable = reachable && expectedDeliveryReward >= minExpectedReward && !onCooldown &&
      !claimedByTeammate && !atCapacity;
    const blockedNow = reachable && findPath(map, me, p, { now, occupied }) === null;
    return { id: p.id, x: p.x, y: p.y, estimatedReward: p.reward,
      pickupSteps, deliverySteps, estimatedTimeMs, expectedDeliveryReward,
      reachable, viable, blockedNow, claimedByTeammate, onCooldown,
      source, observedAgeMs, freshForAction,
      ...(viable ? {} : { reason: !reachable ? 'unreachable_static_route' : onCooldown ? 'failed_target_cooldown' :
        claimedByTeammate ? 'teammate_claim' : atCapacity ? 'capacity_reached' : 'likely_to_expire' }),
      availableToMe: !claimedByTeammate };
  }).sort((a, b) => Number(b.viable) - Number(a.viable) ||
    b.expectedDeliveryReward - a.expectedDeliveryReward ||
    (a.estimatedTimeMs ?? Infinity) - (b.estimatedTimeMs ?? Infinity));
}
