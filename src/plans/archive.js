/**
 * The Plan Library's archive of plans, as on page 2 of the course slides.
 *
 * Plans are kept by places that come back again and again, not by parcels,
 * which are delivered once: the tile the agent starts on, the parcel's tile,
 * the delivery tile, and how many parcels the agent carries (a plan has one
 * putdown for each). After a delivery the agent starts from a delivery tile,
 * and parcels appear on the same spawn tiles, so the same keys come back.
 *
 * The archive holds at most `size` plans. When it is full, the plan that was
 * used least recently is dropped.
 */
export class PlanArchive {
  /** @param {{ size?: number }} [settings] */
  constructor({ size = 500 } = {}) {
    this.size = Math.max(1, size);
    /** @type {Map<string, import('../types.js').DecodedPlan>} in order of use, the oldest first */
    this.plans = new Map();
  }

  /** @param {string} key */
  get(key) {
    const plan = this.plans.get(key);
    if (plan === undefined) return undefined;
    // Move it to the end: it is now the most recently used.
    this.plans.delete(key);
    this.plans.set(key, plan);
    return plan;
  }

  /** @param {string} key @param {import('../types.js').DecodedPlan} plan */
  set(key, plan) {
    this.plans.delete(key);
    this.plans.set(key, plan);
    while (this.plans.size > this.size) {
      const oldest = this.plans.keys().next().value;
      if (oldest === undefined) break;
      this.plans.delete(oldest);
    }
  }

  /** @param {string} key */
  delete(key) {
    this.plans.delete(key);
  }

  get count() {
    return this.plans.size;
  }
}

/**
 * The archive key of a plan: its kind, the tiles it connects, and how many
 * parcels the agent carries when it starts.
 * @param {import('../types.js').PlanGoal} goal
 * @param {import('../types.js').Position} from
 * @param {number} carried
 */
export function archiveKey(goal, from, carried) {
  const at = (/** @type {import('../types.js').Position} */ p) => `${p.x},${p.y}`;
  const places = goal.kind === 'trip' ? [from, goal.parcelAt, goal.deliverAt]
    : goal.kind === 'deliver' ? [from, goal.deliverAt] : [from, goal.parcelAt];
  return `${goal.kind} ${places.map(at).join('>')} c${carried}`;
}
