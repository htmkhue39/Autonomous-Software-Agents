
/** The external course planner; import on demand so pure-unit tests work offline.
 * @param {string} domain
 * @param {string} problem
 */
export async function courseSolver(domain, problem) {
  const { onlineSolver } = await import('@unitn-asa/pddl-client');
  return onlineSolver(domain, problem);
}
