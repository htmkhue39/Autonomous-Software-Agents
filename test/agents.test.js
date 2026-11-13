import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentBeliefs } from '../src/beliefs/agents.js';

/**
 * @param {string} id
 * @param {number} x
 * @param {number} y
 * @returns {import('../src/types.js').AgentState}
 */
function agent(id, x, y) {
  return { id, name: id, x, y, score: 0 };
}

test('transitional agents reserve both endpoint tiles', () => {
  const agents = new AgentBeliefs(3000);
  agents.update([agent('a', 2, 3), agent('b', 4.6, 1.4)], 0);
  assert.deepEqual([...agents.occupied(0)].sort(), ['2,3', '4,1', '4,2', '5,1', '5,2']);
  assert.deepEqual(agents.get('b'), { id: 'b', name: 'b', x: 5, y: 1, rawX: 4.6, rawY: 1.4, seenAt: 0 });
});

test('only recently seen agents block tiles', () => {
  const agents = new AgentBeliefs(3000);
  agents.update([agent('old', 0, 0)], 0);
  agents.update([agent('new', 1, 1)], 2000);
  assert.deepEqual([...agents.occupied(3000)].sort(), ['0,0', '1,1']);
  assert.deepEqual([...agents.occupied(3001)], ['1,1']);
});

test('an agent seen again moves to its new tile', () => {
  const agents = new AgentBeliefs(3000);
  agents.update([agent('a', 0, 0)], 0);
  agents.update([agent('a', 1, 0)], 500);
  assert.deepEqual([...agents.occupied(500)], ['1,0']);
});
