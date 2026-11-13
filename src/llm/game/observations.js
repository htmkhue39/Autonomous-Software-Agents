/** Compact, explicitly partial world view for a small context-window LLM. */
import { parcelOpportunities } from './viability.js';

/** @typedef {import('../../beliefs/index.js').Beliefs} Beliefs */

/**
 * Read the latest known state without claiming that out-of-view parcels still
 * exist. The SDK's sensing radius is authoritative; the map can be globally
 * available while parcels and other agents remain only partially observed.
 * @param {Beliefs} beliefs
 * @param {{maxParcels?:number,maxDeliveries?:number,maxAgents?:number,coordination?:import('../../coordination/controller.js').CoordinationController|null,
 *   cooldowns?:Map<string,number>,objectiveProgress?:ReturnType<import('./objectives.js').GameProgress['status']>|null}} [limits]
 */
export function gameObservation(beliefs, { maxParcels = 12, maxDeliveries = 12, maxAgents = 8,
  coordination = null, cooldowns = new Map(), objectiveProgress = null } = {}) {
  const { me, map, config } = beliefs;
  const now = beliefs.now();
  if (!me || !map || !config) return { ready: false, reason: 'Waiting for config, map and self observations' };
  const free = parcelOpportunities(beliefs, { coordination, cooldowns });
  const carrying = beliefs.parcels.carriedBy(me.id, now)
    .map(({ id, reward }) => ({ id, estimatedReward: reward }));
  const deliveries = map.deliveryTiles().sort((a, b) =>
    (Math.abs(me.x - a.x) + Math.abs(me.y - a.y)) - (Math.abs(me.x - b.x) + Math.abs(me.y - b.y)));
  const others = [...beliefs.agents.occupied(now)].slice(0, maxAgents).map(k => {
    const [x, y] = k.split(',').map(Number);
    return { x, y };
  });
  return {
    ready: true,
    ...(objectiveProgress ? { objectiveProgress } : {}),
    ...(coordination ? { cooperation: coordination.summary() } : {}),
    self: { id: me.id, name: me.name, x: me.x, y: me.y, score: me.score, positionStable: beliefs.positionStable },
    game: { title: config.GAME.title, mapWidth: map.width, mapHeight: map.height,
      capacity: config.GAME.player.capacity, observationDistance: config.GAME.player.observation_distance,
      movementDurationMs: config.GAME.player.movement_duration },
    carrying: { count: carrying.length, parcels: carrying.slice(0, 16) },
    knownFreeParcels: { count: free.length, parcels: free.slice(0, maxParcels),
      note: 'Partially observed. Parcel IDs may disappear during LLM inference. For delivery objectives prefer collect_best_and_deliver(strategy) to select from fresh, viable beliefs at EXECUTION time. Exact-ID tools use snapshots and can become stale.' },
    deliveryTiles: { count: deliveries.length, closestByManhattan: deliveries.slice(0, maxDeliveries),
      note: 'Manhattan proximity is not a guarantee of reachability.' },
    observedOccupiedTiles: others,
  };
}
