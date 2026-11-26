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
