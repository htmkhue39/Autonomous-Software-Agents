import { ToolFailure, ToolRegistry } from '../tools/registry.js';
import { gameObservation } from './observations.js';
import { findNearest } from '../../planning/astar.js';
import { parcelOpportunities } from './viability.js';
import { selectDeliveryParking } from './evacuation.js';

/** @typedef {import('../../beliefs/index.js').Beliefs} Beliefs */
/** @typedef {import('../../plans/library.js').PlanLibrary} PlanLibrary */
/** @typedef {import('../../types.js').StopSignal} StopSignal */
/** @typedef {import('../../types.js').Option} Option */

/** @type {import('../validation.js').SimpleSchema} */
const empty = { type: 'object', additionalProperties: false, required: [], properties: {} };
const coordinateSchema = { type: 'object', additionalProperties: false, required: ['x', 'y'],
  properties: { x: { type: 'integer', minimum: 0, maximum: 999 }, y: { type: 'integer', minimum: 0, maximum: 999 } } };

/** @param {Beliefs} beliefs */
function ready(beliefs) {
  if (!beliefs.ready || !beliefs.positionStable || !beliefs.me || !beliefs.map) {
    throw new ToolFailure('not_ready', 'Game state is not ready or the agent is between tiles; inspect again');
  }
  return { me: beliefs.me, map: beliefs.map };
}

/**
 * Convert a cancellation-aware SDK plan into an LLM tool. All navigation and
 * action reconciliation continue to use the tested Stage 1.1 implementation.
 * @param {PlanLibrary} plans
 * @param {Option} option
 * @param {AbortSignal | undefined} signal
 * @param {()=>boolean} [yieldedClaim] True only for a peer-won parcel claim.
 */
