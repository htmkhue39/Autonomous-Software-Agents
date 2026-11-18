/**
 * Stage 3C.3: balanced C0/C1 ablation design and independent-sample analysis.
 * The scheduling seed controls ORDER ONLY. It does not seed Deliveroo.js or
 * couple the random game worlds between control/treatment trials.
 */
import { randomInt, createHash } from 'node:crypto';
import { describeSamples, studentT95, asCsv } from './results.js';

export const CONDITIONS = Object.freeze({
  C0: { label: 'evacuation_off', evacuationEnabled: false },
  C1: { label: 'evacuation_on', evacuationEnabled: true },
});

/** @param {number} [seed] */
export function schedulingSeed(seed) {
  return seed === undefined ? randomInt(0, 2 ** 32) : seed;
}

/**
 * For each block, run one control and one treatment in a reproducibly
 * randomized order. Blocks are NOT paired worlds unless game seeding is proven.
 * @param {number} runs Number of trials PER condition
 * @param {number} seed Unsigned 32-bit integer scheduling seed
 */
export function scheduleAblation(runs, seed) {
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100 ||
      !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('Ablation requires runs 1..100 and a uint32 scheduling seed');
  }
  // Half the blocks start with C0 and half start with C1 (when runs is even).
  // Shuffle this balanced orientation sequence deterministically. A block
  // always contains exactly one trial from each condition.
  /** @type {string[]} */ const firsts = Array.from({ length:runs }, (_, i) => i % 2 ? 'C1' : 'C0');
  for (let i=firsts.length-1;i>0;i--) {
    const digest = createHash('sha256').update(`stage3c3-order:${seed}:${i}`).digest();
    const j = digest.readUInt32BE(0) % (i+1);
    [firsts[i],firsts[j]] = [firsts[j],firsts[i]];
  }
  /** @type {Array<{mode:string,trial:number,ordinal:number,block:number,condition:string,evacuationEnabled:boolean}>} */
  const rounds = [];
  for (let block = 1; block <= runs; block++) {
    const order = firsts[block-1] === 'C0' ? ['C0','C1'] : ['C1','C0'];
    for (const condition of order) {
      rounds.push({ mode:'C', trial:block, block, ordinal:rounds.length + 1,
        condition, evacuationEnabled: CONDITIONS[/** @type {keyof typeof CONDITIONS} */ (condition)].evacuationEnabled });
    }
  }
  return rounds;
}

/** Validate the effective config from the ACTUAL agent startup log, not env assumptions.
 * @param {any} summary
 * @param {{condition?:string,block?:number,evacuationEnabled?:boolean}} scheduled
 * @param {number} seed */
export function validateAblationTrial(summary, scheduled, seed) {
  const effective = summary.llmDeliveryEvacuationEnabled;
  Object.assign(summary, {condition:scheduled.condition, block:scheduled.block,
    schedulingSeed:seed, expectedEvacuationEnabled:scheduled.evacuationEnabled});
  if (effective !== scheduled.evacuationEnabled) {
    summary.issues.push('evacuation_setting_mismatch');
    summary.valid = false;
  }
  return summary;
}

