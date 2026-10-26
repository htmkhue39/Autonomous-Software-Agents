import { moveTo } from './moveTo.js';

/**
 * @typedef {import('./moveTo.js').PlanContext} PlanContext
 * @typedef {import('../types.js').Option} Option
 * @typedef {import('../types.js').StopSignal} StopSignal
 * @typedef {(option: Option, signal: StopSignal) => Promise<boolean>} Plan
 */

/**
 * One plan for each kind of option (design.md section 3). Each resolves to
 * true when the option is achieved. Pickups and putdowns happen on the spot
 * as the agent walks (moveTo), so the pickup and deliver plans walk and then
 * check that the parcels were picked up or delivered.
 * @param {PlanContext} ctx
 * @returns {Record<Option['type'], Plan>}
 */
export function planLibrary(ctx) {
  const { beliefs } = ctx;
  /** @param {Option} option @param {StopSignal} signal */
  const walk = (option, signal) => moveTo(ctx, [{ x: option.x, y: option.y }], signal);
  const carried = () => (beliefs.me ? beliefs.parcels.carriedBy(beliefs.me.id, beliefs.now()) : []);

  return {
    async pickup(option, signal) {
      return (await walk(option, signal)) && carried().some(p => p.id === option.parcelId);
    },
    async deliver(_option, signal) {
      const deliveries = beliefs.map?.deliveryTiles() ?? [];
      return (await moveTo(ctx, deliveries, signal)) && carried().length === 0;
    },
    explore: walk,
    goto: walk,
  };
}
