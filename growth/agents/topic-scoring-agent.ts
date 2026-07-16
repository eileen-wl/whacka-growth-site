import { buildScoredTopicId, validateScoredTopic } from "../contracts/scored-topic";
import { buildTopicScoringLLMRequest } from "../prompts/topic-scoring-prompt";
import { buildTopicScoringProfileSummary, getTopicScoringProfile } from "../scoring/topic-scoring-profile";
import {
  applyConfidenceCaps,
  assignRanking,
  computeRecommendation,
  computeTotalScore,
  computeWeightedScore,
} from "../scoring/topic-scoring-engine";
import { topicScoringAnalysisSchema } from "../types/topic-scoring";
import type { ScoredTopic } from "../contracts/scored-topic";
import type { TopicScoringProvider } from "../llm/topic-scoring-provider";
import type { SupportedLanguage } from "../types/llm";
import type {
  FinalSignalMiningRun,
  SignalSourceRecord,
} from "../types/signal-mining";
import type {
  FinalTopicScoringRun,
  TopicAssessment,
  TopicScoringAnalysis,
  TopicScoringCatalogEntry,
  TopicScoringConfidenceAdjustment,
  TopicScoringContext,
  TopicScoringProfile,
} from "../types/topic-scoring";

export class TopicScoringValidationError extends Error {}

// ---------------------------------------------------------------------------
// Deterministic per-topic context (built from an already-loaded,
// already-validated FinalSignalMiningRun — never from raw files).
// ---------------------------------------------------------------------------

export interface TopicScoringContextResult {
  contexts: TopicScoringContext[];
  catalog: TopicScoringCatalogEntry[];
}

/**
 * Builds one deterministic TopicScoringContext per TopicCandidate in the
 * run's topicPool, scoped to exactly that topic's own resolved signals and
 * the source records those signals cite — never another topic's full
 * evidence — plus a concise topicCatalog for relative novelty/duplication
 * comparison only.
 */
export function buildTopicScoringContexts(run: FinalSignalMiningRun): TopicScoringContextResult {
  const signalsById = new Map(run.signals.map((signal) => [signal.id, signal]));
  const sourceRecordsById = new Map(run.sourceRecordCatalog.map((record) => [record.id, record]));

  const contexts: TopicScoringContext[] = run.topicPool.map((topic) => {
    const signals = topic.signalRefs.map((ref) => signalsById.get(ref)!);

    const citedSourceRecordIds = new Set<string>();
    for (const signal of signals) for (const id of signal.provenance.sourceRecordIds) citedSourceRecordIds.add(id);

    const citedSourceRecords = [...citedSourceRecordIds]
      .map((id) => sourceRecordsById.get(id))
      .filter((record): record is SignalSourceRecord => record !== undefined)
      .map((record) => ({
        id: record.id,
        title: record.title,
        sourceType: record.source.type,
        content: record.content,
        metrics: record.metrics.map((metric) => ({ name: metric.name, value: metric.value, unit: metric.unit })),
      }));

    return {
      topicId: topic.id,
      canonicalName: topic.canonicalName,
      slug: topic.slug,
      problemStatement: topic.problemStatement,
      targetAudience: topic.targetAudience,
      useCases: topic.useCases,
      desiredOutcome: topic.desiredOutcome,
      status: topic.status,
      candidateConfidence: topic.evidenceSummary.confidence,
      relationshipToExistingContent: {
        status: topic.relationshipToExistingContent.status,
        relatedAppSlugs: topic.relationshipToExistingContent.relatedAppSlugs,
        relatedTopicIds: topic.relationshipToExistingContent.relatedTopicIds,
      },
      signals: signals.map((signal) => ({
        id: signal.id,
        title: signal.title,
        summary: signal.summary,
        signalType: signal.signalType,
        confidence: signal.quality.confidence,
        freshness: signal.quality.freshness,
        metrics: signal.metrics.map((metric) => ({ name: metric.name, value: metric.value, unit: metric.unit })),
        sourceRecordIds: signal.provenance.sourceRecordIds,
      })),
      citedSourceRecords,
      signalCount: signals.length,
      sourceCount: citedSourceRecordIds.size,
      sourceTypes: [...new Set(citedSourceRecords.map((record) => record.sourceType))],
    };
  });

  const catalog: TopicScoringCatalogEntry[] = run.topicPool.map((topic) => ({
    topicId: topic.id,
    canonicalName: topic.canonicalName,
    slug: topic.slug,
    relatedAppSlugs: topic.relationshipToExistingContent.relatedAppSlugs,
    relationshipStatus: topic.relationshipToExistingContent.status,
    signalCount: topic.signalRefs.length,
  }));

  return { contexts, catalog };
}

