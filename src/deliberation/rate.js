/**
 * The value of time, in points per millisecond: how fast the agent earns
 * points. The 'net_gain' strategy charges every option this much for each
 * millisecond it takes (utility = reward - rate × time), which is the right
 * trade-off when the goal is the most points per unit of time in a game
 * without a time limit.
 *
 * The rate is learned from the agent's own deliveries over a recent window.
 * It starts from a prior guess, counted as if `priorMs` of play had already
 * earned at that rate, so that the first decisions are sensible and a few
 * lucky or unlucky deliveries do not swing it. The prior never drops out
 * completely, which also keeps the rate above zero: with a rate of zero the
 * agent would see no cost in carrying parcels around forever, never deliver,
 * and so never learn a higher rate.
 */
export class EarningRate {
  /** @type {{ at: number, points: number }[]} */
  #earned = [];

  /**
   * @param {{ priorRate: number, priorMs?: number, windowMs?: number, startedAt?: number }} settings
   *   `priorRate` is the first guess, in points per millisecond. `windowMs` is
   *   how far back deliveries count.
   */
  constructor({ priorRate, priorMs = 30_000, windowMs = 120_000, startedAt = 0 }) {
    if (!Number.isFinite(priorRate) || priorRate < 0 || !Number.isFinite(priorMs) || priorMs <= 0 ||
        !Number.isFinite(windowMs) || windowMs <= 0 || !Number.isFinite(startedAt)) {
      throw new RangeError('Invalid earning rate settings');
    }
    this.priorRate = priorRate;
    this.priorMs = priorMs;
    this.windowMs = windowMs;
    this.startedAt = startedAt;
  }

  /**
   * The agent earned `points` at game time `at`.
   * @param {number} points
   * @param {number} at
   */
  record(points, at) {
    if (points > 0) this.#earned.push({ at, points });
  }

  /**
   * Points per millisecond at game time `now`.
   * @param {number} now
   */
  rate(now) {
    const from = Math.max(this.startedAt, now - this.windowMs);
    this.#earned = this.#earned.filter(e => e.at >= from);
    const points = this.#earned.reduce((sum, e) => sum + e.points, 0);
    const elapsed = Math.max(0, now - from);
    return (this.priorRate * this.priorMs + points) / (this.priorMs + elapsed);
  }
}

/**
 * A first guess at the earning rate, before any delivery: one parcel of
 * average reward for a trip as long as the map is wide and high together.
 *
 * No agent can earn faster than parcels appear, so the guess is never more
 * than one average parcel per generation interval. On a small map the trip
 * alone would suggest a rate twice what is possible, and the agent would
 * then think its time worth more than it is and skip parcels worth taking.
 * @param {{ rewardAvg: number, width: number, height: number, moveMs: number, generationMs?: number }} game
 *   `generationMs` is how often a parcel appears, Infinity or left out when
 *   that is not known
 */
export function priorEarningRate({ rewardAvg, width, height, moveMs, generationMs = Infinity }) {
  const tripMs = Math.max(1, (width + height) * moveMs);
  const reward = Math.max(0, rewardAvg);
  return Math.min(reward / tripMs, Number.isFinite(generationMs) && generationMs > 0 ? reward / generationMs : Infinity);
}
