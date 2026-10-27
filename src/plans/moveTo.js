/**
 * @typedef {import('../beliefs/index.js').Beliefs} Beliefs
 * @typedef {import('../types.js').Client} Client
 * @typedef {import('../types.js').Direction} Direction
 * @typedef {import('../types.js').Position} Position
 * @typedef {import('../types.js').StopSignal} StopSignal
 */

/**
 * Finds a route from `from` to the nearest of `targets`: A* or PDDL.
 * @typedef {(beliefs: Beliefs, from: Position, targets: Position[]) => { target: Position, path: Direction[] } | null} RoutePlanner
 */

/**
 * What plans work with.
 * @typedef {Object} PlanContext
 * @property {Beliefs} beliefs
 * @property {Pick<Client, 'move' | 'pickup' | 'putdown'>} client
 * @property {RoutePlanner} planRoute
 * @property {number} maxFailures  failed moves after which a walk gives up
 */

/**
 * Walk to the nearest of `targets` one step at a time (design.md section 4).
 * Before every step: stop if told to, act on the spot, plan a fresh route
 * and take only its first move. A failed or unanswered move is remembered
 * in the map and the next route goes around it.
 * @param {PlanContext} ctx
 * @param {Position[]} targets
 * @param {StopSignal} signal
 * @returns {Promise<boolean>} true on arrival; false when stopped, with no
 *   route, or after `maxFailures` failed moves
 */
export async function moveTo(ctx, targets, signal) {
  const { beliefs, client, planRoute, maxFailures } = ctx;
  let failures = 0;
  while (!signal.stopped) {
    await actOnTheSpot(ctx);
    const me = beliefs.me;
    const map = beliefs.map;
    if (!me || !map) return false;
    const route = planRoute(beliefs, me, targets);
    if (!route) return false;
    if (route.path.length === 0) return true;

    const dir = route.path[0];
    const moved = await client.move(dir);
    if (moved) {
      map.moveSucceeded(me.x, me.y, dir);
      if (beliefs.me) beliefs.onYou({ ...beliefs.me, x: moved.x, y: moved.y });
    } else {
      map.failMove(me.x, me.y, dir, beliefs.now());
      if (++failures >= maxFailures) return false;
    }
  }
  return false;
}

/**
 * Pick up free parcels on the agent's tile while it has room, and put
 * everything down on a delivery tile, whatever the walk is for.
 * @param {PlanContext} ctx
 */
async function actOnTheSpot({ beliefs, client }) {
  const { config, map, me } = beliefs;
  if (!config || !map || !me) return;
  const now = beliefs.now();
  const carried = beliefs.parcels.carriedBy(me.id, now);

  if (carried.length > 0 && map.typeAt(me.x, me.y) === '2') {
    beliefs.onPutdown(await client.putdown());
    return;
  }

  const here = beliefs.parcels.free(now).filter(p => Math.round(p.x) === me.x && Math.round(p.y) === me.y);
  if (here.length === 0 || carried.length >= config.GAME.player.capacity) return;
  beliefs.onPickup(await client.pickup());
}
