import { z } from "zod/v4";
import type { CampaignInfo, DateRange } from "./growth-summary";
import type { EvidenceEntry, FinalGrowthReport, ReportMetricsSnapshot } from "./growth-report";
import type { SupportedLanguage } from "./llm";

// ---------------------------------------------------------------------------
// Structured LLM analysis schema (zod v4 — see growth/types/growth-report.ts
// for why v4 specifically). Cross-referential rules that can't be expressed
// in a static JSON schema — evidence/finding/limitation reference existence,
// proceed/defer field pairing, rank sequencing, target-scope membership —
// are enforced in growth/agents/experiment-decision-agent.ts, not here.
// ---------------------------------------------------------------------------

const SHORT = 160;
const MEDIUM = 600;
const ID_LEN = 80;

const confidence = z.enum(["high", "medium", "low"]);
const decisionStatus = z.enum(["proceed", "defer"]);
const lever = z.enum(["topic", "cta", "channel"]);
const ctaType = z.enum(["view_demo", "remix", "build", "copy_prompt"]);
const expectedDirection = z.enum(["increase", "decrease", "maintain"]);
const handoffDestination = z.enum(["signal_mining", "topic_pool", "asset_generation", "manual_review"]);

const refId = z.string().min(1).max(ID_LEN);
const shortText = z.string().min(1).max(SHORT);
const mediumText = z.string().min(1).max(MEDIUM);
const nullableShortText = z.union([shortText, z.null()]);

const targetSchema = z.strictObject({
  topicOrApp: nullableShortText,
  ctaType: z.union([ctaType, z.null()]),
  channel: nullableShortText,
});

const optionMeasurementPlanSchema = z.strictObject({
  primaryMetricRef: refId,
  expectedDirection,
  successCriterion: mediumText,
  guardrailMetricRefs: z.array(refId).max(10),
  measurementCaveats: z.array(mediumText).max(5),
});

const rankedExperimentOptionSchema = z.strictObject({
  id: z.string().min(1).max(60),
  rank: z.number().int().min(1),
  lever,
  title: shortText,
  target: targetSchema,
  hypothesis: mediumText,
  proposedChange: mediumText,
  controlDescription: mediumText,
  variantDescription: mediumText,
  measurementPlan: optionMeasurementPlanSchema,
  evidenceRefs: z.array(refId).min(1).max(10),
  findingRefs: z.array(refId).max(10),
  limitationRefs: z.array(refId).max(10),
  confidence,
  dependencies: z.array(mediumText).max(5),
  risks: z.array(mediumText).max(5),
  whyNotHigherRanked: z.union([mediumText, z.null()]),
});

const decisionSummarySchema = z.strictObject({
  decisionStatus,
  headline: shortText,
  rationale: mediumText,
  confidence,
  recommendedExperimentId: z.union([z.string().min(1).max(60), z.null()]),
});

const implementationBriefSchema = z.strictObject({
  change: mediumText,
  unchangedElements: z.array(mediumText).max(10),
  targetPagesOrApps: z.array(shortText).max(10),
  targetCta: z.union([ctaType, z.null()]),
  targetChannel: nullableShortText,
});

const recommendedMeasurementPlanSchema = z.strictObject({
  primaryMetricRef: refId,
  secondaryMetricRefs: z.array(refId).max(10),
  guardrailMetricRefs: z.array(refId).max(10),
  successCriterion: mediumText,
  failureCriterion: mediumText,
  minimumObservationRequirement: mediumText,
  knownMeasurementLimitations: z.array(mediumText).max(10),
});

const recommendedExperimentSchema = z.strictObject({
  experimentId: z.string().min(1).max(60),
  objective: mediumText,
  hypothesis: mediumText,
  implementationBrief: implementationBriefSchema,
  measurementPlan: recommendedMeasurementPlanSchema,
  evidenceRefs: z.array(refId).min(1).max(10),
  findingRefs: z.array(refId).max(10),
  confidence,
});

const requiredNextObservationSchema = z.strictObject({
  observation: mediumText,
  relatedEvidenceOrLimitationRefs: z.array(refId).max(10),
});

const deferDecisionSchema = z.strictObject({
  reason: mediumText,
  missingEvidence: z.array(mediumText).min(1).max(10),
  requiredNextObservations: z.array(requiredNextObservationSchema).min(1).max(10),
  earliestDecisionCondition: mediumText,
});

const rejectedOrDeferredOptionSchema = z.strictObject({
  title: shortText,
  reason: mediumText,
  evidenceRefs: z.array(refId).max(10),
  limitationRefs: z.array(refId).max(10),
});

const handoffItemSchema = z.strictObject({
  item: mediumText,
  destination: handoffDestination,
  reason: mediumText,
});

const handoffSchema = z.strictObject({
  forNextLoop: z.array(handoffItemSchema).max(10),
  humanReviewRequired: z.boolean(),
});

/** The model-generated portion of the decision. See growth/agents/experiment-decision-agent.ts for the cross-referential rules layered on top. */
export const experimentDecisionAnalysisSchema = z.strictObject({
  decisionSummary: decisionSummarySchema,
  rankedExperimentOptions: z.array(rankedExperimentOptionSchema).max(5),
  recommendedExperiment: z.union([recommendedExperimentSchema, z.null()]),
  deferDecision: z.union([deferDecisionSchema, z.null()]),
  rejectedOrDeferredOptions: z.array(rejectedOrDeferredOptionSchema).max(10),
  handoff: handoffSchema,
});