/** @param {number[]} a @param {number[]} b */
export function compareIndependentSamples(a, b) {
  const baseline = describeSamples(a);
  const treatment = describeSamples(b);
  if (!baseline.n || !treatment.n) return {
    baseline, treatment, difference:null, relativePercent:null, ci95:null,
    hedgesG:null, probabilitySuperiority:null, method:'unpaired_welch_95',
  };
  const difference = (treatment.mean ?? 0) - (baseline.mean ?? 0);
  const relativePercent = baseline.mean === 0 ? null : difference / (baseline.mean ?? 1) * 100;
  let ci95 = null;
  let hedgesG = null;
  if (baseline.n >= 2 && treatment.n >= 2) {
    const va = (baseline.sampleStdev ?? 0) ** 2 / baseline.n;
    const vb = (treatment.sampleStdev ?? 0) ** 2 / treatment.n;
    const se = Math.sqrt(va + vb);
    const df = se === 0 ? Infinity : (va + vb) ** 2 /
      (va ** 2 / (baseline.n - 1) + vb ** 2 / (treatment.n - 1));
    const width = se === 0 ? 0 : studentT95(df) * se;
    ci95 = [difference - width, difference + width];
    const pooled = Math.sqrt(((baseline.n - 1) * (baseline.sampleStdev ?? 0) ** 2 +
      (treatment.n - 1) * (treatment.sampleStdev ?? 0) ** 2) / (baseline.n + treatment.n - 2));
    if (pooled > 0) hedgesG = (difference / pooled) *
      (1 - 3 / (4 * (baseline.n + treatment.n) - 9));
  }
  // Descriptive probability of superiority, not a hypothesis-test p-value.
  const better = b.reduce((total, y) => total + a.reduce((score, x) =>
    score + (y > x ? 1 : y === x ? 0.5 : 0), 0), 0);
  const probabilitySuperiority = better / (a.length * b.length);
  return { baseline, treatment, difference, relativePercent, ci95, hedgesG,
    probabilitySuperiority, method:'unpaired_welch_95' };
}

const METRICS = Object.freeze([
  ['teamObservedScore', 'Team score (agent-observed)'],
  ['totalDeliveredParcels', 'Delivered parcels'],
  ['bubbleObservedScore', 'BDI observed score'],
  ['milkteaObservedScore', 'LLM observed score'],
  ['bdiTeammateCongestionFailures', 'Teammate congestion failures'],
  ['llmDeliveryTileDwellMeanMs', 'Delivery tile dwell (per-trial mean, ms)'],
  ['llmDeliveryEvacuationSuccesses', 'Successful evacuations'],
  ['llmModelLatencyMeanMs', 'LLM mean model latency (per-trial ms)'],
]);

/** @param {any[]} rounds */
export function analyzeAblation(rounds) {
  const groups = Object.fromEntries(Object.keys(CONDITIONS).map(condition => {
    const all = rounds.filter(r => r.condition === condition);
    const valid = all.filter(r => r.valid && Number.isFinite(r.teamObservedScore));
    /** @type {Record<string,number>} */ const issues = {};
    for (const r of all) for (const issue of r.issues ?? []) issues[issue] = (issues[issue] ?? 0) + 1;
    /** @type {Record<string,any>} */ const metrics = {};
    for (const [field] of METRICS) metrics[field] = describeSamples(valid.map(r => r[field]).filter(Number.isFinite));
    return [condition, {
      condition, label:CONDITIONS[/** @type {keyof typeof CONDITIONS} */ (condition)].label,
      attempted:all.length, valid:valid.length, invalid:all.length - valid.length,
      issues, metrics,
      tileDwellCensored: valid.reduce((sum, r) => sum + (r.llmDeliveryTileDwellCensored ?? 0), 0),
      evacuationAttempts:valid.reduce((sum,r) => sum + (r.llmDeliveryEvacuationAttempts ?? 0),0),
      evacuationSuccesses:valid.reduce((sum,r) => sum + (r.llmDeliveryEvacuationSuccesses ?? 0),0),
    }];
  }));
  /** @type {Record<string,any>} */ const comparisons = {};
  for (const [field] of METRICS) {
    const xs = rounds.filter(r=>r.condition==='C0' && r.valid && Number.isFinite(r.teamObservedScore) && Number.isFinite(r[field])).map(r=>r[field]);
    const ys = rounds.filter(r=>r.condition==='C1' && r.valid && Number.isFinite(r.teamObservedScore) && Number.isFinite(r[field])).map(r=>r[field]);
    comparisons[field] = compareIndependentSamples(xs, ys);
  }
  return {
    method:'independent_samples_unpaired_welch_95',
    design:'balanced_randomized_order_not_matched_game_worlds',
    scoreSource:'last_agent_observed_not_tournament',
    gameRandomSeedControlled:false,
    groups, comparisons,
  };
}

