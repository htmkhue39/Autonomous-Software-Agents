import { buildNavigationProblem, decodeNavigationPlan } from './problem.js';

/** The external course planner; import on demand so pure-unit tests work offline.
 * @param {string} domain
 * @param {string} problem
 */
export async function courseSolver(domain, problem) {
  const { onlineSolver } = await import('@unitn-asa/pddl-client');
  return onlineSolver(domain, problem);
}

/**
 * @param {import('../../beliefs/map.js').GridMap} map
 * @param {import('../../types.js').Position} from
 * @param {import('../../types.js').Position} to
 * @param {import('../../types.js').PathOptions} options
 * @param {{ solve?: typeof courseSolver, timeoutMs?: number, log?: (event:string, details:object)=>void }} [settings]
 */
export async function solveNavigation(map, from, to, options, { solve = courseSolver, timeoutMs = 5000, log = () => {} } = {}) {
  if (from.x === to.x && from.y === to.y) return [];
  const spec = buildNavigationProblem(map, from, to, options);
  if (!spec) throw new Error('PDDL problem has no valid start/goal');
  const began = Date.now();
  log('pddl_call', { from, to });
  let timer;
  try {
    const plan = await Promise.race([
      Promise.resolve().then(() => solve(spec.domain, spec.problem)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('External solver timeout')), timeoutMs); }),
    ]);
    const moves = decodeNavigationPlan(plan, map, from, to, options);
    log('pddl_success', { from, to, moves: moves.length, durationMs: Date.now() - began });
    return moves;
  } catch (error) {
    log('pddl_failure', { from, to, reason: String(error instanceof Error ? error.message : error), durationMs: Date.now() - began });
    throw error;
  } finally { clearTimeout(timer); }
}
