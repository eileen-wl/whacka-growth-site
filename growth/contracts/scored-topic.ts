import { z } from "zod/v4";
import { deterministicId } from "../lib/ids";
import type { TopicCandidate } from "./topic-candidate";
import {
  assertSupportedMajorVersion,
  campaignIdSchema,
  confidenceSchema,
  isoTimestampSchema,
  provenanceSchema,
  refIdArraySchema,
  schemaVersionSchema,
} from "./common";

/**
 * ScoredTopic — step 3 output (Topic Scoring Agent). Preserves TopicCandidate
 * identity via `topicId` (a reference, never a mutation of the original
 * record) and attaches a deterministic, dimension-based score.
 */

export const SCORED_TOPIC_SUPPORTED_MAJOR_VERSION = 1;

/**
 * Current dimension vocabulary. If a future scoring pass needs different
 * dimensions, bump `scoringVersion` and document the mapping in
 * growth/contracts/README.md rather than silently changing what a dimension
 * key means for topics already scored under an earlier version.
 */
export const scoringDimensionKeySchema = z.enum([
  "demand",
  "audience_relevance",
  "product_fit",
  "competition",
  "feasibility",
  "novelty",
  "evidence_strength",
]);

const SCORE_TOLERANCE = 0.01;

export const scoringDimensionSchema = z
  .strictObject({
    key: scoringDimensionKeySchema,
    label: z.string().min(1).max(160),
    score: z.number().min(0).max(100),
    weight: z.number().min(0).max(1),
    weightedScore: z.number().min(0).max(100),
    rationale: z.string().min(1).max(1000),
    signalRefs: refIdArraySchema,
    evidenceRefs: refIdArraySchema,
    limitations: z.array(z.string().min(1).max(500)).max(20),
    /** Optional, additive (see growth/contracts/README.md's versioning policy): distinguishes an evidence-grounded score from one that used a scoring agent's insufficient-evidence policy fallback. Omitted by producers that don't track this distinction. */
    scoreBasis: z.enum(["evidence", "policy_default"]).optional(),
  })
  .refine((dimension) => Math.abs(dimension.weightedScore - dimension.score * dimension.weight) <= SCORE_TOLERANCE, {
    message: "weightedScore must equal score * weight (within tolerance).",
    path: ["weightedScore"],
  });

export type ScoringDimension = z.infer<typeof scoringDimensionSchema>;

export const scoredTopicRankingSchema = z.strictObject({
  rank: z.number().int().min(1),
  candidateCount: z.number().int().min(1),
});

export type ScoredTopicRanking = z.infer<typeof scoredTopicRankingSchema>;

export const scoringRecommendationSchema = z.enum(["advance", "hold", "reject", "needs_human_review"]);

export const scoredTopicSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: z.string().min(1).max(160),
    topicId: z.string().min(1).max(160),
    campaignId: campaignIdSchema,
    scoredAt: isoTimestampSchema,
    scoringVersion: z.string().min(1).max(40),
    dimensions: z.array(scoringDimensionSchema).min(1).max(20),
    totalScore: z.number().min(0).max(100),
    ranking: z.union([scoredTopicRankingSchema, z.null()]),
    confidence: confidenceSchema,
    recommendation: scoringRecommendationSchema,
    blockers: z.array(z.string().min(1).max(500)).max(20),
    humanReviewRequired: z.literal(true),
    provenance: provenanceSchema,
  })
  .refine(
    (topic) => {
      const keys = topic.dimensions.map((dimension) => dimension.key);
      return new Set(keys).size === keys.length;
    },
    { message: "dimension keys must be unique.", path: ["dimensions"] }
  )
  .refine(
    (topic) => {
      const sum = topic.dimensions.reduce((total, dimension) => total + dimension.weightedScore, 0);
      return Math.abs(sum - topic.totalScore) <= SCORE_TOLERANCE;
    },
    {
      message:
        "totalScore must be deterministically derived from the sum of dimension weightedScores (within tolerance). " +
        "An inconsistent LLM-provided total is rejected here, never silently recomputed.",
      path: ["totalScore"],
    }
  );

export type ScoredTopic = z.infer<typeof scoredTopicSchema>;

export class ScoredTopicValidationError extends Error {}

export function validateScoredTopic(rawData: unknown): ScoredTopic {
  const result = scoredTopicSchema.safeParse(rawData);
  if (!result.success) {
    throw new ScoredTopicValidationError(`Invalid ScoredTopic: ${result.error.message}`);
  }
  assertSupportedMajorVersion("ScoredTopic", result.data.schemaVersion, SCORED_TOPIC_SUPPORTED_MAJOR_VERSION);
  return result.data;
}

/** Deterministic identity: same topic + same scoringVersion always yields the same ScoredTopic id, so re-scoring under an unchanged rubric overwrites rather than duplicates. */
export function buildScoredTopicId(args: { topicId: string; scoringVersion: string }): string {
  return deterministicId("scoredtopic", args.topicId, args.scoringVersion);
}

export function computeWeightedScore(score: number, weight: number): number {
  return Math.round(score * weight * 100) / 100;
}

export function computeTotalScore(dimensions: Array<{ weightedScore: number }>): number {
  const sum = dimensions.reduce((total, dimension) => total + dimension.weightedScore, 0);
  return Math.round(sum * 100) / 100;
}

export class TopicToScoredTopicValidationError extends Error {}

/**
 * Validates that a TopicCandidate is a legitimate scoring target — pure
 * input validation, not scoring logic. It does NOT compute dimension scores;
 * the caller (Topic Scoring Agent, not in scope here) still decides those.
 */
export function validateTopicForScoring(topic: TopicCandidate): TopicCandidate {
  if (topic.status === "rejected" || topic.status === "archived") {
    throw new TopicToScoredTopicValidationError(
      `TopicCandidate ${topic.id} has status "${topic.status}" and cannot be scored.`
    );
  }
  return topic;
}