export type ExperimentDecisionAnalysis = z.infer<typeof experimentDecisionAnalysisSchema>;
export type RankedExperimentOption = z.infer<typeof rankedExperimentOptionSchema>;
export type RecommendedExperiment = z.infer<typeof recommendedExperimentSchema>;
export type DeferDecision = z.infer<typeof deferDecisionSchema>;
export type RejectedOrDeferredOption = z.infer<typeof rejectedOrDeferredOptionSchema>;
export type DecisionConfidence = z.infer<typeof confidence>;
export type DecisionStatus = z.infer<typeof decisionStatus>;
export type CtaType = z.infer<typeof ctaType>;

// ---------------------------------------------------------------------------
// Deterministic catalogs (built from the source Growth Report; never
// invented by the model)
// ---------------------------------------------------------------------------

/** id is `finding.{growthReportFindingId}`. Deterministic — never invented by the model. */
export interface FindingCatalogEntry {
  id: string;
  title: string;
  observation: string;
  interpretation: string;
  evidenceRefs: string[];
  confidence: string;
}

/** id is `data_limit.{slug}`. Deterministic — never invented by the model. */
export interface LimitationCatalogEntry {
  id: string;
  title: string;
  impact: string;
  relatedEvidenceRefs: string[];
}

/** Only entities actually observed in the source Growth Report — Signal Mining, not this Agent, discovers new topics/channels. */
export interface DecisionScope {
  availableTopics: string[];
  availableCtaTypes: CtaType[];
  availableChannels: string[];
}

// ---------------------------------------------------------------------------
// LLM request/response contracts
// ---------------------------------------------------------------------------

export interface ExperimentDecisionContext {
  period: DateRange;
  campaign: CampaignInfo;
  sourceReportFilename: string;
  sourceReportSha256: string;
  sourceReportGeneratedAt: string;
  sourceReportProvider: string;
  sourceReportModel: string;
  sourceReportIsMock: boolean;
  metrics: ReportMetricsSnapshot;
  evidenceCatalog: EvidenceEntry[];
  findingCatalog: FindingCatalogEntry[];
  limitationCatalog: LimitationCatalogEntry[];
  decisionScope: DecisionScope;
  dataQualityStatus: "complete" | "partial" | "invalid";
  dataQualityWarnings: string[];
  measurementNotes: string[];
}

export interface ExperimentDecisionLLMRequest {
  purpose: string;
  language: SupportedLanguage;
  context: ExperimentDecisionContext;
  reportingRules: string[];
  responseSchemaDescription: string;
  maxTokens: number;
  systemPrompt: string;
  userPrompt: string;
}

// ---------------------------------------------------------------------------
// Final assembled decision
// ---------------------------------------------------------------------------

export interface DecisionProvenance {
  sourceGrowthReportFilename: string;
  sourceGrowthReportSha256: string;
  sourceGrowthReportGeneratedAt: string;
  sourceGrowthReportProvider: string;
  sourceGrowthReportModel: string;
  sourceGrowthReportIsMock: boolean;
  sourceDataQualityStatus: "complete" | "partial" | "invalid";
}

export interface DecisionGenerationMetadata {
  provider: string;
  model: string;
  language: SupportedLanguage;
  isMock: boolean;
  requestId: string | null;
  stopReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

export interface HumanReview {
  required: true;
  approved: false;
  approvedBy: null;
  approvedAt: null;
  note: string;
}

/** The on-disk shape written to growth/decisions/experiment-decision-{start}_to_{end}.json. */
export interface FinalExperimentDecision {
  schemaVersion: "1.0.0";
  decisionType: "experiment_decision";
  generatedAt: string;
  period: DateRange;
  campaign: CampaignInfo;
  provenance: DecisionProvenance;
  generation: DecisionGenerationMetadata;
  decisionScope: DecisionScope;
  evidenceCatalog: EvidenceEntry[];
  findingCatalog: FindingCatalogEntry[];
  limitationCatalog: LimitationCatalogEntry[];
  decision: ExperimentDecisionAnalysis;
  humanReview: HumanReview;
  dataQuality: FinalGrowthReport["dataQuality"];
}

/** The on-disk shape written to growth/data/processed/experiment-decision-request-{start}_to_{end}.json in --dry-run mode. Never includes secrets. */
export interface DryRunDecisionRequestPreview {
  source: "experiment_decision_dry_run";
  createdAt: string;
  sourceGrowthReportFilename: string;
  sourceGrowthReportSha256: string;
  sourceGrowthReportIsMock: boolean;
  period: DateRange;
  campaign: CampaignInfo;
  language: SupportedLanguage;
  intendedProvider: string;
  intendedModel: string;
  decisionScope: DecisionScope;
  evidenceCatalog: EvidenceEntry[];
  findingCatalog: FindingCatalogEntry[];
  limitationCatalog: LimitationCatalogEntry[];
  systemPrompt: string;
  userPrompt: string;
  responseSchemaDescription: string;
}
