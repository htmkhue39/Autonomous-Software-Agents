/**
 * How many points every parcel loses between the game times `fromMs` and
 * `toMs`. The server takes one point off every parcel at the same moment,
 * each time its game clock passes a whole multiple of the decay interval
 * (deliveroo-server backend/src/core/Clock.js and Grid.js). So the loss is
 * the number of those moments in between, not the length of the wait divided
 * by the interval: a short wait just before a tick still costs a point.
 * Timing that makes no sense is an error rather than a silent NaN.
 * @param {number} fromMs
 * @param {number} toMs
 * @param {number} decayMs  milliseconds per point of decay (`Infinity` for none)
 */
export function decayTicks(fromMs, toMs, decayMs) {
  if (decayMs === Infinity) return 0;
  if (!Number.isFinite(decayMs) || decayMs <= 0 || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new RangeError('Invalid decay timing');
  }
  if (toMs <= fromMs) return 0;
  return Math.max(0, Math.floor(toMs / decayMs) - Math.floor(fromMs / decayMs));
}

/**
 * What the parcels are worth when delivered `durationMs` after the game time
 * `startMs`. Every parcel loses a point at each decay tick in between, and
 * never goes below zero. The duration can hold more than the moves, such as
 * action time or measured delay, without changing how decay is counted.
 * @param {number[]} rewards  current values of the parcels involved
 * @param {number} durationMs
 * @param {number} decayMs    milliseconds per point of decay (`Infinity` for none)
 * @param {number} [startMs]  the game time at which the trip starts
 */
export function expectedRewardAtTime(rewards, durationMs, decayMs, startMs = 0) {
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError('Invalid trip duration');
  const lost = decayTicks(startMs, startMs + durationMs, decayMs);
  return rewards.reduce((sum, reward) => sum + Math.max(0, reward - lost), 0);
}

/**
 * What a trip of `moves` moves is worth: see expectedRewardAtTime.
 * @param {number[]} rewards  current values of the parcels involved
 * @param {number} moves      length of the whole trip
 * @param {{ moveMs: number, decayMs: number }} timing
 *   milliseconds per move, and per point of decay (`Infinity` for none)
 * @param {number} [startMs]  the game time at which the trip starts
 */
export function expectedReward(rewards, moves, { moveMs, decayMs }, startMs = 0) {
  return expectedRewardAtTime(rewards, moves * moveMs, decayMs, startMs);
}
