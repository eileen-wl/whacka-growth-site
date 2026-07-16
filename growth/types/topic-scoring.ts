import { z } from "zod/v4";
import { scoringDimensionKeySchema } from "../contracts/scored-topic";
import type { CampaignInfo, DateRange } from "./growth-summary";
import type { SupportedLanguage } from "./llm";
import type { ScoredTopic } from "../contracts/scored-topic";
import type { TopicCandidate } from "../contracts/topic-candidate";

/**
 * Internal Topic Scoring Agent input/output types. `TopicScoringAnalysis` is
 * the model-generated portion only (per-dimension assessments) — the model
 * never computes weights, weighted scores, totals, ranks, or the final
 * recommendation. The Agent's only public output is `ScoredTopic[]`
 * (growth/contracts/scored-topic.ts), validated against that contract
 * before being written anywhere.
 */

/** `growth/contracts/scored-topic.ts` doesn't export these as standalone types, only inline in `ScoringDimension`/`ScoredTopic` — derived here once for reuse across this file. */
export type ScoringDimensionKey = z.infer<typeof scoringDimensionKeySchema>;
export type Confidence = "high" | "medium" | "low";

const MEDIUM = 800;

// ---------------------------------------------------------------------------
// TopicScoringAnalysis — the model-generated portion of a run
// ---------------------------------------------------------------------------

const confidenceSchema = z.enum(["high", "medium", "low"]);
const mediumText = z.string().min(1).max(MEDIUM);
const refId = z.string().min(1).max(160);

export const dimensionScoreBasisSchema = z.enum(["evidence", "policy_default"]);

/** The fixed v1 fallback score for a `policy_default` dimension — see growth/scoring/README.md's "Fallback-score meaning". A single source of truth: growth/scoring/topic-scoring-profile.ts re-exports this same value as `INSUFFICIENT_EVIDENCE_FALLBACK_SCORE`. */
export const TOPIC_SCORING_INSUFFICIENT_EVIDENCE_FALLBACK_SCORE = 50;

export const dimensionAssessmentSchema = z
  .strictObject({
    key: scoringDimensionKeySchema,
    score: z.number().min(0).max(100),
    scoreBasis: dimensionScoreBasisSchema,
    rationale: mediumText,
    signalRefs: z.array(refId).max(30),
    sourceRecordRefs: z.array(refId).max(30),
    limitations: z.array(mediumText).max(10),
  })
  .refine((dimension) => dimension.scoreBasis !== "evidence" || dimension.signalRefs.length + dimension.sourceRecordRefs.length > 0, {
    message: 'An "evidence" scoreBasis requires at least one signalRef or sourceRecordRef.',
    path: ["signalRefs"],
  })
  .refine((dimension) => dimension.scoreBasis !== "policy_default" || dimension.limitations.length > 0, {
    message: 'A "policy_default" scoreBasis requires at least one limitation explaining why evidence was insufficient.',
    path: ["limitations"],
  })
  .refine((dimension) => dimension.scoreBasis !== "policy_default" || dimension.score === TOPIC_SCORING_INSUFFICIENT_EVIDENCE_FALLBACK_SCORE, {
    message: `A "policy_default" scoreBasis must use the fixed fallback score (${TOPIC_SCORING_INSUFFICIENT_EVIDENCE_FALLBACK_SCORE}) — it is not a measured average.`,
    path: ["score"],
  });

export type DimensionAssessment = z.infer<typeof dimensionAssessmentSchema>;

export const blockerCodeSchema = z.enum([
  "insufficient_evidence",
  "duplicate_or_existing",
  "unclear_audience",
  "outside_current_scope",
  "requires_unavailable_data",
  "other",
]);

export const blockerSchema = z.strictObject({
  code: blockerCodeSchema,
  description: mediumText,
  signalRefs: z.array(refId).max(30),
  sourceRecordRefs: z.array(refId).max(30),
});

export type Blocker = z.infer<typeof blockerSchema>;

export const topicAssessmentSchema = z
  .strictObject({
    topicId: z.string().min(1).max(160),
    dimensions: z.array(dimensionAssessmentSchema).min(7).max(7),
    confidence: confidenceSchema,
    blockers: z.array(blockerSchema).max(10),
    reviewNotes: z.array(mediumText).max(10),
  })
  .refine(
    (assessment) => {
      const keys = assessment.dimensions.map((dimension) => dimension.key);
      return new Set(keys).size === 7;
    },
    {
      message: "dimensions must contain each of the seven required dimension keys exactly once.",
      path: ["dimensions"],
    }
  );

export type TopicAssessment = z.infer<typeof topicAssessmentSchema>;

export const portfolioObservationsSchema = z.strictObject({
  topicCoverage: mediumText,
  evidenceCoverage: mediumText,
  majorLimitations: z.array(mediumText).max(10),
  requiresHumanReview: z.literal(true),
});

export type PortfolioObservations = z.infer<typeof portfolioObservationsSchema>;

/** The model-generated portion of a run. See growth/agents/topic-scoring-agent.ts for the cross-referential rules (topic coverage, per-topic signal/source-record scoping) layered on top. */
export const topicScoringAnalysisSchema = z.strictObject({
  topicAssessments: z.array(topicAssessmentSchema).max(50),
  portfolioObservations: portfolioObservationsSchema,
});

export type TopicScoringAnalysis = z.infer<typeof topicScoringAnalysisSchema>;

// ---------------------------------------------------------------------------
// Fixed scoring profile
// ---------------------------------------------------------------------------

export interface ScoringDimensionDefinition {
  key: ScoringDimensionKey;
  label: string;
  weight: number;
  description: string;
}

