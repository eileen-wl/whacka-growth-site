import { TOPIC_SCORING_INSUFFICIENT_EVIDENCE_FALLBACK_SCORE } from "../types/topic-scoring";
import type { ScoringDimensionDefinition, TopicScoringProfile, TopicScoringProfileSummary } from "../types/topic-scoring";

/**
 * The fixed, versioned v1 scoring profile for the Topic Scoring Agent.
 * "Fixed" means: this module exports one constant profile, not a
 * configurable rubric builder — a future v2 profile would be a new export
 * (`TOPIC_SCORING_PROFILE_V2`) plus a new `profileVersion`, never a silent
 * change to what "small_business_topic_scoring@1.0.0" means. See
 * growth/scoring/README.md for the versioning policy.
 */

export const TOPIC_SCORING_PROFILE_ID = "small_business_topic_scoring";
export const TOPIC_SCORING_PROFILE_VERSION = "1.0.0";

/** A dimension lacking enough evidence uses this score — "insufficient evidence to move the score positively or negatively," never a measured average. See growth/scoring/README.md. Re-exports the single source of truth from growth/types/topic-scoring.ts, where it's also enforced as a schema-level invariant (a `policy_default` dimension must use exactly this score). */
export const INSUFFICIENT_EVIDENCE_FALLBACK_SCORE = TOPIC_SCORING_INSUFFICIENT_EVIDENCE_FALLBACK_SCORE;

const DIMENSIONS: ScoringDimensionDefinition[] = [
  {
    key: "demand",
    label: "Demand",
    weight: 0.2,
    description:
      "How strongly the supplied signals indicate a real need, interest, engagement pattern, or repeated problem. " +
      "This is not total market demand, and search volume must never be invented.",
  },
  {
    key: "audience_relevance",
    label: "Audience relevance",
    weight: 0.15,
    description: "How closely the topic matches the audiences explicitly represented in the supplied signals and TopicCandidate.",
  },
  {
    key: "product_fit",
    label: "Product fit",
    weight: 0.2,
    description:
      "How appropriately the topic can be represented as a Whacka-style mini-app or growth-site use case, based only on the supplied " +
      "topic, use cases, existing app catalog, and current project context. Unsupported Whacka platform capabilities must never be invented.",
  },
  {
    key: "competition",
    label: "Competition (opportunity favourability)",
    weight: 0.1,
    description:
      "An opportunity-favourability score, not a claim about the entire external market. Higher means less observed overlap or " +
      "saturation in the supplied evidence and less duplication with existing campaign content. Lower means duplicate/strong overlap " +
      "with existing content, or supplied competitor/content signals show saturation.",
  },
  {
    key: "feasibility",
    label: "Feasibility",
    weight: 0.15,
    description:
      "How clearly and narrowly the topic can be turned into a testable mini-app concept and growth asset using the current system. " +
      "Engineering-effort claims unsupported by the supplied context must never be made.",
  },
  {
    key: "novelty",
    label: "Novelty",
    weight: 0.1,
    description: "How meaningfully distinct the topic is from the campaign's existing apps and topic pool.",
  },
  {
    key: "evidence_strength",
    label: "Evidence strength",
    weight: 0.1,
    description: "How strong, direct, diverse, and traceable the supporting signals are.",
  },
];

const WEIGHT_TOLERANCE = 0.0001;

function assertWeightsSumToOne(dimensions: ScoringDimensionDefinition[]): void {
  const sum = dimensions.reduce((total, dimension) => total + dimension.weight, 0);
  if (Math.abs(sum - 1) > WEIGHT_TOLERANCE) {
    throw new Error(`Topic scoring profile weights must sum to 1; got ${sum}.`);
  }
}
assertWeightsSumToOne(DIMENSIONS);

/** Returns the fixed v1 scoring profile. Always the same object shape for the same profile version — never mutated by callers. */
export function getTopicScoringProfile(): TopicScoringProfile {
  return {
    id: TOPIC_SCORING_PROFILE_ID,
    version: TOPIC_SCORING_PROFILE_VERSION,
    dimensions: DIMENSIONS.map((dimension) => ({ ...dimension })),
    insufficientEvidenceFallbackScore: INSUFFICIENT_EVIDENCE_FALLBACK_SCORE,
  };
}

/**
 * Human-readable recommendation-rule text embedded in the final run's
 * `scoringProfile.recommendationRules`, so a reader of the JSON alone (no
 * source access) can see exactly why a topic landed where it did. Must stay
 * in sync with growth/agents/topic-scoring-agent.ts's `computeRecommendation`
 * — see growth/scoring/README.md for the authoritative rule text.
 */
export function getRecommendationRulesSummary(): TopicScoringProfileSummary["recommendationRules"] {
  return {
    advance:
      "totalScore >= 70 AND evidence_strength score >= 60 AND zero blockers AND confidence is high or medium AND the source Signal " +
      "Mining run was not mock-generated AND source topics were human-approved. Even 'advance' is not approval and does not trigger " +
      "Asset Generation.",
    needsHumanReview:
      "totalScore in [50, 70); OR totalScore >= 70 with evidence_strength score below 60; OR totalScore >= 70 with confidence 'low'; " +
      "OR the topic would otherwise qualify for 'advance' but the source Signal Mining run was mock-generated or its topics were not " +
      "human-approved.",
    hold: "totalScore below 50, OR one or more blockers exist (blockers force 'hold' regardless of score).",
    reject: "Never assigned automatically in v1 — reserved for a future explicit human-review action.",
  };
}

export function buildTopicScoringProfileSummary(): TopicScoringProfileSummary {
  const profile = getTopicScoringProfile();
  return {
    id: profile.id,
    version: profile.version,
    dimensions: profile.dimensions,
    recommendationRules: getRecommendationRulesSummary(),
    insufficientEvidenceFallbackScore: profile.insufficientEvidenceFallbackScore,
  };
}