// ---------------------------------------------------------------------------
// Structured-output validation
// ---------------------------------------------------------------------------

/**
 * Validates a provider's raw response before it's trusted downstream:
 * (1) the static Zod schema (re-checked for every provider, since the Mock
 * Provider skips the Anthropic SDK's own client-side parsing);
 * (2) cross-referential rules the static schema can't express — exactly one
 * assessment per supplied topic (no unknown topic, no duplicate, no
 * missing one), and every dimension/blocker signalRef/sourceRecordRef must
 * resolve within THAT topic's own supplied context — never another
 * topic's. Throws TopicScoringValidationError on any failure — callers
 * must not assemble or write a final run when this throws.
 */
export function validateTopicScoringAnalysis(rawData: unknown, contexts: TopicScoringContext[]): TopicScoringAnalysis {
  const parsed = topicScoringAnalysisSchema.safeParse(rawData);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new TopicScoringValidationError(`Model response did not match the required schema: ${issues.join("; ")}`);
  }
  const analysis = parsed.data;

  const contextsByTopicId = new Map(contexts.map((context) => [context.topicId, context]));
  const expectedTopicIds = new Set(contexts.map((context) => context.topicId));
  const seenTopicIds = new Set<string>();

  for (const assessment of analysis.topicAssessments) {
    if (!expectedTopicIds.has(assessment.topicId)) {
      throw new TopicScoringValidationError(`Model response contains an assessment for unknown topic "${assessment.topicId}".`);
    }
    if (seenTopicIds.has(assessment.topicId)) {
      throw new TopicScoringValidationError(`Duplicate topicAssessments entry for topic "${assessment.topicId}".`);
    }
    seenTopicIds.add(assessment.topicId);

    const context = contextsByTopicId.get(assessment.topicId)!;
    const allowedSignalIds = new Set(context.signals.map((signal) => signal.id));
    const allowedSourceRecordIds = new Set(context.citedSourceRecords.map((record) => record.id));

    assertScopedRefs(assessment, allowedSignalIds, allowedSourceRecordIds);
  }

  const missingTopicIds = [...expectedTopicIds].filter((id) => !seenTopicIds.has(id));
  if (missingTopicIds.length > 0) {
    throw new TopicScoringValidationError(`Model response is missing an assessment for topic(s): ${missingTopicIds.join(", ")}.`);
  }

  return analysis;
}