export interface TopicScoringProfile {
  id: string;
  version: string;
  dimensions: ScoringDimensionDefinition[];
  insufficientEvidenceFallbackScore: number;
}

// ---------------------------------------------------------------------------
// Deterministic per-topic context supplied to the provider
// ---------------------------------------------------------------------------

export interface TopicScoringSignalContext {
  id: string;
  title: string;
  summary: string;
  signalType: string;
  confidence: "high" | "medium" | "low";
  freshness: string;
  metrics: { name: string; value: number; unit: string | null }[];
  sourceRecordIds: string[];
}

export interface TopicScoringSourceRecordContext {
  id: string;
  title: string;
  sourceType: string;
  content: string;
  metrics: { name: string; value: number; unit: string | null }[];
}

export interface TopicScoringContext {
  topicId: string;
  canonicalName: string;
  slug: string;
  problemStatement: string;
  targetAudience: string;
  useCases: string[];
  desiredOutcome: string;
  status: TopicCandidate["status"];
  candidateConfidence: "high" | "medium" | "low";
  relationshipToExistingContent: {
    status: TopicCandidate["relationshipToExistingContent"]["status"];
    relatedAppSlugs: string[];
    relatedTopicIds: string[];
  };
  signals: TopicScoringSignalContext[];
  citedSourceRecords: TopicScoringSourceRecordContext[];
  signalCount: number;
  sourceCount: number;
  sourceTypes: string[];
}

/** A concise, comparison-only entry for every topic in the run — used so the model can reason about relative novelty/duplication without receiving another topic's full evidence. */
export interface TopicScoringCatalogEntry {
  topicId: string;
  canonicalName: string;
  slug: string;
  relatedAppSlugs: string[];
  relationshipStatus: string;
  signalCount: number;
}

// ---------------------------------------------------------------------------
// LLM request/response contracts
// ---------------------------------------------------------------------------

export interface TopicScoringLLMRequest {
  purpose: string;
  campaign: CampaignInfo;
  period: DateRange;
  language: SupportedLanguage;
  scoringProfile: TopicScoringProfile;
  topicContexts: TopicScoringContext[];
  topicCatalog: TopicScoringCatalogEntry[];
  dataQualityWarnings: string[];
  sourceIsMock: boolean;
  sourceHumanReviewed: boolean;
  reportingRules: string[];
  responseSchemaDescription: string;
  maxTokens: number;
  systemPrompt: string;
  userPrompt: string;
}

// ---------------------------------------------------------------------------
// Final assembled run
// ---------------------------------------------------------------------------

export interface TopicScoringProvenance {
  sourceSignalMiningFilename: string;
  sourceSignalMiningSha256: string;
  sourceSignalMiningGeneratedAt: string;
  sourceSignalMiningProvider: string;
  sourceSignalMiningModel: string;
  sourceSignalMiningIsMock: boolean;
  sourceSignalsHumanReviewed: boolean;
}

export interface TopicScoringGenerationMetadata {
  provider: string;
  model: string;
  language: SupportedLanguage;
  isMock: boolean;
  requestId: string | null;
  stopReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

export interface TopicScoringProfileSummary {
  id: string;
  version: string;
  dimensions: ScoringDimensionDefinition[];
  recommendationRules: {
    advance: string;
    needsHumanReview: string;
    hold: string;
    reject: string;
  };
  insufficientEvidenceFallbackScore: number;
}

export interface TopicScoringRankingSummary {
  candidateCount: number;
  rankedTopicIds: string[];
  topTopicId: string | null;
  advanceCount: number;
  needsHumanReviewCount: number;
  holdCount: number;
  rejectCount: number;
}

export interface TopicScoringConfidenceAdjustment {
  topicId: string;
  originalConfidence: Confidence;
  finalConfidence: Confidence;
  reasons: string[];
}

export interface TopicScoringHumanReview {
  required: true;
  approved: false;
  selectedTopicIds: string[];
  approvedBy: null;
  approvedAt: null;
  note: string;
}

export interface TopicScoringDataQuality {
  overallStatus: "complete" | "partial" | "invalid";
  warnings: string[];
  limitations: string[];
}

/** The on-disk shape written to growth/scores/topic-scoring-{start}_to_{end}.json. */
export interface FinalTopicScoringRun {
  schemaVersion: "1.0.0";
  runType: "topic_scoring";
  generatedAt: string;
  period: DateRange;
  campaign: CampaignInfo;
  provenance: TopicScoringProvenance;
  generation: TopicScoringGenerationMetadata;
  scoringProfile: TopicScoringProfileSummary;
  topicCatalog: TopicCandidate[];
  scoredTopics: ScoredTopic[];
  ranking: TopicScoringRankingSummary;
  portfolioObservations: PortfolioObservations;
  confidenceAdjustments: TopicScoringConfidenceAdjustment[];
  humanReview: TopicScoringHumanReview;
  dataQuality: TopicScoringDataQuality;
}

/** The on-disk shape written to growth/data/processed/topic-scoring-request-{start}_to_{end}.json in --dry-run mode. Never includes secrets. */
export interface TopicScoringDryRunPreview {
  source: "topic_scoring_dry_run";
  createdAt: string;
  period: DateRange;
  campaign: CampaignInfo;
  sourceSignalMiningFilename: string;
  sourceSignalMiningSha256: string;
  sourceSignalMiningIsMock: boolean;
  sourceSignalsHumanReviewed: boolean;
  scoringProfile: TopicScoringProfileSummary;
  topicContexts: TopicScoringContext[];
  topicCatalog: TopicScoringCatalogEntry[];
  dataQualityWarnings: string[];
  language: SupportedLanguage;
  intendedProvider: string;
  intendedModel: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchemaDescription: string;
}
