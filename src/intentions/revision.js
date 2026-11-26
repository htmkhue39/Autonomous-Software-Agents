/** Keep current intention unless impossible or another goal is substantially
 * better. An exploration option (utility=0) always yields to a useful pickup.
 *
 * "Substantially better" has two forms. By default the other goal must be
 * worth more than `margin` times the current one. With `minGain` set, it must
 * instead be worth at least `minGain` points more. All utilities are the
 * reward expected once everything is delivered, counted from where the agent
 * stands now, so their difference is exactly what switching would earn.
 *
 * With `minGain` set there is one exception, which protects the parcels the
 * agent carries: going from a pickup to delivering needs only more than
 * `deliveryProtection` points (default 0). Once a detour has become worse
 * than delivering, the agent stops it at once instead of waiting for the full
 * `minGain`. Going back from delivering to a pickup still needs `minGain`, so
 * the two cannot alternate on a tiny difference.
 * @param {import('../types.js').Option | null} current
 * @param {import('../types.js').Option[]} options  best first
 * @param {number} margin
 * @param {{ minGain?: number, deliveryProtection?: number }} [rule]
 */
export function reconsider(current, options, margin = 1.2, { minGain, deliveryProtection = 0 } = {}) {
  const best = options[0] ?? null;
  if (!current) return { next: best, reason: 'selected' };
  const stillValid = options.find(option => option.id === current.id);
  if (!stillValid) return { next: best, reason: 'invalidated' };
  if (!best || best.id === current.id) return { next: stillValid, reason: 'continued' };
  // A higher priority always wins, such as delivering on the tile the agent
  // stands on; a lower one never does.
  if (best.priority > stillValid.priority) return { next: best, reason: 'replaced' };
  if (best.priority < stillValid.priority) return { next: stillValid, reason: 'continued' };
  if (minGain !== undefined) {
    // Utilities may be below zero under this rule, so only the gain counts.
    const gain = best.utility - stillValid.utility;
    if (current.type === 'pickup' && best.type === 'deliver' && gain > deliveryProtection) {
      return { next: best, reason: 'delivery_protection' };
    }
    return gain >= minGain ? { next: best, reason: 'replaced' } : { next: stillValid, reason: 'continued' };
  }
  const better = best.utility > stillValid.utility * margin;
  return best.utility > 0 && (stillValid.utility <= 0 || better)
    ? { next: best, reason: 'replaced' } : { next: stillValid, reason: 'continued' };
}

/**
 * After its pickup, a trip is a delivery to its own tile: its parcel is no
 * longer free, so no pickup option stands for it any more, and it would
 * otherwise be weighed at the value it had when it started and lose to the
 * very delivery it is about to make.
 *
 * When the options hold the delivery to the trip's tile, the trip takes that
 * option's place and value. When they hold the delivery to another tile only
 * (the one listed is the best from here, and the trip's own tile may be
 * cooling down or just tied with it), the trip is added at that delivery's
 * value, so that it is replaced only for a real gain.
 * @param {import('../types.js').Option} active
 * @param {import('../types.js').Option[]} options
 * @param {boolean} carried  whether the agent carries the trip's parcel
 * @returns {import('../types.js').Option[]}
 */
export function tripAsDelivery(active, options, carried) {
  if (!carried || active.type !== 'pickup' || active.deliverX === undefined || active.deliverY === undefined) return options;
  const own = `deliver:${active.deliverX},${active.deliverY}`;
  if (options.some(o => o.id === own)) {
    return options.map(o => o.id === own ? { ...active, utility: o.utility, priority: o.priority } : o);
  }
  const delivery = options.find(o => o.type === 'deliver');
  return delivery ? [...options, { ...active, utility: delivery.utility, priority: 0 }] : options;
}