function assertScopedRefs(assessment: TopicAssessment, allowedSignalIds: Set<string>, allowedSourceRecordIds: Set<string>): void {
  for (const dimension of assessment.dimensions) {
    const unknownSignalRefs = dimension.signalRefs.filter((ref) => !allowedSignalIds.has(ref));
    if (unknownSignalRefs.length > 0) {
      throw new TopicScoringValidationError(
        `Topic "${assessment.topicId}" dimension "${dimension.key}" references signalRef(s) outside its own supplied signals: ${unknownSignalRefs.join(", ")}.`
      );
    }
    const unknownSourceRefs = dimension.sourceRecordRefs.filter((ref) => !allowedSourceRecordIds.has(ref));
    if (unknownSourceRefs.length > 0) {
      throw new TopicScoringValidationError(
        `Topic "${assessment.topicId}" dimension "${dimension.key}" references sourceRecordRef(s) outside its own supplied source records: ${unknownSourceRefs.join(", ")}.`
      );
    }
  }
  for (const blocker of assessment.blockers) {
    const unknownSignalRefs = blocker.signalRefs.filter((ref) => !allowedSignalIds.has(ref));
    if (unknownSignalRefs.length > 0) {
      throw new TopicScoringValidationError(`Topic "${assessment.topicId}" blocker references unknown signalRef(s): ${unknownSignalRefs.join(", ")}.`);
    }
    const unknownSourceRefs = blocker.sourceRecordRefs.filter((ref) => !allowedSourceRecordIds.has(ref));
    if (unknownSourceRefs.length > 0) {
      throw new TopicScoringValidationError(`Topic "${assessment.topicId}" blocker references unknown sourceRecordRef(s): ${unknownSourceRefs.join(", ")}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// ScoredTopic assembly (deterministic weighting/totals/confidence caps/
// recommendation — see growth/scoring/topic-scoring-engine.ts)
// ---------------------------------------------------------------------------

export interface ScoredTopicAssemblyProvenance {
  sourceFileNames: string[];
  sourceHashes: string[];
  provider: string;
  model: string;
  isMock: boolean;
}

export interface AssembleScoredTopicsParams {
  analysis: TopicScoringAnalysis;
  contexts: TopicScoringContext[];
  profile: TopicScoringProfile;
  campaignId: string;
  scoredAt: string;
  sourceIsMock: boolean;
  sourceHumanReviewed: boolean;
  provenance: ScoredTopicAssemblyProvenance;
}

export interface AssembledScoredTopics {
  scoredTopics: ScoredTopic[];
  confidenceAdjustments: TopicScoringConfidenceAdjustment[];
}

/**
 * Deterministically builds ScoredTopic contracts from a validated
 * TopicScoringAnalysis: computes each dimension's weightedScore and the
 * topic's totalScore (never trusting a provider-supplied calculation),
 * applies confidence caps, computes the final recommendation, then ranks
 * every topic together. Every assembled ScoredTopic is validated against
 * the existing contract before being returned.
 */
export function assembleScoredTopics(params: AssembleScoredTopicsParams): AssembledScoredTopics {
  const scoringVersion = `${params.profile.id}@${params.profile.version}`;
  const dimensionDefsByKey = new Map(params.profile.dimensions.map((definition) => [definition.key, definition]));
  const assessmentsByTopicId = new Map(params.analysis.topicAssessments.map((assessment) => [assessment.topicId, assessment]));

  const confidenceAdjustments: TopicScoringConfidenceAdjustment[] = [];
  const unranked: ScoredTopic[] = [];

  for (const context of params.contexts) {
    const assessment = assessmentsByTopicId.get(context.topicId)!;

    const dimensions = assessment.dimensions.map((dimension) => {
      const definition = dimensionDefsByKey.get(dimension.key)!;
      return {
        key: dimension.key,
        label: definition.label,
        score: dimension.score,
        weight: definition.weight,
        weightedScore: computeWeightedScore(dimension.score, definition.weight),
        rationale: dimension.rationale,
        signalRefs: dimension.signalRefs,
        evidenceRefs: dimension.sourceRecordRefs,
        limitations: dimension.limitations,
        scoreBasis: dimension.scoreBasis,
      };
    });

    const totalScore = computeTotalScore(dimensions);
    const policyDefaultCount = assessment.dimensions.filter((dimension) => dimension.scoreBasis === "policy_default").length;

    const { finalConfidence, reasons } = applyConfidenceCaps(assessment.confidence, {
      sourceIsMock: params.sourceIsMock,
      sourceHumanReviewed: params.sourceHumanReviewed,
      policyDefaultCount,
      signalCount: context.signalCount,
    });
    if (reasons.length > 0) {
      confidenceAdjustments.push({ topicId: context.topicId, originalConfidence: assessment.confidence, finalConfidence, reasons });
    }

    const evidenceStrengthScore = dimensions.find((dimension) => dimension.key === "evidence_strength")?.score ?? 0;

    const recommendation = computeRecommendation({
      totalScore,
      evidenceStrengthScore,
      blockersCount: assessment.blockers.length,
      finalConfidence,
      sourceIsMock: params.sourceIsMock,
      sourceHumanReviewed: params.sourceHumanReviewed,
    });

    unranked.push({
      schemaVersion: "1.0.0",
      id: buildScoredTopicId({ topicId: context.topicId, scoringVersion }),
      topicId: context.topicId,
      campaignId: params.campaignId,
      scoredAt: params.scoredAt,
      scoringVersion,
      dimensions,
      totalScore,
      ranking: null,
      confidence: finalConfidence,
      recommendation,
      blockers: assessment.blockers.map((blocker) => `${blocker.code}: ${blocker.description}`),
      humanReviewRequired: true,
      provenance: {
        generatedBy: "topic-scoring-agent",
        sourceFileNames: params.provenance.sourceFileNames,
        sourceHashes: params.provenance.sourceHashes,
        sourceRecordIds: [context.topicId],
        sourceDecisionId: null,
        provider: params.provenance.provider,
        model: params.provenance.model,
        isMock: params.provenance.isMock,
        humanReviewed: false,
      },
    });
  }

  const scoredTopics = assignRanking(unranked).map((topic) => validateScoredTopic(topic));

  return { scoredTopics, confidenceAdjustments };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunTopicScoringAgentParams {
  /** Already loaded and cross-reference-validated by the caller (script) — see growth/scripts/run-topic-scoring.ts. */
  run: FinalSignalMiningRun;
  sourceFilename: string;
  sourceSha256: string;
  language: SupportedLanguage;
  maxTokens: number;
  provider: TopicScoringProvider;
  /** Injectable for deterministic tests; defaults to the current time. */
  generatedAt?: string;
}

/**
 * Runs the full Topic Scoring Agent pipeline against an already-loaded,
 * already-validated FinalSignalMiningRun: build per-topic contexts, build
 * the LLM request, call the given provider, validate the response, run the
 * deterministic scoring engine, and assemble the final run. Depends only
 * on the provider-neutral TopicScoringProvider interface — never imports
 * an SDK directly.
 */
export async function runTopicScoringAgent(params: RunTopicScoringAgentParams): Promise<FinalTopicScoringRun> {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const profile = getTopicScoringProfile();
  const { contexts, catalog } = buildTopicScoringContexts(params.run);

  const sourceIsMock = params.run.generation.isMock;
  const sourceHumanReviewed = params.run.humanReview.approved;

  const request = buildTopicScoringLLMRequest({
    campaign: params.run.campaign,
    period: params.run.period,
    language: params.language,
    scoringProfile: profile,
    topicContexts: contexts,
    topicCatalog: catalog,
    dataQualityWarnings: params.run.dataQuality.warnings,
    sourceIsMock,
    sourceHumanReviewed,
    maxTokens: params.maxTokens,
  });

  const result = await params.provider.generateStructuredScores(request);
  const analysis = validateTopicScoringAnalysis(result.data, contexts);

  const isMock = params.provider.name === "mock";

  const { scoredTopics, confidenceAdjustments } = assembleScoredTopics({
    analysis,
    contexts,
    profile,
    campaignId: params.run.campaign.id,
    scoredAt: generatedAt,
    sourceIsMock,
    sourceHumanReviewed,
    provenance: { sourceFileNames: [params.sourceFilename], sourceHashes: [params.sourceSha256], provider: result.provider, model: result.model, isMock },
  });

  const advanceCount = scoredTopics.filter((topic) => topic.recommendation === "advance").length;
  const needsHumanReviewCount = scoredTopics.filter((topic) => topic.recommendation === "needs_human_review").length;
  const holdCount = scoredTopics.filter((topic) => topic.recommendation === "hold").length;
  const rejectCount = scoredTopics.filter((topic) => topic.recommendation === "reject").length;

  return {
    schemaVersion: "1.0.0",
    runType: "topic_scoring",
    generatedAt,
    period: params.run.period,
    campaign: params.run.campaign,
    provenance: {
      sourceSignalMiningFilename: params.sourceFilename,
      sourceSignalMiningSha256: params.sourceSha256,
      sourceSignalMiningGeneratedAt: params.run.generatedAt,
      sourceSignalMiningProvider: params.run.generation.provider,
      sourceSignalMiningModel: params.run.generation.model,
      sourceSignalMiningIsMock: sourceIsMock,
      sourceSignalsHumanReviewed: sourceHumanReviewed,
    },
    generation: {
      provider: result.provider,
      model: result.model,
      language: params.language,
      isMock,
      requestId: result.requestId,
      stopReason: result.stopReason,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    },
    scoringProfile: buildTopicScoringProfileSummary(),
    topicCatalog: params.run.topicPool,
    scoredTopics,
    ranking: {
      candidateCount: scoredTopics.length,
      rankedTopicIds: scoredTopics.map((topic) => topic.topicId),
      topTopicId: scoredTopics[0]?.topicId ?? null,
      advanceCount,
      needsHumanReviewCount,
      holdCount,
      rejectCount,
    },
    portfolioObservations: analysis.portfolioObservations,
    confidenceAdjustments,
    humanReview: {
      required: true,
      approved: false,
      selectedTopicIds: [],
      approvedBy: null,
      approvedAt: null,
      note: "Topic scores and rankings require human review before Asset Generation.",
    },
    dataQuality: {
      overallStatus: params.run.dataQuality.overallStatus,
      warnings: params.run.dataQuality.warnings,
      limitations: [...new Set([...params.run.dataQuality.limitations, ...analysis.portfolioObservations.majorLimitations])],
    },
  };
}