/** Add condition metadata without changing Stage 3A CSV columns. @param {any[]} rounds */
export function asAblationCsv(rounds) {
  const original = asCsv(rounds).trimEnd().split('\n');
  const lines = [ `condition,block,schedulingSeed,${original[0]}` ];
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    lines.push(`${r.condition ?? ''},${r.block ?? ''},${r.schedulingSeed ?? ''},${original[i+1]}`);
  }
  return lines.join('\n') + '\n';
}

/** @param {number|null|undefined} x @param {number} [digits] */
function fmt(x, digits = 1) { return typeof x==='number' && Number.isFinite(x) ? x.toFixed(digits) : 'N/A'; }

/** Presentation-ready SVG: all valid trial scores and mean/95% CI by condition.
 * The generator deliberately does not hide unusual outcomes or invalid trials;
 * invalid trials are counted separately in the report and excluded here.
 * @param {any[]} rounds */
export function ablationScoreSvg(rounds) {
  const groups = ['C0','C1'].map(condition=>rounds.filter(r=>r.condition===condition && r.valid && Number.isFinite(r.teamObservedScore))
    .map(r=>r.teamObservedScore));
  const values=groups.flat();
  const max=Math.max(1,...values)*1.1;
  const width=750, height=310, left=95, right=40, axisWidth=width-left-right;
  const x=(/** @type {number} */ v)=>left+(v/max)*axisWidth;
  const escape=(/** @type {number} */ v)=>Number(v).toFixed(2);
  let content=`<rect width="${width}" height="${height}" fill="#fff"/>`+
    `<text x="${left}" y="28" font-size="18" font-weight="600" fill="#172135">Observed team score by evacuation condition</text>`+
    `<text x="${left}" y="48" font-size="12" fill="#59677b">Each dot = a valid fixed-duration trial; bar = 95% CI for the group mean</text>`;
  for (let g=0;g<2;g++) {
    const y=108+g*95, condition=g===0?'C0 (OFF)':'C1 (ON)';
    content+=`<text x="${left-12}" y="${y+5}" font-size="14" text-anchor="end" fill="#172135">${condition}</text>`;
    const stats=describeSamples(groups[g]);
    for(let i=0;i<groups[g].length;i++) {
      const v=groups[g][i], jitter=((i*7)%5-2)*6;
      content+=`<circle cx="${escape(x(v))}" cy="${y+jitter}" r="5" fill="${g===0?'#667b9a':'#008775'}" fill-opacity=".72"/>`;
    }
    if(stats.mean!==null){
      if(stats.ci95){
        content+=`<line x1="${escape(x(Math.max(0,stats.ci95[0])))}" x2="${escape(x(stats.ci95[1]))}" y1="${y+28}" y2="${y+28}" stroke="#152338" stroke-width="4" stroke-linecap="round"/>`;
      }
      content+=`<rect x="${escape(x(stats.mean)-5)}" y="${y+23}" width="10" height="10" fill="#152338"/>`;
      content+=`<text x="${escape(x(stats.mean)+9)}" y="${y+39}" font-size="11" fill="#152338">mean ${escape(stats.mean)}</text>`;
    }
  }
  const yAxis=274;
  content+=`<line x1="${left}" y1="${yAxis}" x2="${width-right}" y2="${yAxis}" stroke="#a8afbd" stroke-width="1"/>`;
  for(let i=0;i<=5;i++){
    const val=max*i/5,xx=x(val);
    content+=`<line x1="${escape(xx)}" y1="${yAxis}" x2="${escape(xx)}" y2="${yAxis+5}" stroke="#a8afbd"/>`+
    `<text x="${escape(xx)}" y="${yAxis+22}" text-anchor="middle" font-size="11" fill="#59677b">${Math.round(val)}</text>`;
  }
  content+=`<text x="${width-right}" y="${height-5}" text-anchor="end" font-size="10" fill="#59677b">Agent-observed, NOT Tournament; game seeds uncontrolled</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="C0 versus C1 observed scores">${content}</svg>\n`;
}

