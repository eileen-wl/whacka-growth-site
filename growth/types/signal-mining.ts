import { z } from "zod/v4";
import { isoTimestampSchema } from "../contracts/common";
import type { CampaignInfo, DateRange } from "./growth-summary";
import type { SupportedLanguage } from "./llm";
import type { SignalCandidate } from "../contracts/signal-candidate";
import type { TopicCandidate } from "../contracts/topic-candidate";

/**
 * Internal Signal Mining Agent input/output types. `SignalSourceRecord` is
 * an internal Agent input type — NOT a seventh public front-half contract.
 * The Agent's only public outputs are `SignalCandidate[]`/`TopicCandidate[]`
 * (growth/contracts/), validated against those contracts before being
 * written anywhere.
 */

const SHORT = 200;
const MEDIUM = 800;

// ---------------------------------------------------------------------------
// SignalSourceRecord — deterministic, concise evidence unit built from one
// of the local adapters (growth/signal-sources/). The catalog of these is
// the ONLY thing the model may cite (by id) when proposing a signal.
// ---------------------------------------------------------------------------

/**
 * Broader than SignalCandidate's public `source.type` enum on purpose: this
 * is an internal catalog, so it also covers `growth_loop_feedback` (an
 * instruction/constraint source, never measured evidence) and the two
 * manual-input-only types (`product_request`, `research_note`) that don't
 * have a public-contract equivalent. Contract assembly maps anything not in
 * the public enum to `type: "other"` + a specific `name`, per that
 * contract's own extensibility rule.
 */
export const signalSourceRecordTypeSchema = z.enum([
  "search_console",
  "posthog",
  "ga4",
  "user_feedback",
  "mentor_input",
  "competitor_page",
  "social_discussion",
  "keyword_source",
  "manual",
  "growth_loop_feedback",
  "product_request",
  "research_note",
  "other",
]);
export type SignalSourceRecordSourceType = z.infer<typeof signalSourceRecordTypeSchema>;

export interface SignalSourceRecordSource {
  type: SignalSourceRecordSourceType;
  name: string;
  recordId: string | null;
  url: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  isInternal: boolean;
}

export interface SignalSourceRecordMetric {
  name: string;
  value: number;
  unit: string | null;
  measurementBasis: string;
  period: string | null;
}

export interface SignalSourceRecordEntities {
  keywords: string[];
  topics: string[];
  audiences: string[];
  productsOrApps: string[];
  channels: string[];
}

export interface SignalSourceRecordReferences {
  evidenceRefs: string[];
  findingRefs: string[];
  limitationRefs: string[];
}

export interface SignalSourceRecordQuality {
  confidence: "high" | "medium" | "low";
  limitations: string[];
}

/** Internal Agent input type — never written to disk on its own as a public contract, only embedded in FinalSignalMiningRun.sourceRecordCatalog for traceability. */
export interface SignalSourceRecord {
  id: string;
  source: SignalSourceRecordSource;
  title: string;
  content: string;
  entities: SignalSourceRecordEntities;
  metrics: SignalSourceRecordMetric[];
  references: SignalSourceRecordReferences;
  quality: SignalSourceRecordQuality;
}

// ---------------------------------------------------------------------------
// Manual JSON input (--manual-input)
// ---------------------------------------------------------------------------

export const manualSourceTypeSchema = z.enum([
  "mentor_input",
  "user_feedback",
  "manual",
  "competitor_page",
  "social_discussion",
  "keyword_source",
  "product_request",
  "research_note",
]);
export type ManualSourceType = z.infer<typeof manualSourceTypeSchema>;

export const manualSignalMetricSchema = z.strictObject({
  name: z.string().min(1).max(120),
  value: z.number(),
  unit: z.union([z.string().min(1).max(40), z.null()]).optional(),
  measurementBasis: z.string().min(1).max(200).optional(),
  period: z.union([z.string().min(1).max(120), z.null()]).optional(),
});

