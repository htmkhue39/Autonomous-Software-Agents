import { ActionGate } from '../../plans/action-gate.js';
import { MovementRunner } from '../../plans/moveTo.js';
import { PlanLibrary } from '../../plans/library.js';
import { WorkingMemory } from '../memory.js';
import { PlanActLoop } from '../agent.js';
import { gameObservation } from './observations.js';
import { GameProgress, parseGameObjective } from './objectives.js';
import { createGameTools } from './tools.js';

/**
 * Assemble an independent LLM game actor. This deliberately does not import
 * BdiAgent or modify any BDI intention policy. Each player owns a client,
 * beliefs, gate and movement executor; only pure implementations are shared.
 *
 * @param {{
 * beliefs:import('../../beliefs/index.js').Beliefs,
 * client:import('../../types.js').Client,
 * provider:import('../agent.js').LlmProvider,
 * mode?:'native'|'json', mover?:'astar'|'pddl',
 * maxSteps?:number,maxToolCalls?:number,toolTimeoutMs?:number,
 * actionTimeoutMs?:number,maxMoveRetries?:number,pddlTimeoutMs?:number,
 * congestionTimeoutMs?:number,congestionRetryMs?:number,
 * coordination?:import('../../coordination/controller.js').CoordinationController|null,
 * deliveryEvacuation?:boolean,
 * log?:(name:string,details:object)=>void
 * }} setup
 */
export function createGameRuntime({ beliefs, client, provider, mode = 'native', mover = 'astar',
  maxSteps = 18, maxToolCalls = 20, toolTimeoutMs = 60_000, actionTimeoutMs = 8000,
  maxMoveRetries = 3, pddlTimeoutMs = 5000, congestionTimeoutMs = 3500, congestionRetryMs = 180,
  coordination = null, deliveryEvacuation = false, log = () => {} }) {
  const progress = new GameProgress(beliefs);
  const write = (/** @type {string} */ event, /** @type {object} */ details) => {
    progress.record(event, details);
    log(event, details);
  };
  const gate = new ActionGate({ timeoutMs: actionTimeoutMs });
  const movement = new MovementRunner({ beliefs, client, gate, mode: mover, pddlTimeoutMs, maxMoveRetries,
    congestionTimeoutMs, congestionRetryMs, log: write });
  const plans = new PlanLibrary({ beliefs, client, gate, movement, log: write });
  const memory = new WorkingMemory({ maxEvents: 14, maxTextLength: 5500, observationTtlMs: 30_000 });
  const cooldowns = new Map();
  /** @type {ReturnType<typeof parseGameObjective>} */
  let criterion = { kind: 'unsupported', target: 0, description: 'None' };
  const objectiveStatus = () => progress.status(criterion);
  const tools = createGameTools({ beliefs, plans, progress, objectiveStatus, coordination, log: write, cooldowns, deliveryEvacuation });
  const observation = () => gameObservation(beliefs, { coordination, cooldowns,
    objectiveProgress: objectiveStatus() });
  const loop = new PlanActLoop({ provider, memory, tools, mode, maxSteps, maxToolCalls, toolTimeoutMs,
    log: write, observe: observation,
    autoVerifyCompletion: true,
    verifyCompletion: () => progress.verify(criterion),
  });

  /** @param {string} objective @param {{signal?:AbortSignal}} [options] */
  async function runObjective(objective, { signal } = {}) {
    if (!beliefs.ready) throw new Error('Cannot run objective until the game is ready');
    // Reconnected players may already have a score. Set the baseline only
    // when the actual objective begins, not when the process starts.
    progress.startScore = beliefs.me?.score ?? 0;
    progress.deliveredCount = 0;
    progress.deliveryActions = 0;
    criterion = parseGameObjective(objective);
    write('game_objective', { objective, criterion, baseline: progress.snapshot() });
    if (criterion.kind === 'unsupported') {
      return { status: 'blocked', reason: 'unsupported_local_completion_criterion', summary: criterion.description,
        metrics: null, progress: progress.snapshot() };
    }
    const result = await loop.run(objective, { observation: observation(), signal });
    const report = { status: result.status, reason: result.reason, summary: result.summary,
      metrics: result.metrics, progress: progress.snapshot() };
    write('game_objective_result', report);
    return report;
  }
  return { runObjective, stop: () => loop.stop(), progress, beliefs, memory, tools, loop, gate, movement, plans };
}

/** Wait for SDK config/map/self events, with abort and deadline. */
/** @param {import('../../beliefs/index.js').Beliefs} beliefs
 * @param {{timeoutMs?:number,signal?:AbortSignal}} [options]
 */
export async function waitForGameReady(beliefs, { timeoutMs = 20_000, signal } = {}) {
  if (beliefs.ready && beliefs.positionStable) return;
  if (signal?.aborted) throw new Error('Game startup cancelled');
  return new Promise((resolve, reject) => {
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
    const cleanup = () => { unsubscribe(); if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const succeed = () => { cleanup(); resolve(undefined); };
    const fail = (/** @type {string} */ text) => { cleanup(); reject(new Error(text)); };
    const onAbort = () => fail('Game startup cancelled');
    const unsubscribe = beliefs.onChange(() => {
      if (beliefs.ready && beliefs.positionStable) succeed();
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => fail(`No full SDK map/config/self observation within ${timeoutMs} ms`), timeoutMs);
    if (beliefs.ready && beliefs.positionStable) succeed();
  });
}