/** @param {any} analysis @param {any} manifest */
export function ablationMarkdown(analysis, manifest) {
  const { groups, comparisons } = analysis;
  const d = comparisons.teamObservedScore;
  const df = (/** @type {string} */ field) => {
    const x = comparisons[field];
    return `| ${METRICS.find(m=>m[0]===field)?.[1] ?? field} | ${fmt(x.baseline.mean)} | ${fmt(x.treatment.mean)} | ${fmt(x.difference)} |`;
  };
  const invalid = Object.values(groups).flatMap((/** @type {any} */ g)=>Object.entries(g.issues).map(([why,n])=>`${g.condition}: ${why} (${n})`));
  return `# Stage 3C.3 — Delivery-tile evacuation ablation\n\n`+
    `Generated: ${new Date().toISOString()}\n\n`+
    `## Method\n\n`+
    `- **Control C0:** cooperative agents, evacuation disabled. **Treatment C1:** identical agents, evacuation enabled.\n`+
    `- Trials per condition: ${manifest.config.runs}; fixed duration: ${manifest.config.durationSec}s; map: \`${manifest.config.game}\`; BDI mover: \`${manifest.config.mover}\`.\n`+
    `- Balanced within-block execution order; recorded scheduling seed: **${manifest.config.ablationSchedulingSeed}**. This seed controls the **trial order only**.\n`+
    `- Game-server RNG: **NOT controlled or verified**. C0 and C1 trials do **not** share identical game states. Analyses are **unpaired**.\n`+
    `- Model: \`${manifest.config.llmModel}\`; LLM mode: \`json\`; scores are **agent-observed, NOT official Tournament scores**.\n`+
    `- Revisions: agents \`${manifest.config.revision.agent ?? 'unavailable'}\`, Deliveroo.js \`${manifest.config.revision.server ?? 'unavailable'}\`.\n\n`+
    `## Data completeness\n\n`+
    `| Condition | Attempted | Valid | Invalid | Censored tile-dwell intervals | Evacuations (successful/attempted) |\n`+
    `|---|---:|---:|---:|---:|---:|\n`+
    Object.values(groups).map((/** @type {any} */ g) =>
      `| ${g.condition} | ${g.attempted} | ${g.valid} | ${g.invalid} | ${g.tileDwellCensored} | ${g.evacuationSuccesses}/${g.evacuationAttempts} |\n`).join('') +
    `\nInvalid-trial reasons: ${invalid.length ? invalid.join('; ') : 'none recorded'}. Invalid trials are retained but excluded from score comparisons.\n\n`+
    `## Descriptive results (valid trials only)\n\n![Observed score distribution](score-distribution.svg)\n\n`+
    `| Metric | C0 mean | C1 mean | C1 − C0 |\n|---|---:|---:|---:|\n`+
    METRICS.map(([field])=>df(field)).join('\n') + '\n\n' +
    `**Primary score contrast:** ${fmt(d.difference)} points (${fmt(d.relativePercent)}% relative to C0).\n\n`+
    `**Unpaired Welch 95% CI:** ${d.ci95 ? `[${fmt(d.ci95[0])}, ${fmt(d.ci95[1])}]` : 'not estimable (insufficient valid trials)'}. `+
    `Hedges g: ${fmt(d.hedgesG,2)}. Descriptive probability of superiority: ${fmt(d.probabilitySuperiority,3)}.\n\n`+
    `## Interpretation and limitations\n\n`+
    `A positive C1 − C0 difference favors evacuation in this sample; intervals crossing zero do not establish a reliable difference. `+
    `Scheduling-order randomization reduces temporal confounding but **does not** control game randomness, model stochasticity, or shared machine load. `+
    `Dwell means are averages of non-censored per-trial means; censored holds require separate consideration and are never treated as measured zero. `+
    `These tests establish local game performance only, not official Tournament scoring. `+
    `Changes in congestion are mechanistic evidence but do not alone prove a causal score gain.\n\n`+
    `## Reproducibility\n\n`+
    `The manifest stores the exact condition order, scheduling seed and sanitized settings. `+
    `Each trial directory contains server, BDI and LLM logs plus \`result.json\`. `+
    `No private tokens or full environment are copied into results.\n`;
}
