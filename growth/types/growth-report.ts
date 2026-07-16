import { z } from "zod/v4";
import type { CampaignInfo, DateRange, GrowthSummary } from "./growth-summary";
import type { SupportedLanguage } from "./llm";

export type { LLMStructuredResult, SupportedLanguage } from "./llm";

// ---------------------------------------------------------------------------
// Structured LLM analysis schema (zod v4 — required by @anthropic-ai/sdk's
// zodOutputFormat helper, which builds its JSON schema from a v4 ZodType).
// Cross-referential rules that can't be expressed in a static JSON schema —
// "every evidenceRefs value must exist in the evidence catalog" and
// "dataLimitations must be non-empty when data quality is partial" — are
// enforced separately in growth/agents/growth-report-agent.ts, not here.
// ---------------------------------------------------------------------------

const SHORT = 160;
const MEDIUM = 600;
const ID_LEN = 80;

const confidence = z.enum(["high", "medium", "low"]);
const severity = z.enum(["low", "medium", "high"]);
const findingCategory = z.enum([
  "traffic",
  "acquisition",
  "landing_page",
  "engagement",
  "cta_behavior",
  "app_performance",
  "search",
  "data_quality",
]);

const evidenceRef = z.string().min(1).max(ID_LEN);
const shortText = z.string().min(1).max(SHORT);
const mediumText = z.string().min(1).max(MEDIUM);

const executiveSummarySchema = z.strictObject({
  headline: shortText,
  summary: mediumText,
  confidence,
});

const findingSchema = z.strictObject({
  id: z.string().min(1).max(60),
  category: findingCategory,
  title: shortText,
  observation: mediumText,
  interpretation: mediumText,
  evidenceRefs: z.array(evidenceRef).min(1).max(10),
  confidence,
  caveats: z.array(mediumText).max(5),
});

const funnelObservationSchema = z.strictObject({
  stage: shortText,
  observation: mediumText,
  evidenceRefs: z.array(evidenceRef).min(1).max(10),
  confidence,
});

const channelAndContentObservationSchema = z.strictObject({
  title: shortText,
  observation: mediumText,
  evidenceRefs: z.array(evidenceRef).min(1).max(10),
  confidence,
  caveats: z.array(mediumText).max(5),
});

const anomalySchema = z.strictObject({
  title: shortText,
  description: mediumText,
  evidenceRefs: z.array(evidenceRef).min(1).max(10),
  severity,
  requiresFurtherValidation: z.boolean(),
});

const dataLimitationSchema = z.strictObject({
  title: shortText,
  impact: mediumText,
  relatedEvidenceRefs: z.array(evidenceRef).max(10),
});

const signalWorthReviewingSchema = z.strictObject({
  signal: shortText,
  whyItMatters: mediumText,
  evidenceRefs: z.array(evidenceRef).min(1).max(10),
  confidence,
});

const questionForDecisionAgentSchema = z.strictObject({
  question: shortText,
  reason: mediumText,
  evidenceRefs: z.array(evidenceRef).max(10),
});

const decisionInputsSchema = z.strictObject({
  signalsWorthReviewing: z.array(signalWorthReviewingSchema).max(6),
  questionsForDecisionAgent: z.array(questionForDecisionAgentSchema).min(1).max(8),
});

/** The model-generated portion of the report. See growth/agents/growth-report-agent.ts for the cross-referential rules layered on top. */
export const growthReportAnalysisSchema = z.strictObject({
  executiveSummary: executiveSummarySchema,
  findings: z.array(findingSchema).min(1).max(8),
  funnelObservations: z.array(funnelObservationSchema).max(6),
  channelAndContentObservations: z.array(channelAndContentObservationSchema).max(6),
  anomaliesOrNotableSignals: z.array(anomalySchema).max(6),
  dataLimitations: z.array(dataLimitationSchema).max(10),
  decisionInputs: decisionInputsSchema,
});

export type GrowthReportAnalysis = z.infer<typeof growthReportAnalysisSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type FunnelObservation = z.infer<typeof funnelObservationSchema>;
export type ChannelAndContentObservation = z.infer<typeof channelAndContentObservationSchema>;
export type Anomaly = z.infer<typeof anomalySchema>;
export type DataLimitation = z.infer<typeof dataLimitationSchema>;
export type SignalWorthReviewing = z.infer<typeof signalWorthReviewingSchema>;
export type QuestionForDecisionAgent = z.infer<typeof questionForDecisionAgentSchema>;
export type Confidence = z.infer<typeof confidence>;

// ---------------------------------------------------------------------------
// Deterministic evidence catalog
// ---------------------------------------------------------------------------

export type EvidenceSource = "GA4" | "PostHog" | "Search Console" | "Normalizer";
export type EvidenceValue = string | number | boolean | null | string[];

/** One deterministic, citable fact derived from the growth summary. The model may only cite these IDs — it must never invent a metric path or retype a number itself. */
export interface EvidenceEntry {
  id: string;
  label: string;
  value: EvidenceValue;
  source: EvidenceSource;
  measurementBasis: string;
}

// ---------------------------------------------------------------------------
// LLM request/response contracts
// ---------------------------------------------------------------------------

/** Everything needed to ask a provider for a structured analysis — the fully-rendered prompt strings plus the structured content they were built from, for transparency/testability. */
export interface GrowthReportLLMRequest {
  purpose: string;
  period: DateRange;
  campaign: CampaignInfo;
  language: SupportedLanguage;
  evidenceCatalog: EvidenceEntry[];
  dataQualityWarnings: string[];
  measurementNotes: string[];
  reportingRules: string[];
  responseSchemaDescription: string;
  maxTokens: number;
  systemPrompt: string;
  userPrompt: string;
}

// ---------------------------------------------------------------------------
// Final assembled report
// ---------------------------------------------------------------------------

export interface ReportProvenance {
  sourceSummaryFilename: string;
  sourceSummarySha256: string;
  sourceSummaryGeneratedAt: string;
  dataQualityStatus: GrowthSummary["dataQuality"]["overallStatus"];
}

export interface GenerationMetadata {
  provider: string;
  model: string;
  language: SupportedLanguage;
  isMock: boolean;
  requestId: string | null;
  stopReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

export interface ReportMetricsSnapshot {
  traffic: GrowthSummary["traffic"];
  behavior: GrowthSummary["behavior"];
  search: GrowthSummary["search"];
  productConversions: GrowthSummary["productConversions"];
}

/** The on-disk shape written to growth/reports/growth-report-{start}_to_{end}.json. */
export interface FinalGrowthReport {
  schemaVersion: "1.0.0";
  reportType: "growth_report";
  generatedAt: string;
  period: DateRange;
  campaign: CampaignInfo;
  provenance: ReportProvenance;
  generation: GenerationMetadata;
  metrics: ReportMetricsSnapshot;
  evidenceCatalog: EvidenceEntry[];
  analysis: GrowthReportAnalysis;
  dataQuality: GrowthSummary["dataQuality"];
}

/** The on-disk shape written to growth/data/processed/growth-report-request-{start}_to_{end}.json in --dry-run mode. Never includes secrets. */
export interface DryRunRequestPreview {
  source: "growth_report_dry_run";
  createdAt: string;
  sourceSummaryFilename: string;
  sourceSummarySha256: string;
  period: DateRange;
  campaign: CampaignInfo;
  language: SupportedLanguage;
  intendedProvider: string;
  intendedModel: string;
  evidenceCatalog: EvidenceEntry[];
  systemPrompt: string;
  userPrompt: string;
  responseSchemaDescription: string;
}