async function executePlan(plans, option, signal, yieldedClaim = () => false) {
  // A claim yield before plan dispatch is known-safe: no SDK pickup was sent.
  if (signal?.aborted) {
    if (yieldedClaim()) throw new ToolFailure('coordination_conflict', 'Teammate won the parcel before action dispatch');
    throw new ToolFailure('outcome_unknown', 'Action cancelled before execution');
  }
  /** @type {StopSignal} */ const stop = { stopped: false };
  const cancel = () => { stop.stopped = true; };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const outcome = await plans.execute(option, stop);
    // Stage 2C.2.1: navigation cancelled at a safe boundary after a peer
    // wins the claim. PlanLibrary sets stop.finishing BEFORE the actual SDK
    // pickup/putdown dispatch, so this branch cannot mask a possible pickup.
    // Never reselect after an unknown result or after the action phase began.
    if (yieldedClaim() && outcome.status === 'cancelled' && !stop.finishing) {
      throw new ToolFailure('coordination_conflict', 'Teammate won claim; navigation stopped before pickup dispatch');
    }
    if (signal?.aborted || outcome.status === 'unknown' || outcome.status === 'cancelled') {
      throw new ToolFailure('outcome_unknown', outcome.reason || 'Action interrupted; observe game state before retrying');
    }
    if (outcome.status !== 'completed') throw new ToolFailure('game_action_failed', outcome.reason || 'Game plan failed');
    return outcome;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/**
 * @param {{beliefs:Beliefs,plans:PlanLibrary,progress?:import('./objectives.js').GameProgress,
 * objectiveStatus?:()=>ReturnType<import('./objectives.js').GameProgress['status']>,
 * coordination?:import('../../coordination/controller.js').CoordinationController|null,
 * log?:(event:string,details:object)=>void,
 * cooldowns?:Map<string,number>, deliveryEvacuation?:boolean}} setup
 */
export function createGameTools({ beliefs, plans, progress, objectiveStatus, coordination = null, log = () => {}, cooldowns = new Map(), deliveryEvacuation = false }) {
  const registry = new ToolRegistry();
  const failedTargetUntil = cooldowns;
  const opportunities = () => parcelOpportunities(beliefs, { coordination, cooldowns: failedTargetUntil });
  /** @param {string} excluded */
  const freshAlternatives = (excluded) => opportunities()
    .filter(p => p.id !== excluded && p.viable && p.freshForAction)
    .slice(0, 3).map(p => ({ id: p.id, expectedDeliveryReward: p.expectedDeliveryReward }));
  /** @param {string} parcelId @param {string} reason */
  const cooldown = (parcelId, reason) => {
    const until = beliefs.now() + 8000;
    failedTargetUntil.set(parcelId, until);
    log('llm_target_cooldown', { parcelId, reason, cooldownMs: 8000 });
  };
  const state = () => ({ ...gameObservation(beliefs, { coordination, cooldowns,
    objectiveProgress: objectiveStatus?.() ?? null }), progress: progress?.snapshot() ?? null });

  registry.register({
    name: 'get_game_state',
    description: 'Refresh your own position, score, carried parcels, partial parcel beliefs and delivery tiles. Read before choosing actions.',
    parameters: empty,
    execute: state,
  });
  registry.register({
    name: 'get_known_parcels',
    description: 'Ranked known parcels with ID, static reachability, expected reward at DELIVERY, viability, and teammate claims. Prefer viable=true; if none are viable, explore. The estimates are not guarantees.',
    parameters: empty,
    execute: () => ({ free: opportunities().slice(0, 25),
      caveat: 'Historical IDs in this snapshot are NOT live reservations. For delivery goals prefer collect_best_and_deliver(strategy) which selects a fresh viable target at tool execution time.' }),
  });
  registry.register({
    name: 'get_delivery_tiles',
    description: 'Return known delivery coordinates. A delivery tile is not necessarily reachable via Manhattan distance.',
    parameters: empty,
    execute: () => ({ deliveryTiles: beliefs.map?.deliveryTiles().slice(0, 50) ?? [] }),
  });
  if (coordination) registry.register({
    name: 'get_cooperation_state',
    description: 'Inspect teammate position, current intention, and parcel claims. Respect unavailable parcels; coordinate through the automatic claim protocol.',
    parameters: empty,
    execute: () => coordination.summary(),
  });
  registry.register({
    name: 'navigate_to',
    description: 'Move to integer map coordinates using deterministic A* and the validated SDK executor. No LLM call is needed per tile. Coordinates must be walkable.',
    parameters: /** @type {import('../validation.js').SimpleSchema} */ (coordinateSchema),
    execute: async ({ x, y }, { signal }) => {
      const { map } = ready(beliefs);
      if (!map.isWalkable(x, y, beliefs.now())) throw new ToolFailure('game_action_failed', 'Target tile is not walkable');
      await executePlan(plans, { id: `llm-goto:${x},${y}`, type: 'goto', x, y, utility: 0, priority: 1 }, signal);
      return { reached: { x, y }, self: { x: beliefs.me?.x, y: beliefs.me?.y } };
    },
  });
  /**
   * Shared game action helpers. The LLM may call these independently, or use
   * collect_and_deliver to avoid an extra multi-second model decision while a
   * parcel's remaining reward is decaying.
   * @param {string} parcel_id
   * @param {AbortSignal | undefined} signal
   */
  async function pickupKnown(parcel_id, signal) {
    const { me } = ready(beliefs);
    const parcel = beliefs.parcels.get(parcel_id, beliefs.now());
    if (!parcel || parcel.carriedBy) {
      cooldown(parcel_id, 'missing_or_expired');
      log('llm_target_precondition_rejected', { parcelId: parcel_id, reason: 'missing_or_expired' });
      throw new ToolFailure('game_action_failed', 'Parcel unknown, unavailable, expired or already carried; inspect again or use collect_best_and_deliver', { precondition: true, reason: 'missing_or_expired', alternatives: freshAlternatives(parcel_id) });
    }
    if (coordination && !coordination.canTarget(parcel_id, parcel)) {
      log('llm_target_precondition_rejected', { parcelId: parcel_id, reason: 'teammate_claim' });
      throw new ToolFailure('coordination_conflict', 'Teammate has priority for this parcel; choose another target');
    }
    const opportunity = opportunities().find(p => p.id === parcel_id);
    if (!opportunity?.viable) {
      log('llm_parcel_rejected', { parcelId: parcel_id, reason: opportunity?.reason ?? 'unknown',
        expectedDeliveryReward: opportunity?.expectedDeliveryReward ?? 0 });
      log('llm_target_precondition_rejected', { parcelId: parcel_id, reason: opportunity?.reason ?? 'unknown' });
      throw new ToolFailure('game_action_failed', `Parcel is not a viable delivery candidate (${opportunity?.reason ?? 'unknown'}); inspect alternatives or explore`, { precondition: true, reason: opportunity?.reason ?? 'unknown', alternatives: freshAlternatives(parcel_id) });
    }
    const capacity = beliefs.config?.GAME.player.capacity ?? 0;
    if (capacity >= 0 && beliefs.parcels.carriedBy(me.id, beliefs.now()).length >= capacity) {
      throw new ToolFailure('game_action_failed', 'Carrying capacity reached; deliver first');
    }
    const localAbort = new AbortController();
    let yieldedToTeammate = false;
    const combined = signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal;
    if (coordination) {
      const claimed = await coordination.acquire(parcel_id, parcel, { signal: combined, onYield: () => {
        yieldedToTeammate = true;
        localAbort.abort();
      } });
      if (!claimed) throw new ToolFailure('coordination_conflict', 'Teammate has priority for this parcel; choose another target');
      coordination.setIntention(`pickup:${parcel_id}`);
    }
    let collected = false;
    try {
      // A peer might have collected the target during the claim settlement.
      const current = beliefs.parcels.get(parcel_id, beliefs.now());
      if (!current || current.carriedBy) {
        cooldown(parcel_id, 'unavailable_after_claim');
        log('llm_target_precondition_rejected', { parcelId: parcel_id, reason: 'unavailable_after_claim' });
        throw new ToolFailure('game_action_failed', 'Parcel unavailable after claim; refresh observations', { precondition: true, reason: 'unavailable_after_claim', alternatives: freshAlternatives(parcel_id) });
      }
      try {
        await executePlan(plans, { id: `llm-pickup:${parcel_id}`, type: 'pickup', parcelId: parcel_id,
          x: Math.round(current.x), y: Math.round(current.y), utility: current.reward, priority: 1 }, combined, () => yieldedToTeammate);
      } catch (error) {
        if (error instanceof ToolFailure && error.code === 'coordination_conflict') {
          log('llm_coordination_safe_yield', { parcelId: parcel_id, reason: 'navigation_cancelled_before_pickup' });
        }
        // A coordination yield is not a parcel failure: do not cooldown the
        // parcel, since teammate arbitration already governs availability.
        if (!(error instanceof ToolFailure) || !['outcome_unknown', 'coordination_conflict'].includes(error.code)) cooldown(parcel_id, 'pickup_failed');
        throw error;
      }
      collected = true;
      return { picked: parcel_id, carrying: beliefs.parcels.carriedBy(me.id, beliefs.now()).map(p => p.id) };
    } finally {
      if (coordination) {
        coordination.release(parcel_id, collected ? 'collected' : 'failed');
        coordination.setIntention(null);
      }
    }
  }

  /** @param {AbortSignal | undefined} signal */
  async function deliverCarried(signal) {
    const { me, map } = ready(beliefs);
    const carried = beliefs.parcels.carriedBy(me.id, beliefs.now());
    if (carried.length === 0) {
      log('llm_inventory_reconciled', { carryingCount: 0, reason: 'nothing_carried_or_expired' });
      throw new ToolFailure('game_action_failed', 'Not carrying any known parcel; it may have expired. Inspect and collect a NEW viable target.');
    }
    const now = beliefs.now();
    const destinations = map.deliveryTiles();
    // If only temporary occupancy blocks every delivery lane, still choose a
    // statically reachable tile. MovementRunner then waits safely for clearance.
    const destination = findNearest(map, me, destinations, { now, occupied: beliefs.agents.occupied(now) })
      ?? findNearest(map, me, destinations, { now, ignoreTemporary: true });
    if (!destination) throw new ToolFailure('game_action_failed', 'No statically reachable delivery tile');
    const scoreBefore = me.score;
    coordination?.setIntention('deliver');
    try {
      try {
        await executePlan(plans, { id: 'llm-deliver', type: 'deliver', x: destination.target.x,
          y: destination.target.y, utility: 0, priority: 1 }, signal);
      } catch (error) {
        if (!(error instanceof ToolFailure) || error.code !== 'outcome_unknown') {
          const remaining = beliefs.parcels.carriedBy(me.id, beliefs.now()).map(p => p.id);
          log('llm_inventory_reconciled', { carryingCount: remaining.length, ids: remaining,
            reason: error instanceof Error ? error.message : String(error) });
        }
        throw error;
      }
      // Post-putdown traffic management is intentionally separate from the
      // confirmed delivery. No delivery can be undone by a failed evacuation.
      // Only execute a new move AFTER PlanLibrary has acknowledged putdown.
      const deliveryResult = { deliveredParcelIds: carried.map(p => p.id), destination: destination.target,
        scoreBefore, scoreNow: beliefs.me?.score ?? null, deliveryProgress: progress?.snapshot() ?? null };
      /** @type {{status:string,reason?:string,target?:{x:number,y:number}}} */
      let evacuation = { status: 'disabled', reason: 'not_enabled' };
      if (deliveryEvacuation) {
        const at = beliefs.me;
        if (signal?.aborted) {
          evacuation = { status: 'interrupted', reason: 'deadline_or_external_abort_before_evacuation' };
        } else if (!at || !beliefs.positionStable || map.typeAt(at.x, at.y) !== '2') {
          evacuation = { status: 'not_on_delivery_tile', reason: 'already_clear_or_position_unstable' };
        } else {
          const parking = selectDeliveryParking(beliefs);
          if (!parking) {
            evacuation = { status: 'no_safe_target', reason: 'no_unoccupied_reachable_non_delivery_tile' };
          } else {
            log('llm_delivery_evacuate_selected', { from: { x: at.x, y: at.y }, ...parking });
            coordination?.setIntention('evacuate_delivery_tile');
            const started = performance.now();
            try {
              await executePlan(plans, { id: `llm-evacuate:${parking.target.x},${parking.target.y}`,
                type: 'goto', ...parking.target, utility: 0, priority: 1 }, signal);
              // Arrival is checked through the Stage 1.1 acknowledged moves;
              // never claim that the tile was vacated on a failed route.
              const actual = beliefs.me;
              if (actual?.x !== parking.target.x || actual?.y !== parking.target.y) {
                throw new ToolFailure('outcome_unknown', 'Evacuation position not confirmed by game beliefs');
              }
              evacuation = { status: 'vacated', target: parking.target };
            } catch (error) {
              if (!(error instanceof ToolFailure) || error.code === 'outcome_unknown') {
                // An ambiguous MOVE cannot be treated as ordinary success:
                // the game may have moved us. Do not let the model issue a
                // follow-up move until the outcome has been reconciled.
                log('llm_delivery_evacuate_result', { status: 'uncertain',
                  reason: error instanceof Error ? error.message : String(error),
                  durationMs: Math.round(performance.now() - started), deliveryConfirmed: true });
                throw error;
              }
              // A known navigation failure cannot undo a confirmed delivery.
              evacuation = { status: 'blocked', reason: error.message };
            }
            log('llm_delivery_evacuate_result', { ...evacuation,
              durationMs: Math.round(performance.now() - started), deliveryConfirmed: true });
          }
        }
        if (evacuation.status !== 'vacated' && evacuation.status !== 'blocked') {
          log('llm_delivery_evacuate_result', { ...evacuation, deliveryConfirmed: true });
        }
      }
      // When switched off, preserve the baseline tool result byte-for-byte in
      // structure: B remains an unmodified independent control condition.
      return deliveryEvacuation ? { ...deliveryResult, evacuation } : deliveryResult;
    } finally { coordination?.setIntention(null); }
  }

  registry.register({
    name: 'pickup_parcels',
    description: 'Travel to and pick up the exact known parcel ID. For an immediate delivery objective on a decaying map, prefer collect_and_deliver instead to avoid another slow LLM call.',
    parameters: { type: 'object', additionalProperties: false, required: ['parcel_id'],
      properties: { parcel_id: { type: 'string', minLength: 1, maxLength: 128 } } },
    execute: ({ parcel_id }, { signal }) => pickupKnown(parcel_id, signal),
  });
  registry.register({
    name: 'deliver_parcels',
    description: 'Automatically select a reachable delivery tile with A* and deliver ALL currently carried parcels there. Do not call if not carrying parcels.',
    parameters: empty,
    execute: (_args, { signal }) => deliverCarried(signal),
  });
  registry.register({
    name: 'collect_and_deliver',
    description: 'Time-critical HIGH-LEVEL action: pick up a known available parcel by exact ID and IMMEDIATELY navigate to a reachable delivery tile and put down carried parcels. Both steps run without another LLM inference, reducing parcel expiration. Best for goals that require completed deliveries. If the parcel disappears, inspect and select another.',
    parameters: { type: 'object', additionalProperties: false, required: ['parcel_id'],
      properties: { parcel_id: { type: 'string', minLength: 1, maxLength: 128 } } },
    execute: async ({ parcel_id }, { signal }) => {
      const pickup = await pickupKnown(parcel_id, signal);
      // Fail closed if it expired after pickup. A fresh LLM action should
      // inspect the now-current world rather than treating delivery as done.
      if (signal?.aborted) throw new ToolFailure('outcome_unknown', 'Collection interrupted; reconcile state');
      const delivery = await deliverCarried(signal);
      return { pickup, delivery };
    },
  });
  /** Deterministic single exploration trip, available as its own tool and as
   * a bounded fallback when the dynamic collector has no recent candidate.
   * @param {AbortSignal | undefined} signal
   */
  async function exploreArea(signal) {
      const { me, map } = ready(beliefs);
      const now = beliefs.now();
      const locations = map.spawnTiles().filter(p => p.x !== me.x || p.y !== me.y)
        .sort((a, b) => map.lastSeen(a.x, a.y) - map.lastSeen(b.x, b.y));
      const leastSeen = locations.filter(p => now - map.lastSeen(p.x, p.y) > 2500);
      let destination = findNearest(map, me, leastSeen.slice(0, 24), { now, occupied: beliefs.agents.occupied(now) });
      if (!destination) destination = findNearest(map, me, locations.slice(0, 24), { now, occupied: beliefs.agents.occupied(now) });
      if (!destination) throw new ToolFailure('game_action_failed', 'No reachable exploration target');
      await executePlan(plans, { id: 'llm-explore', type: 'explore', x: destination.target.x,
        y: destination.target.y, utility: 0, priority: 1 }, signal);
      return { explored: destination.target, state: gameObservation(beliefs, { maxParcels: 8 }) };
  }

  registry.register({
    name: 'explore',
    description: 'Navigate automatically to a reachable parcel-spawn tile that has not been sensed recently. Use when no worthwhile parcel is known.',
    parameters: empty,
    execute: async (_args, { signal }) => exploreArea(signal),
  });
  registry.register({
    name: 'collect_best_and_deliver',
    description: 'Preferred time-critical delivery action: YOU choose a strategy, and the executor selects a NEW, recently observed, viable, unclaimed parcel ID when this call starts. Immediately pick up and deliver without another LLM call. If none is available, optionally explore once and report no target (never invent a delivery). Never pass an old parcel ID.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['strategy'],
      properties: {
        strategy: { type: 'string', enum: ['highest_expected_reward', 'nearest_viable'] },
        explore_if_empty: { type: 'boolean' },
      },
    },
    execute: async ({ strategy, explore_if_empty = true }, { signal }) => {
      ready(beliefs);
      /** @param {string} phase @param {()=>Promise<any>} action */
      const timed = async (phase, action) => {
        const started = performance.now();
        let status = 'ok';
        try { return await action(); }
        catch (error) { status = error instanceof ToolFailure ? error.code : 'error'; throw error; }
        finally { log('llm_dynamic_phase', { phase, status, durationMs: Math.round(performance.now() - started) }); }
      };
      const skipped = new Set();
      /** @type {{id:string,reason:string}[]} */ const rejected = [];
      let explored = false;
      // A single bounded high-level action. Re-selection is safe only when
      // pickup was NOT executed (precondition/claim/viability rejection).
      // Never retry after a possibly dispatched SDK action or unknown result.
      for (let attempt = 0; attempt < 4; attempt++) {
        if (signal?.aborted) throw new ToolFailure('outcome_unknown', 'Dynamic collection interrupted; reconcile the game state');
        const candidates = opportunities().filter(p => p.viable && p.freshForAction && !skipped.has(p.id));
        candidates.sort((a, b) => strategy === 'nearest_viable'
          ? (a.pickupSteps ?? Infinity) - (b.pickupSteps ?? Infinity) || b.expectedDeliveryReward - a.expectedDeliveryReward
          : b.expectedDeliveryReward - a.expectedDeliveryReward || (a.estimatedTimeMs ?? Infinity) - (b.estimatedTimeMs ?? Infinity));
        const best = candidates[0];
        if (!best) {
          if (explore_if_empty && !explored) {
            explored = true;
            log('llm_dynamic_explore', { reason: 'no_recent_viable_parcel', known: opportunities().length });
            try {
              await timed('explore', () => exploreArea(signal));
            } catch (error) {
              if (!(error instanceof ToolFailure) || error.code !== 'game_action_failed') throw error;
              return { status: 'no_viable_target', reason: 'exploration_unavailable',
                detail: error.message, attempts: rejected, nextAction: 'Wait for new observations or inspect the map' };
            }
            continue;
          }
          log('llm_dynamic_no_target', { known: opportunities().length, explored, rejected: rejected.length });
          return { status: 'no_viable_target', reason: explored ? 'none_after_exploration' : 'no_recent_viable_parcel',
            attempts: rejected, nextAction: 'Explore or wait for a new parcel observation. Do not reuse an old ID.' };
        }
        skipped.add(best.id);
        log('llm_dynamic_selected', { parcelId: best.id, strategy, expectedDeliveryReward: best.expectedDeliveryReward,
          observedAgeMs: best.observedAgeMs, source: best.source, attempt: attempt + 1 });
        let pickup;
        try {
          pickup = await timed('pickup_pipeline', () => pickupKnown(best.id, signal));
        } catch (error) {
          // Only these errors prove that no SDK pickup was dispatched.
          // Real action errors and unknown outcomes MUST return to the model.
          if (!(error instanceof ToolFailure) || !(error.precondition || error.code === 'coordination_conflict')) throw error;
          rejected.push({ id: best.id, reason: error.reason ?? error.code });
          log('llm_dynamic_reselected', { rejectedParcelId: best.id, reason: error.reason ?? error.code });
          continue;
        }
        const delivery = await timed('delivery_pipeline', () => deliverCarried(signal));
        log('llm_dynamic_delivered', { parcelId: best.id, deliveredCount: delivery.deliveredParcelIds.length });
        return { status: 'delivered', selectedParcelId: best.id, strategy, pickup, delivery, attempts: rejected };
      }
      log('llm_dynamic_no_target', { known: opportunities().length, explored, rejected: rejected.length, reason: 'bounded_retry_limit' });
      return { status: 'no_viable_target', reason: 'bounded_retry_limit', attempts: rejected,
        nextAction: 'Inspect or explore after the world changes' };
    },
  });
  return registry;
}
