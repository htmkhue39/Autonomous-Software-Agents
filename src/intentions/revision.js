/** Keep current intention unless impossible or another goal is substantially
 * better. An exploration option (utility=0) always yields to a useful pickup.
 * @param {import('../types.js').Option | null} current
 * @param {import('../types.js').Option[]} options
 * @param {number} margin
 */
export function reconsider(current, options, margin = 1.2) {
  const best = options[0] ?? null;
  if (!current) return { next: best, reason: 'selected' };
  const stillValid = options.find(option => option.id === current.id);
  if (!stillValid) return { next: best, reason: 'invalidated' };
  if (!best || best.id === current.id) return { next: stillValid, reason: 'continued' };
  if (best.priority > stillValid.priority ||
      (best.priority === stillValid.priority && best.utility > 0 &&
       (stillValid.utility <= 0 || best.utility > stillValid.utility * margin))) {
    return { next: best, reason: 'replaced' };
  }
  return { next: stillValid, reason: 'continued' };
}
