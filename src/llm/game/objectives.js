/**
 * Deterministic completion criteria for locally supported natural-language
 * objectives. The LLM interprets/acts on the text; this verifier prevents the
 * model from certifying its own unobserved success. Unsupported goals must not
 * be marked completed based on a persuasive summary alone.
 */

/** @typedef {{kind:'score_absolute'|'score_delta'|'deliver_count'|'unsupported',target:number,description:string}} ObjectiveCriterion */

/** @param {string} objective @returns {ObjectiveCriterion} */
export function parseGameObjective(objective) {
  const text = objective.trim().toLowerCase();
  const number = '(\\d{1,6})';
  const points = new RegExp(`\\b(?:at least|minimum|over|more than|>=)?\\s*${number}\\s*(?:(?:additional|more|new)\\s+)?(?:points?|score)\\b`);
  const score = points.exec(text);
  if (score && /\b(?:earn|gain|collect|accumulate)\b/.test(text) && /\b(?:additional|more|new)\b/.test(text)) {
    return { kind: 'score_delta', target: Number(score[1]), description: `Earn ${score[1]} additional points` };
  }
  if (score && /\b(?:score|points?|deliver|reach|earn|gain)\b/.test(text)) {
    return { kind: 'score_absolute', target: Number(score[1]), description: `Reach a game score of ${score[1]}` };
  }
  const delivered = /\b(?:deliver|delivered|drop\s*off)\s+(?:at\s+least\s+)?(\d{1,4})\s+parcels?\b/.exec(text);
  if (delivered) return { kind: 'deliver_count', target: Number(delivered[1]), description: `Deliver ${delivered[1]} parcels` };
  if (/\b(?:collect|pick\s*up|pickup|deliver)\b/.test(text) && /\bparcels?\b/.test(text)) {
    return { kind: 'deliver_count', target: 1, description: 'Deliver at least one parcel' };
  }
  return { kind: 'unsupported', target: 0, description: 'This objective needs a course-specific verifier' };
}

/** Concrete evidence kept outside the LLM's editable conversation. */
export class GameProgress {
  /** @param {import('../../beliefs/index.js').Beliefs} beliefs */
  constructor(beliefs) {
    this.beliefs = beliefs;
    this.startScore = beliefs.me?.score ?? 0;
    this.deliveredCount = 0;
    this.deliveryActions = 0;
  }

  /** @param {string} event @param {any} detail */
  record(event, detail) {
    if (event !== 'delivery' || !Array.isArray(detail.parcelIds) || !detail.parcelIds.length) return;
    this.deliveredCount += detail.parcelIds.length;
    this.deliveryActions++;
  }

  /** @param {ObjectiveCriterion} criterion */
  verify(criterion) {
    const score = this.beliefs.me?.score;
    if (criterion.kind === 'score_absolute') return score !== undefined && score >= criterion.target;
    if (criterion.kind === 'score_delta') return score !== undefined && score - this.startScore >= criterion.target;
    if (criterion.kind === 'deliver_count') return this.deliveredCount >= criterion.target;
    return false;
  }

  /**
   * Evidence-based progress for the LLM. Counts refer to deliveries already
   * confirmed for THIS objective, not parcels currently visible on the map.
   * Keep this separate from the model's conversation and its claimed success.
   * @param {ObjectiveCriterion} criterion
   */
  status(criterion) {
    const score = this.beliefs.me?.score;
    const current = criterion.kind === 'deliver_count' ? this.deliveredCount
      : criterion.kind === 'score_absolute' ? (score ?? null)
        : criterion.kind === 'score_delta' ? (score === undefined ? null : score - this.startScore)
          : null;
    return {
      kind: criterion.kind,
      description: criterion.description,
      target: criterion.target,
      current,
      remaining: current === null ? null : Math.max(0, criterion.target - current),
      verifiedComplete: this.verify(criterion),
      evidence: this.snapshot(),
    };
  }

  snapshot() { return { startScore: this.startScore, currentScore: this.beliefs.me?.score ?? null,
    deliveredCount: this.deliveredCount, deliveryActions: this.deliveryActions }; }
}
