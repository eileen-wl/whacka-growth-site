import { slugify } from "../lib/ids";
import { buildSignalMiningLLMRequest } from "../prompts/signal-mining-prompt";
import { signalMiningAnalysisSchema } from "../types/signal-mining";
import { buildSignalCandidateId, validateSignalCandidate } from "../contracts/signal-candidate";
import { buildTopicCandidateId, validateTopicCandidate } from "../contracts/topic-candidate";
import type { SignalMiningProvider } from "../llm/signal-mining-provider";
import type { GrowthLoopFeedback } from "../contracts/loop-feedback";
import type { SignalCandidate } from "../contracts/signal-candidate";
import type { TopicCandidate } from "../contracts/topic-candidate";
import type { CampaignInfo, DateRange } from "../types/growth-summary";
import type { SupportedLanguage } from "../types/llm";
import type {
  ExistingContentCatalogEntry,
  FinalSignalMiningRun,
  SignalMiningAnalysis,
  SignalMiningFeedbackContext,
  SignalProposal,
  SignalSourceRecord,
  SignalSourceRecordSourceType,
  TopicCluster,
} from "../types/signal-mining";

export class SignalMiningValidationError extends Error {}

// ---------------------------------------------------------------------------
// Source-record limiting
// ---------------------------------------------------------------------------

/** Sum of the absolute value of every metric on a record — a deterministic, content-derived "volume" proxy used only to pick which records survive a limit, never to alter a metric. */
export function computeRecordVolume(record: SignalSourceRecord): number {
  return record.metrics.reduce((sum, metric) => sum + Math.abs(metric.value), 0);
}

export interface SourceRecordLimitResult {
  used: SignalSourceRecord[];
  omittedCount: number;
}

