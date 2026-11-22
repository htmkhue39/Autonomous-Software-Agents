// @ts-nocheck -- test fixtures use partial fake SDK clients; runtime assertions verify behavior.
import { Beliefs } from '../src/beliefs/index.js';
import { tilesFromRows } from './helpers.js';
import { ActionGate } from '../src/plans/action-gate.js';
import { MovementRunner } from '../src/plans/moveTo.js';
import { PlanLibrary } from '../src/plans/library.js';
import { DIRS } from '../src/beliefs/map.js';

/** Small deterministic simulator for integration tests; not the official game. */
export function stage1World({ rows = ['2133'], x = 3, capacity = 2, mode = 'astar', solve, log = () => {} } = {}) {
  const beliefs = new Beliefs({ now: () => 0, agentTtlMs: 3000, blockedTtlMs: 10, maxBlockedMs: 100 });
  beliefs.onConfig({ CLOCK: 50, PENALTY: 1, AGENT_TIMEOUT: 10000, GAME: {
    title: 'test', description: '',
    parcels: { generation_event: '1s', decaying_event: 'infinite', max: 20, reward_avg: 20, reward_variance: 2 },
    player: { movement_duration: 20, observation_distance: 10, capacity },
  } });
  beliefs.onMap(0, 0, tilesFromRows(rows));
  beliefs.onYou({ id: 'me', name: 'me', x, y: 0, score: 0 });
  const events = [];
  const send = (parcels, positions = []) => beliefs.onSensing({ positions, agents: [], parcels, crates: [] });
  const initial = [{ id: 'p', x: 1, y: 0, reward: 20, carriedBy: null }];
  send(initial);
  let rejectMove = null;
  const client = {
    async move(dir) {
      events.push({ action: 'move', dir });
      if (rejectMove && rejectMove(dir)) return false;
      const me = beliefs.me;
      return { x: me.x + DIRS[dir].dx, y: me.y + DIRS[dir].dy };
    },
    async pickup() {
      events.push({ action: 'pickup' });
      return beliefs.parcels.free(beliefs.now()).filter(p => p.x === beliefs.me.x && p.y === beliefs.me.y).map(p => ({ id: p.id }));
    },
    async putdown() {
      events.push({ action: 'putdown' });
      return beliefs.parcels.carriedBy('me', beliefs.now()).map(p => ({ id: p.id }));
    },
  };
  const gate = new ActionGate({ timeoutMs: 1000 });
  const movement = new MovementRunner({ beliefs, client, gate, mode, solve, pddlTimeoutMs: 200, maxMoveRetries: 1, log });
  const plans = new PlanLibrary({ beliefs, client, gate, movement, log });
  return { beliefs, client, gate, movement, plans, send, events, setRejectMove(fn) { rejectMove = fn; } };
}
