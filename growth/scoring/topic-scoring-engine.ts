import { computeTotalScore, computeWeightedScore } from "../contracts/scored-topic";
import type { ScoredTopic } from "../contracts/scored-topic";
import type { Confidence, ScoringDimensionKey } from "../types/topic-scoring";

/**
 * Deterministic math only — no LLM involvement anywhere in this file. The
 * provider supplies per-dimension raw scores (growth/types/topic-scoring.ts's
 * `TopicScoringAnalysis`); everything here — weighting, totals, ranking,
 * confidence caps, and the final recommendation — is computed the same way
 * every time for the same input. See growth/scoring/README.md.
 */

export { computeWeightedScore, computeTotalScore };

// ---------------------------------------------------------------------------
// Deterministic ranking
// ---------------------------------------------------------------------------

function getDimensionScore(topic: ScoredTopic, key: ScoringDimensionKey): number {
  return topic.dimensions.find((dimension) => dimension.key === key)?.score ?? 0;
}

/**
 * Ranks by: (1) totalScore descending, (2) evidence_strength score
 * descending, (3) demand score descending, (4) topicId ascending as a
 * stable final tie-breaker. Returns a new array — the input is never
 * mutated.
 */
export function sortTopicsForRanking(topics: ScoredTopic[]): ScoredTopic[] {
  return [...topics].sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    const evidenceDiff = getDimensionScore(b, "evidence_strength") - getDimensionScore(a, "evidence_strength");
    if (evidenceDiff !== 0) return evidenceDiff;
    const demandDiff = getDimensionScore(b, "demand") - getDimensionScore(a, "demand");
    if (demandDiff !== 0) return demandDiff;
    return a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0;
  });
}

/** Sorts and assigns sequential `ranking` (starting at 1) with a shared `candidateCount`. A zero-topic input returns `[]`. */
export function assignRanking(topics: ScoredTopic[]): ScoredTopic[] {
  const sorted = sortTopicsForRanking(topics);
  const candidateCount = sorted.length;
  return sorted.map((topic, index) => ({ ...topic, ranking: { rank: index + 1, candidateCount } }));
}

// ---------------------------------------------------------------------------
// Deterministic confidence caps (growth/README.md's "Confidence handling")
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

export interface ConfidenceCapContext {
  sourceIsMock: boolean;
  sourceHumanReviewed: boolean;
  policyDefaultCount: number;
  signalCount: number;
}

export interface ConfidenceCapResult {
  finalConfidence: Confidence;
  reasons: string[];
}

/**
 * Applies every cap stricter than the provider's own confidence and returns
 * the minimum, plus the reasons for only the caps that actually reduced it
 * below the original value — an unchanged confidence always has an empty
 * `reasons` array, so a downgrade is never silent and an unaffected topic
 * never carries a misleading "reason" for nothing.
 */
export function applyConfidenceCaps(providerConfidence: Confidence, context: ConfidenceCapContext): ConfidenceCapResult {
  const caps: { value: Confidence; reason: string }[] = [];

  if (context.sourceIsMock) {
    caps.push({ value: "low", reason: "Source Signal Mining run was mock-generated (generation.isMock = true)." });
  }
  if (!context.sourceHumanReviewed) {
    caps.push({ value: "medium", reason: "Source signals/topics have not been human-approved (humanReview.approved = false)." });
  }
  if (context.policyDefaultCount > 3) {
    caps.push({
      value: "low",
      reason: `More than three dimensions (${context.policyDefaultCount} of 7) used the policy-default fallback score.`,
    });
  }
  if (context.signalCount <= 1) {
    caps.push({
      value: "low",
      reason: `Topic has ${context.signalCount === 0 ? "no" : "only a single"} supporting signal.`,
    });
  }

  let finalConfidence = providerConfidence;
  for (const cap of caps) {
    if (CONFIDENCE_RANK[cap.value] < CONFIDENCE_RANK[finalConfidence]) finalConfidence = cap.value;
  }

  const reasons = caps.filter((cap) => CONFIDENCE_RANK[cap.value] < CONFIDENCE_RANK[providerConfidence]).map((cap) => cap.reason);

  return { finalConfidence, reasons };
}

// ---------------------------------------------------------------------------
// Deterministic recommendation (growth/scoring/README.md's "Recommendation
// thresholds" — the Agent never lets the provider choose this)
// ---------------------------------------------------------------------------

export type TopicScoringRecommendation = "advance" | "needs_human_review" | "hold" | "reject";

export interface RecommendationContext {
  totalScore: number;
  evidenceStrengthScore: number;
  blockersCount: number;
  finalConfidence: Confidence;
  sourceIsMock: boolean;
  sourceHumanReviewed: boolean;
}

/**
 * v1 rules (never automatic "reject" — reserved for a future explicit
 * human-review action):
 * - hold: totalScore < 50, OR one or more blockers (blockers force hold
 *   regardless of score — checked first, so it always wins).
 * - advance: totalScore >= 70 AND evidence_strength >= 60 AND zero blockers
 *   AND confidence high/medium AND the source run is not mock AND source
 *   topics are human-approved.
 * - needs_human_review: everything else that isn't "hold" — including a
 *   topic that would otherwise qualify for "advance" except for mock/
 *   unreviewed source input.
 */
export function computeRecommendation(context: RecommendationContext): TopicScoringRecommendation {
  const { totalScore, evidenceStrengthScore, blockersCount, finalConfidence, sourceIsMock, sourceHumanReviewed } = context;

  if (totalScore < 50 || blockersCount > 0) return "hold";

  const meetsAdvanceCore =
    totalScore >= 70 &&
    evidenceStrengthScore >= 60 &&
    blockersCount === 0 &&
    (finalConfidence === "high" || finalConfidence === "medium");

  if (meetsAdvanceCore) {
    if (sourceIsMock || !sourceHumanReviewed) return "needs_human_review";
    return "advance";
  }

  return "needs_human_review";
}
