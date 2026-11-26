// @ts-nocheck -- a fake planning.domains server answers the course's solver client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DOMAIN } from '../src/planning/pddl/domain.js';

// The client reads PAAS_HOST once, when it is first imported, so this file
// sets it before importing the solver. node --test runs each file in its own
// process, so no other test sees this address.
test('courseSolver reaches the solver set by PAAS_HOST and returns the plan', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/package/dual-bfws-ffparser/solve') {
        res.end(JSON.stringify({ result: '/check/1' }));
      } else if (req.method === 'GET' && req.url === '/check/1') {
        res.end(JSON.stringify({ status: 'ok', result: { stdout: 'search\n --- OK.\n', call: 'dual-bfws-ffparser domain problem',
          output: { plan: '(move-left t1_0 t0_0)\n; cost = 1 (unit cost)' } } }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.PAAS_HOST = `http://127.0.0.1:${port}`;
  // The client prints its progress; keep the test output clean.
  const quiet = console.log;
  console.log = () => {};
  try {
    const { courseSolver } = await import('../src/planning/pddl/solve.js');
    const plan = await courseSolver(DOMAIN, '(define (problem p) (:domain deliveroo))');
    assert.deepEqual(plan, [{ parallel: false, action: 'move-left', args: ['t1_0', 't0_0'] }]);
    const posted = JSON.parse(requests[0].body);
    assert.equal(posted.domain, DOMAIN);
  } finally {
    console.log = quiet;
    server.close();
  }
});