/** One record in a `--manual-input` JSON file. See growth/data/manual/signal-input.example.json for a copyable template. */
export const manualSignalSourceRecordSchema = z.strictObject({
  id: z.string().min(1).max(160).optional(),
  sourceType: manualSourceTypeSchema,
  sourceName: z.string().min(1).max(160),
  title: z.string().min(1).max(300),
  text: z.string().min(1).max(4000),
  url: z.union([z.url(), z.null()]).optional(),
  publishedAt: z.union([isoTimestampSchema, z.null()]).optional(),
  capturedAt: isoTimestampSchema.optional(),
  tags: z.array(z.string().min(1).max(80)).max(30).optional(),
  metrics: z.array(manualSignalMetricSchema).max(30).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ManualSignalSourceRecord = z.infer<typeof manualSignalSourceRecordSchema>;

// ---------------------------------------------------------------------------
// Existing content catalog — built from the real src/data/apps.ts, never a
// hardcoded duplicate list. Used only to validate proposed topic
// relationships; the model may never invent an app slug outside this set.
// ---------------------------------------------------------------------------

export type ExistingContentCtaType = "view_demo" | "remix" | "build" | "copy_prompt";

export interface ExistingContentCatalogEntry {
  appSlug: string;
  appName: string;
  hook: string;
  status: string;
  route: string;
  availableCtaTypes: ExistingContentCtaType[];
}

// ---------------------------------------------------------------------------
// GrowthLoopFeedback context passed to the model (constraints/instructions
// only — not evidence, and not something the model cites by ID).
// ---------------------------------------------------------------------------

export interface SignalMiningFeedbackInstruction {
  destination: "signal_mining" | "topic_pool";
  instruction: string;
  topicOrApp: string | null;
  ctaType: string | null;
  channel: string | null;
}

export interface SignalMiningFeedbackContext {
  sourceDecisionSha256: string;
  decisionStatus: "proceed" | "defer";
  isMock: boolean;
  feedbackType: string;
  instructions: SignalMiningFeedbackInstruction[];
  constraints: {
    allowedTopics: string[];
    allowedCtaTypes: string[];
    allowedChannels: string[];
    mustCollectEvidence: boolean;
    mustNotClaim: string[];
  };
}

// ---------------------------------------------------------------------------
// Structured LLM analysis schema (zod v4). Cross-referential rules (every
// sourceRecordRef/signalProposalRef must exist, every relatedAppSlug must
// be a real app) are enforced in growth/agents/signal-mining-agent.ts.
// ---------------------------------------------------------------------------

const confidenceSchema = z.enum(["high", "medium", "low"]);
const shortText = z.string().min(1).max(SHORT);
const mediumText = z.string().min(1).max(MEDIUM);
const refId = z.string().min(1).max(160);
const temporaryId = z.string().min(1).max(60);

export const signalProposalTypeSchema = z.enum([
  "keyword",
  "user_need",
  "pain_point",
  "use_case",
  "competitor_pattern",
  "content_pattern",
  "product_request",
  "search_pattern",
  "engagement_pattern",
  "manual_input",
]);

const signalProposalEntitiesSchema = z.strictObject({
  keywords: z.array(shortText).max(20),
  topics: z.array(shortText).max(20),
  audiences: z.array(shortText).max(20),
  productsOrApps: z.array(shortText).max(20),
  channels: z.array(shortText).max(20),
});

const signalProposalQualitySchema = z.strictObject({
  confidence: confidenceSchema,
  freshness: z.enum(["current", "recent", "unknown", "stale"]),
  limitations: z.array(mediumText).max(10),
});

const signalProposalSchema = z.strictObject({
  temporaryId,
  signalType: signalProposalTypeSchema,
  title: shortText,
  summary: mediumText,
  evidenceExcerpt: z.union([mediumText, z.null()]),
  sourceRecordRefs: z.array(refId).min(1).max(20),
  entities: signalProposalEntitiesSchema,
  quality: signalProposalQualitySchema,
});

const topicRelationshipSchema = z.strictObject({
  status: z.enum(["new", "existing", "overlapping", "duplicate", "unknown"]),
  relatedAppSlugs: z.array(z.string().min(1).max(160)).max(10),
});

const topicClusterSchema = z.strictObject({
  temporaryId,
  canonicalName: shortText,
  slugSuggestion: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slugSuggestion must be lowercase kebab-case."),
  aliases: z.array(shortText).max(10),
  problemStatement: mediumText,
  targetAudience: z.array(shortText).min(1).max(10),
  useCases: z.array(shortText).max(10),
  desiredOutcome: mediumText,
  signalProposalRefs: z.array(temporaryId).min(1).max(30),
  relationshipToExistingContent: topicRelationshipSchema,
  confidence: confidenceSchema,
  limitations: z.array(mediumText).max(10),
});

const unresolvedSourceRecordSchema = z.strictObject({
  sourceRecordRef: refId,
  reason: z.enum(["insufficient_evidence", "ambiguous", "duplicate", "irrelevant", "unsupported"]),
  note: mediumText,
});

const analysisNotesSchema = z.strictObject({
  sourceCoverage: mediumText,
  majorLimitations: z.array(mediumText).max(10),
  requiresHumanReview: z.literal(true),
});

/** The model-generated portion of the run. See growth/agents/signal-mining-agent.ts for the cross-referential rules layered on top. */
export const signalMiningAnalysisSchema = z.strictObject({
  signalProposals: z.array(signalProposalSchema).max(100),
  topicClusters: z.array(topicClusterSchema).max(50),
  unresolvedSourceRecords: z.array(unresolvedSourceRecordSchema).max(150),
  analysisNotes: analysisNotesSchema,
});

export type SignalMiningAnalysis = z.infer<typeof signalMiningAnalysisSchema>;
export type SignalProposal = z.infer<typeof signalProposalSchema>;
export type TopicCluster = z.infer<typeof topicClusterSchema>;
export type UnresolvedSourceRecord = z.infer<typeof unresolvedSourceRecordSchema>;

// ---------------------------------------------------------------------------
// LLM request/response contracts
// ---------------------------------------------------------------------------

export interface SignalMiningLLMRequest {
  purpose: string;
  campaign: CampaignInfo;
  period: DateRange;
  language: SupportedLanguage;
  sourceRecordCatalog: SignalSourceRecord[];
  existingContentCatalog: ExistingContentCatalogEntry[];
  feedbackContext: SignalMiningFeedbackContext | null;
  dataQualityWarnings: string[];
  reportingRules: string[];
  responseSchemaDescription: string;
  maxTokens: number;
  systemPrompt: string;
  userPrompt: string;
}

// ---------------------------------------------------------------------------
// Final assembled run
// ---------------------------------------------------------------------------

export interface SignalMiningProvenance {
  sourceSummaryFilename: string | null;
  sourceSummarySha256: string | null;
  sourceFeedbackFilename: string | null;
  sourceFeedbackSha256: string | null;
  manualInputFilename: string | null;
  manualInputSha256: string | null;
  sourceFeedbackIsMock: boolean;
}

export interface SignalMiningGenerationMetadata {
  provider: string;
  model: string;
  language: SupportedLanguage;
  isMock: boolean;
  requestId: string | null;
  stopReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

export interface SourceSummaryMeta {
  recordsCollected: number;
  recordsUsed: number;
  recordsOmittedByLimit: number;
  sourceTypes: string[];
  warnings: string[];
}

export interface DeduplicationSummary {
  inputSignalProposalCount: number;
  finalSignalCount: number;
  duplicatesRemoved: number;
}

export interface SignalMiningHumanReview {
  required: true;
  approved: false;
  approvedBy: null;
  approvedAt: null;
  note: string;
}

export interface SignalMiningDataQuality {
  overallStatus: "complete" | "partial" | "invalid";
  warnings: string[];
  limitations: string[];
}

export interface UnresolvedSourceRecordEntry {
  sourceRecordRef: string;
  reason: string;
  note: string;
}

/** The on-disk shape written to growth/signals/signal-mining-{start}_to_{end}.json. */
export interface FinalSignalMiningRun {
  schemaVersion: "1.0.0";
  runType: "signal_mining";
  generatedAt: string;
  period: DateRange;
  campaign: CampaignInfo;
  provenance: SignalMiningProvenance;
  generation: SignalMiningGenerationMetadata;
  sourceSummary: SourceSummaryMeta;
  sourceRecordCatalog: SignalSourceRecord[];
  signals: SignalCandidate[];
  topicPool: TopicCandidate[];
  unresolvedSourceRecords: UnresolvedSourceRecordEntry[];
  deduplication: DeduplicationSummary;
  humanReview: SignalMiningHumanReview;
  dataQuality: SignalMiningDataQuality;
}

/** The on-disk shape written to growth/data/processed/signal-mining-request-{start}_to_{end}.json in --dry-run mode. Never includes secrets. */
export interface SignalMiningDryRunPreview {
  source: "signal_mining_dry_run";
  createdAt: string;
  period: DateRange;
  campaign: CampaignInfo;
  sourceSummaryFilename: string | null;
  sourceSummarySha256: string | null;
  sourceFeedbackFilename: string | null;
  sourceFeedbackSha256: string | null;
  manualInputFilename: string | null;
  manualInputSha256: string | null;
  sourceRecordCatalog: SignalSourceRecord[];
  existingContentCatalog: ExistingContentCatalogEntry[];
  feedbackContext: SignalMiningFeedbackContext | null;
  dataQualityWarnings: string[];
  language: SupportedLanguage;
  intendedProvider: string;
  intendedModel: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchemaDescription: string;
}
