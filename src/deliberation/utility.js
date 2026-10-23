/**
 * What a trip is worth: the reward left when the parcels are delivered at
 * its end. Every parcel loses a point for each whole decay interval the trip
 * takes, and never goes below zero.
 * @param {number[]} rewards  current values of the parcels involved
 * @param {number} moves      length of the whole trip
 * @param {{ moveMs: number, decayMs: number }} timing
 *   milliseconds per move, and per point of decay (`Infinity` for none)
 */
export function expectedReward(rewards, moves, { moveMs, decayMs }) {
  const lost = Math.floor((moves * moveMs) / decayMs);
  return rewards.reduce((sum, reward) => sum + Math.max(0, reward - lost), 0);
}