/** Deterministically truncates to `maxRecords`: higher-volume records survive first, ties broken by `id` ascending — never by array order alone. */
export function applySourceRecordLimit(records: SignalSourceRecord[], maxRecords: number): SourceRecordLimitResult {
  if (records.length <= maxRecords) {
    return { used: records, omittedCount: 0 };
  }
  const sorted = [...records].sort((a, b) => {
    const volumeDiff = computeRecordVolume(b) - computeRecordVolume(a);
    if (volumeDiff !== 0) return volumeDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { used: sorted.slice(0, maxRecords), omittedCount: records.length - maxRecords };
}

// ---------------------------------------------------------------------------
// GrowthLoopFeedback -> LLM-facing context (constraints/instructions only —
// never treated as a source record the model cites as evidence).
// ---------------------------------------------------------------------------

export function buildSignalMiningFeedbackContext(feedback: GrowthLoopFeedback | null): SignalMiningFeedbackContext | null {
  if (!feedback) return null;
  return {
    sourceDecisionSha256: feedback.sourceDecision.sha256,
    decisionStatus: feedback.sourceDecision.decisionStatus,
    isMock: feedback.sourceDecision.isMock,
    feedbackType: feedback.feedbackType,
    instructions: feedback.instructions.map((instruction) => ({
      destination: instruction.destination,
      instruction: instruction.instruction,
      topicOrApp: instruction.topicOrApp,
      ctaType: instruction.ctaType,
      channel: instruction.channel,
    })),
    constraints: { ...feedback.constraints },
  };
}

// ---------------------------------------------------------------------------
// Structured-output validation
// ---------------------------------------------------------------------------

/**
 * Validates a provider's raw response before it's trusted downstream:
 * (1) the static Zod schema (re-checked for every provider, since the Mock
 * Provider skips the Anthropic SDK's own client-side parsing);
 * (2) cross-referential rules the static schema can't express — every
 * sourceRecordRef must exist in the supplied source record catalog, every
 * temporaryId must be unique within its own array, every topic's
 * signalProposalRefs must resolve to a real signal proposal, and every
 * relatedAppSlug must exist in the supplied existing content catalog (the
 * model may never invent an app slug). Throws SignalMiningValidationError
 * on any failure — callers must not assemble or write a final run when
 * this throws.
 */
export function validateSignalMiningAnalysis(
  rawData: unknown,
  sourceRecordCatalog: SignalSourceRecord[],
  existingContentCatalog: ExistingContentCatalogEntry[]
): SignalMiningAnalysis {
  const parsed = signalMiningAnalysisSchema.safeParse(rawData);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new SignalMiningValidationError(`Model response did not match the required schema: ${issues.join("; ")}`);
  }
  const analysis = parsed.data;

  const sourceRecordIds = new Set(sourceRecordCatalog.map((record) => record.id));
  const appSlugs = new Set(existingContentCatalog.map((entry) => entry.appSlug));

  const seenSignalTempIds = new Set<string>();
  for (const proposal of analysis.signalProposals) {
    if (seenSignalTempIds.has(proposal.temporaryId)) {
      throw new SignalMiningValidationError(`Duplicate signalProposals.temporaryId "${proposal.temporaryId}".`);
    }
    seenSignalTempIds.add(proposal.temporaryId);

    const unknownRefs = proposal.sourceRecordRefs.filter((ref) => !sourceRecordIds.has(ref));
    if (unknownRefs.length > 0) {
      throw new SignalMiningValidationError(
        `signalProposals["${proposal.temporaryId}"] references unknown sourceRecordRef(s): ${unknownRefs.join(", ")}.`
      );
    }
  }

  const seenTopicTempIds = new Set<string>();
  for (const cluster of analysis.topicClusters) {
    if (seenTopicTempIds.has(cluster.temporaryId)) {
      throw new SignalMiningValidationError(`Duplicate topicClusters.temporaryId "${cluster.temporaryId}".`);
    }
    seenTopicTempIds.add(cluster.temporaryId);

    const unknownSignalRefs = cluster.signalProposalRefs.filter((ref) => !seenSignalTempIds.has(ref));
    if (unknownSignalRefs.length > 0) {
      throw new SignalMiningValidationError(
        `topicClusters["${cluster.temporaryId}"] references unknown signalProposalRef(s): ${unknownSignalRefs.join(", ")}.`
      );
    }

    const unknownSlugs = cluster.relationshipToExistingContent.relatedAppSlugs.filter((slug) => !appSlugs.has(slug));
    if (unknownSlugs.length > 0) {
      throw new SignalMiningValidationError(
        `topicClusters["${cluster.temporaryId}"] references unknown app slug(s): ${unknownSlugs.join(", ")}. Only existing-content-catalog app slugs are allowed.`
      );
    }
  }

  for (const entry of analysis.unresolvedSourceRecords) {
    if (!sourceRecordIds.has(entry.sourceRecordRef)) {
      throw new SignalMiningValidationError(`unresolvedSourceRecords references unknown sourceRecordRef "${entry.sourceRecordRef}".`);
    }
  }

  return analysis;
}

// ---------------------------------------------------------------------------
// SignalCandidate assembly
// ---------------------------------------------------------------------------

const PUBLIC_SOURCE_TYPES = new Set([
  "search_console",
  "posthog",
  "ga4",
  "user_feedback",
  "mentor_input",
  "competitor_page",
  "social_discussion",
  "keyword_source",
  "manual",
  "other",
]);

/** Anything outside SignalCandidate's closed public `source.type` enum (growth_loop_feedback, product_request, research_note) maps to `"other"`, per that contract's own extensibility rule — `source.name` is always already specific in these cases. */
function toPublicSourceType(type: SignalSourceRecordSourceType): SignalCandidate["source"]["type"] {
  return (PUBLIC_SOURCE_TYPES.has(type) ? type : "other") as SignalCandidate["source"]["type"];
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

/**
 * SignalCandidate.source is a single block, but a proposal may cite several
 * source records. A single citation maps its source through unchanged; a
 * multi-citation synthesizes one combined descriptor (see growth/contracts/README.md's
 * "AssetBundle vs CMSWriteRequest"-style precedent for this kind of
 * many-to-one mapping) while `provenance.sourceRecordIds` on the assembled
 * SignalCandidate still preserves every individual source record id — no
 * source is lost, only the single required `source` block is synthesized.
 */
function buildSourceBlockForProposal(citedRecords: SignalSourceRecord[]): SignalCandidate["source"] {
  if (citedRecords.length === 1) {
    const record = citedRecords[0];
    return {
      type: toPublicSourceType(record.source.type),
      name: record.source.name,
      recordId: record.source.recordId,
      url: record.source.url,
      publishedAt: record.source.publishedAt,
      retrievedAt: record.source.retrievedAt,
      isInternal: record.source.isInternal,
    };
  }

  const names = [...new Set(citedRecords.map((record) => record.source.name))];
  const types = [...new Set(citedRecords.map((record) => record.source.type))];
  const latestRetrievedAt = [...citedRecords.map((record) => record.source.retrievedAt)].sort().at(-1)!;
  const singleType = types.length === 1 ? types[0] : "other";

  return {
    type: toPublicSourceType(singleType),
    name: truncate(`Combined sources: ${names.join(", ")}`, 160),
    recordId: null,
    url: null,
    publishedAt: null,
    retrievedAt: latestRetrievedAt,
    isInternal: true,
  };
}

/**
 * Maps the mining-specific `signalType` vocabulary (growth/types/signal-mining.ts,
 * richer/mining-oriented) onto SignalCandidate's stable public vocabulary
 * (growth/contracts/signal-candidate.ts). Documented once, here, rather than
 * changed silently: "pain_point" is exact; "keyword"/"search_pattern" ->
 * "search_query"; "user_need"/"use_case"/"product_request" -> "feature_request";
 * "competitor_pattern" -> "competitor_gap"; "content_pattern"/"engagement_pattern"
 * -> "trending_topic"; "manual_input" (mentor/user-feedback/manual/etc.) ->
 * "other", since that vocabulary doesn't map cleanly onto one public category.
 */
function mapProposalSignalType(signalType: SignalProposal["signalType"]): SignalCandidate["signalType"] {
  switch (signalType) {
    case "pain_point":
      return "pain_point";
    case "keyword":
    case "search_pattern":
      return "search_query";
    case "user_need":
    case "use_case":
    case "product_request":
      return "feature_request";
    case "competitor_pattern":
      return "competitor_gap";
    case "content_pattern":
    case "engagement_pattern":
      return "trending_topic";
    case "manual_input":
    default:
      return "other";
  }
}

function mapFreshness(freshness: SignalProposal["quality"]["freshness"]): SignalCandidate["quality"]["freshness"] {
  return freshness === "current" ? "fresh" : freshness;
}

/**
 * Maps the mining-specific relationship vocabulary (growth/types/signal-mining.ts:
 * "new"|"existing"|"overlapping"|"duplicate"|"unknown") onto TopicCandidate's
 * public vocabulary (growth/contracts/topic-candidate.ts:
 * "new"|"related_to_existing_topic"|"related_to_existing_app"|"duplicate").
 * "existing"/"overlapping" both map to "related_to_existing_app" — the only
 * concrete link this Agent can establish is to a real app slug (there is no
 * existing TopicCandidate pool to compare against yet, so
 * "related_to_existing_topic" is never produced here). "unknown" maps to
 * "new" (the most neutral default) — the cluster's own `needsReview` flag
 * (set whenever the mining-specific status was "unknown") is what actually
 * signals a human should double-check the relationship, not this field.
 */
function mapRelationshipStatus(
  status: TopicCluster["relationshipToExistingContent"]["status"]
): TopicCandidate["relationshipToExistingContent"]["status"] {
  switch (status) {
    case "duplicate":
      return "duplicate";
    case "existing":
    case "overlapping":
      return "related_to_existing_app";
    case "new":
    case "unknown":
    default:
      return "new";
  }
}

export interface SignalCandidateAssemblyProvenance {
  sourceFileNames: string[];
  sourceHashes: string[];
  provider: string;
  model: string;
  isMock: boolean;
}

export interface AssembleSignalCandidatesParams {
  analysis: SignalMiningAnalysis;
  sourceRecordCatalog: SignalSourceRecord[];
  campaignId: string;
  capturedAt: string;
  feedbackId: string | null;
  provenance: SignalCandidateAssemblyProvenance;
}

export interface AssembledSignalCandidates {
  signals: SignalCandidate[];
  /** Maps every signalProposals[].temporaryId (including ones collapsed as duplicates) to its final, surviving SignalCandidate id. */
  temporaryIdToFinalId: Map<string, string>;
  inputSignalProposalCount: number;
  duplicatesRemoved: number;
}

/**
 * Deterministically builds SignalCandidate contracts from a validated
 * SignalMiningAnalysis, then deduplicates them. Deduplication uses only
 * deterministic exact/normalized checks — identical deterministic id,
 * normalized (slugified) title match, or an identical sorted
 * source-record-ref set — never semantic merging beyond what the provider's
 * own topic clustering already did.
 */
export function assembleSignalCandidates(params: AssembleSignalCandidatesParams): AssembledSignalCandidates {
  const recordsById = new Map(params.sourceRecordCatalog.map((record) => [record.id, record]));

  const built: { proposal: SignalProposal; candidate: SignalCandidate }[] = [];

  for (const proposal of params.analysis.signalProposals) {
    const cited = proposal.sourceRecordRefs.map((ref) => recordsById.get(ref)!);
    const source = buildSourceBlockForProposal(cited);
    const metrics = cited.flatMap((record) => record.metrics);
    const sourceRecordIds = [...new Set(proposal.sourceRecordRefs)].sort();
    const hasFeedbackSource = cited.some((record) => record.source.type === "growth_loop_feedback");

    const candidate: SignalCandidate = {
      schemaVersion: "1.0.0",
      id: buildSignalCandidateId({
        sourceType: source.type,
        sourceName: source.name,
        sourceRecordId: sourceRecordIds.join("|"),
        title: proposal.title,
      }),
      campaignId: params.campaignId,
      capturedAt: params.capturedAt,
      source,
      signalType: mapProposalSignalType(proposal.signalType),
      title: proposal.title,
      summary: proposal.summary,
      evidenceExcerpt: proposal.evidenceExcerpt,
      entities: proposal.entities,
      metrics,
      quality: {
        confidence: proposal.quality.confidence,
        freshness: mapFreshness(proposal.quality.freshness),
        duplicateStatus: "unique",
        limitations: proposal.quality.limitations,
      },
      humanReviewRequired: true,
      provenance: {
        generatedBy: "signal-mining-agent",
        sourceFileNames: params.provenance.sourceFileNames,
        sourceHashes: params.provenance.sourceHashes,
        sourceRecordIds,
        sourceDecisionId: hasFeedbackSource ? params.feedbackId : null,
        provider: params.provenance.provider,
        model: params.provenance.model,
        isMock: params.provenance.isMock,
        humanReviewed: false,
      },
    };

    validateSignalCandidate(candidate);
    built.push({ proposal, candidate });
  }

  const finalByKey = new Map<string, SignalCandidate>();
  const temporaryIdToFinalId = new Map<string, string>();
  let duplicatesRemoved = 0;

  for (const { proposal, candidate } of built) {
    const normalizedTitle = slugify(candidate.title);
    const sortedRefs = [...proposal.sourceRecordRefs].sort().join("|");
    const dedupeKeys = [`id:${candidate.id}`, `title:${normalizedTitle}`, `refs:${sortedRefs}`];

    const existing = dedupeKeys.map((key) => finalByKey.get(key)).find((entry) => entry !== undefined);

    if (existing) {
      duplicatesRemoved += 1;
      temporaryIdToFinalId.set(proposal.temporaryId, existing.id);
      continue;
    }

    for (const key of dedupeKeys) finalByKey.set(key, candidate);
    temporaryIdToFinalId.set(proposal.temporaryId, candidate.id);
  }

  const uniqueById = new Map<string, SignalCandidate>();
  for (const candidate of finalByKey.values()) uniqueById.set(candidate.id, candidate);

  return {
    signals: [...uniqueById.values()],
    temporaryIdToFinalId,
    inputSignalProposalCount: built.length,
    duplicatesRemoved,
  };
}

// ---------------------------------------------------------------------------
// TopicCandidate assembly
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 } as const;

export interface AssembleTopicCandidatesParams {
  analysis: SignalMiningAnalysis;
  temporaryIdToFinalId: Map<string, string>;
  signalsById: Map<string, SignalCandidate>;
  sourceRecordsById: Map<string, SignalSourceRecord>;
  campaignId: string;
  createdAt: string;
  provenance: SignalCandidateAssemblyProvenance;
}

/**
 * Deterministically builds TopicCandidate contracts from a validated
 * SignalMiningAnalysis. Never assigns "rejected" or "archived" — status is
 * only ever "candidate" or "needs_review" (needs_review when the cluster's
 * own confidence is "low", or its relationship to existing content is
 * "duplicate"/"overlapping"/"unknown").
 */
export function assembleTopicCandidates(params: AssembleTopicCandidatesParams): TopicCandidate[] {
  const topics: TopicCandidate[] = [];

  for (const cluster of params.analysis.topicClusters) {
    const finalSignalIds = [...new Set(cluster.signalProposalRefs.map((ref) => params.temporaryIdToFinalId.get(ref)!))];
    const signals = finalSignalIds.map((id) => params.signalsById.get(id)!);

    const sourceRecordIdSet = new Set<string>();
    for (const signal of signals) for (const recordId of signal.provenance.sourceRecordIds) sourceRecordIdSet.add(recordId);

    const sourceTypeSet = new Set<string>();
    for (const recordId of sourceRecordIdSet) {
      const record = params.sourceRecordsById.get(recordId);
      if (record) sourceTypeSet.add(record.source.type);
    }

    const worstConfidence = signals.reduce<"high" | "medium" | "low">(
      (acc, signal) => (CONFIDENCE_RANK[signal.quality.confidence] < CONFIDENCE_RANK[acc] ? signal.quality.confidence : acc),
      "high"
    );

    const limitations = [...new Set([...cluster.limitations, ...signals.flatMap((signal) => signal.quality.limitations)])];

    const needsReview =
      cluster.confidence === "low" || ["duplicate", "overlapping", "unknown"].includes(cluster.relationshipToExistingContent.status);

    const topic: TopicCandidate = {
      schemaVersion: "1.0.0",
      id: buildTopicCandidateId({ campaignId: params.campaignId, canonicalName: cluster.canonicalName }),
      campaignId: params.campaignId,
      createdAt: params.createdAt,
      canonicalName: cluster.canonicalName,
      slug: cluster.slugSuggestion,
      aliases: cluster.aliases,
      problemStatement: cluster.problemStatement,
      targetAudience: cluster.targetAudience.join("; "),
      useCases: cluster.useCases,
      desiredOutcome: cluster.desiredOutcome,
      signalRefs: finalSignalIds,
      evidenceSummary: {
        signalCount: finalSignalIds.length,
        sourceCount: sourceRecordIdSet.size,
        sourceTypes: [...sourceTypeSet],
        confidence: worstConfidence,
        limitations,
      },
      relationshipToExistingContent: {
        status: mapRelationshipStatus(cluster.relationshipToExistingContent.status),
        relatedTopicIds: [],
        relatedAppSlugs: cluster.relationshipToExistingContent.relatedAppSlugs,
      },
      status: needsReview ? "needs_review" : "candidate",
      rejection: null,
      provenance: {
        generatedBy: "signal-mining-agent",
        sourceFileNames: params.provenance.sourceFileNames,
        sourceHashes: params.provenance.sourceHashes,
        sourceRecordIds: finalSignalIds,
        sourceDecisionId: null,
        provider: params.provenance.provider,
        model: params.provenance.model,
        isMock: params.provenance.isMock,
        humanReviewed: false,
      },
    };

    validateTopicCandidate(topic);
    topics.push(topic);
  }

  return topics;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunSignalMiningAgentProvenanceInput {
  sourceSummaryFilename: string | null;
  sourceSummarySha256: string | null;
  sourceFeedbackFilename: string | null;
  sourceFeedbackSha256: string | null;
  manualInputFilename: string | null;
  manualInputSha256: string | null;
}

export interface RunSignalMiningAgentParams {
  campaign: CampaignInfo;
  period: DateRange;
  language: SupportedLanguage;
  maxTokens: number;
  maxSourceRecords: number;
  provider: SignalMiningProvider;
  /** Already collected from every adapter, NOT yet limited — the agent applies the max-records limit itself so `sourceSummary` bookkeeping stays in one place. */
  sourceRecordCatalog: SignalSourceRecord[];
  existingContentCatalog: ExistingContentCatalogEntry[];
  feedback: GrowthLoopFeedback | null;
  dataQualityWarnings: string[];
  dataQualityStatus: "complete" | "partial" | "invalid";
  provenance: RunSignalMiningAgentProvenanceInput;
  /** Injectable for deterministic tests; defaults to the current time. */
  generatedAt?: string;
}

/**
 * Runs the full Signal Mining Agent pipeline against already-loaded,
 * already-validated inputs: apply the source-record limit, build the LLM
 * request, call the given provider, validate the response, and assemble the
 * final SignalCandidate[]/TopicCandidate[] contracts. Depends only on the
 * provider-neutral SignalMiningProvider interface — never imports an SDK
 * directly.
 */
export async function runSignalMiningAgent(params: RunSignalMiningAgentParams): Promise<FinalSignalMiningRun> {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const { used: limitedCatalog, omittedCount } = applySourceRecordLimit(params.sourceRecordCatalog, params.maxSourceRecords);

  const feedbackContext = buildSignalMiningFeedbackContext(params.feedback);

  const request = buildSignalMiningLLMRequest({
    campaign: params.campaign,
    period: params.period,
    language: params.language,
    sourceRecordCatalog: limitedCatalog,
    existingContentCatalog: params.existingContentCatalog,
    feedbackContext,
    dataQualityWarnings: params.dataQualityWarnings,
    maxTokens: params.maxTokens,
  });

  const result = await params.provider.generateStructuredSignals(request);
  const analysis = validateSignalMiningAnalysis(result.data, limitedCatalog, params.existingContentCatalog);

  const isMock = params.provider.name === "mock";
  const sourceFileNames = [params.provenance.sourceSummaryFilename, params.provenance.sourceFeedbackFilename, params.provenance.manualInputFilename].filter(
    (value): value is string => value !== null
  );
  const sourceHashes = [params.provenance.sourceSummarySha256, params.provenance.sourceFeedbackSha256, params.provenance.manualInputSha256].filter(
    (value): value is string => value !== null
  );
  const assemblyProvenance: SignalCandidateAssemblyProvenance = {
    sourceFileNames,
    sourceHashes,
    provider: result.provider,
    model: result.model,
    isMock,
  };

  const { signals, temporaryIdToFinalId, inputSignalProposalCount, duplicatesRemoved } = assembleSignalCandidates({
    analysis,
    sourceRecordCatalog: limitedCatalog,
    campaignId: params.campaign.id,
    capturedAt: generatedAt,
    feedbackId: params.feedback?.id ?? null,
    provenance: assemblyProvenance,
  });

  const signalsById = new Map(signals.map((signal) => [signal.id, signal]));
  const sourceRecordsById = new Map(limitedCatalog.map((record) => [record.id, record]));

  const topicPool = assembleTopicCandidates({
    analysis,
    temporaryIdToFinalId,
    signalsById,
    sourceRecordsById,
    campaignId: params.campaign.id,
    createdAt: generatedAt,
    provenance: assemblyProvenance,
  });

  for (const topic of topicPool) {
    for (const ref of topic.signalRefs) {
      if (!signalsById.has(ref)) {
        throw new SignalMiningValidationError(
          `Assembled TopicCandidate "${topic.id}" has a signalRef "${ref}" that does not point to any signal in this run's output.`
        );
      }
    }
  }

  const sourceTypes = [...new Set(limitedCatalog.map((record) => record.source.type))];

  return {
    schemaVersion: "1.0.0",
    runType: "signal_mining",
    generatedAt,
    period: params.period,
    campaign: params.campaign,
    provenance: {
      sourceSummaryFilename: params.provenance.sourceSummaryFilename,
      sourceSummarySha256: params.provenance.sourceSummarySha256,
      sourceFeedbackFilename: params.provenance.sourceFeedbackFilename,
      sourceFeedbackSha256: params.provenance.sourceFeedbackSha256,
      manualInputFilename: params.provenance.manualInputFilename,
      manualInputSha256: params.provenance.manualInputSha256,
      sourceFeedbackIsMock: params.feedback?.sourceDecision.isMock ?? false,
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
    sourceSummary: {
      recordsCollected: params.sourceRecordCatalog.length,
      recordsUsed: limitedCatalog.length,
      recordsOmittedByLimit: omittedCount,
      sourceTypes,
      warnings: params.dataQualityWarnings,
    },
    sourceRecordCatalog: limitedCatalog,
    signals,
    topicPool,
    unresolvedSourceRecords: analysis.unresolvedSourceRecords.map((entry) => ({
      sourceRecordRef: entry.sourceRecordRef,
      reason: entry.reason,
      note: entry.note,
    })),
    deduplication: {
      inputSignalProposalCount,
      finalSignalCount: signals.length,
      duplicatesRemoved,
    },
    humanReview: {
      required: true,
      approved: false,
      approvedBy: null,
      approvedAt: null,
      note: "Signal and topic candidates must be reviewed before Topic Scoring.",
    },
    dataQuality: {
      overallStatus: params.dataQualityStatus,
      warnings: params.dataQualityWarnings,
      limitations: [...new Set(topicPool.flatMap((topic) => topic.evidenceSummary.limitations))],
    },
  };
}
