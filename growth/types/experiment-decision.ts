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
/**
 * Shared rationale-length ceiling for `decisionSummary.rationale`, used by
 * both the final `decisionSummarySchema` and the live two-stage
 * `decisionGateSchema` (growth/llm/anthropic-experiment-decision-provider.ts).
 * Raised from the general-purpose `MEDIUM` (600) after a live Stage 1 run
 * returned a rationale that exceeded it — 1500 gives real model output
 * headroom while the prompt (growth/prompts/experiment-decision-prompt.ts)
 * separately asks for a concise, <=3-sentence, ideally <500-character
 * rationale. Keep this the ONLY place rationale's max length is defined —
 * do not reintroduce `mediumText` for this field.
 */
const RATIONALE_MAX = 1500;
/**
 * Shared defer-reason-length ceiling for `deferDecision.reason`, used by
 * both the final `deferDecisionSchema` and the live two-stage
 * `deferDetailsSchema` (growth/llm/anthropic-experiment-decision-provider.ts).
 * Raised from the general-purpose `MEDIUM` (600) after a live Stage 2 defer
 * run returned a reason that exceeded it — same 1500 ceiling as
 * `RATIONALE_MAX`, for the same class of free-form model justification
 * text. Keep this the ONLY place deferDecision.reason's max length is
 * defined — do not reintroduce `mediumText` for this field. Unrelated
 * "reason" fields (`rejectedOrDeferredOptionSchema.reason`,
 * `handoffItemSchema.reason`) are short annotations, not this field, and
 * are deliberately not affected.
 */
const DEFER_REASON_MAX = 1500;

const confidence = z.enum(["high", "medium", "low"]);
const decisionStatus = z.enum(["proceed", "defer"]);
const lever = z.enum(["topic", "cta", "channel"]);
const ctaType = z.enum(["view_demo", "remix", "build", "copy_prompt"]);
const expectedDirection = z.enum(["increase", "decrease", "maintain"]);
const handoffDestination = z.enum(["signal_mining", "topic_pool", "asset_generation", "manual_review"]);

const refId = z.string().min(1).max(ID_LEN);
const shortText = z.string().min(1).max(SHORT);
const mediumText = z.string().min(1).max(MEDIUM);
const rationaleText = z.string().min(1).max(RATIONALE_MAX);
const deferReasonText = z.string().min(1).max(DEFER_REASON_MAX);
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
  rationale: rationaleText,
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
  reason: deferReasonText,
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
export type HandoffItem = z.infer<typeof handoffItemSchema>;

// ---------------------------------------------------------------------------
// Two-stage live-generation schemas (Anthropic structured outputs only).
//
// `experimentDecisionAnalysisSchema` above — one strict object nesting a
// nullable `recommendedExperiment`, a nullable `deferDecision`, per-field
// nullable targets, and up to 5 richly-nested ranked options — compiles to
// a single Anthropic structured-output grammar too large to compile
// ("The compiled grammar is too large, which would cause performance
// issues."). `AnthropicExperimentDecisionProvider` (growth/llm/
// anthropic-experiment-decision-provider.ts) instead makes two smaller
// calls against the compact schemas below:
//   1. decisionGateSchema — always called first; decides proceed vs defer.
//   2. proceedDetailsSchema OR deferDetailsSchema — whichever branch
//      stage 1 selected.
// growth/llm/experiment-decision-assembly.ts deterministically combines
// the two stages' output into a full ExperimentDecisionAnalysis-shaped
// object, which is then validated by the EXACT SAME
// experimentDecisionAnalysisSchema / validateDecisionAnalysis as before —
// the on-disk FinalExperimentDecision contract is completely unchanged.
//
// Design rules enforced in every schema below: every property required
// (no `.optional()`), no nullable fields (no `z.union([X, z.null()])`),
// no `anyOf` beyond simple string enums, no duplicated recommendedExperiment
// content, and no nested objects beyond what each stage strictly needs.
// Non-applicable topic/CTA/channel fields use `""` instead of `null` —
// growth/llm/experiment-decision-assembly.ts converts `""` back to `null`
// during assembly, never before.
// ---------------------------------------------------------------------------

/** Stage 1 — decision gate. Four required, flat, non-nullable fields. No nested objects. */
export const decisionGateSchema = z.strictObject({
  decisionStatus,
  headline: shortText,
  rationale: rationaleText,
  confidence,
});
export type DecisionGate = z.infer<typeof decisionGateSchema>;

/** `""` sentinel appended so a non-applicable CTA type never needs a nullable union. */
const ctaTypeOrEmpty = z.enum(["view_demo", "remix", "build", "copy_prompt", ""]);

/** Same shape as the final handoffItemSchema — already compact (no unions), reused as the provider-facing shape too. */
const providerHandoffItemSchema = handoffItemSchema;
export type ProviderHandoffItem = z.infer<typeof providerHandoffItemSchema>;

// ---------------------------------------------------------------------------
// Deterministic reference aliases (Anthropic structured outputs only).
//
// Stage 2 previously asked the model to return raw catalog IDs (e.g.
// "finding.finding-app-perf") for evidenceRefs/findingRefs/limitationRefs.
// Live runs showed the model inventing human-readable shorthand IDs that
// don't exist in the catalog instead — a structurally valid string that
// fails growth/agents/experiment-decision-agent.ts's `validateDecisionAnalysis`
// reference checks. Rather than widen validation to fuzzy-match invented
// IDs, Stage 2's schema is now built per-request from compact,
// deterministic aliases (E001, F001, L001, ...) so the model can only
// select from an enumerated list structured outputs can enforce directly —
// an unknown alias becomes an API-level structured-output failure before
// it ever reaches this codebase. growth/llm/experiment-decision-reference-
// aliases.ts builds these alias maps (from the same validated catalogs
// already on ExperimentDecisionContext) and maps aliases back to the
// original IDs immediately after Stage 2 responds — growth/llm/
// experiment-decision-assembly.ts and `validateDecisionAnalysis` only ever
// see resolved original IDs, exactly as before.
// ---------------------------------------------------------------------------

export interface ReferenceAliasSet {
  /** Aliases in deterministic ascending order (by original id), e.g. ["E001", "E002", ...]. Empty when the source catalog is empty. */
  aliases: string[];
  /** alias -> original catalog id. */
  toId: ReadonlyMap<string, string>;
  /** original catalog id -> alias. */
  toAlias: ReadonlyMap<string, string>;
}

export interface ReferenceAliasMaps {
  evidence: ReferenceAliasSet;
  finding: ReferenceAliasSet;
  limitation: ReferenceAliasSet;
}

function nonEmptyEnum(values: string[]) {
  return z.enum(values as [string, ...string[]]);
}

/**
 * An array of aliases, or (when the source catalog is empty) a schema that
 * can only ever validate `[]` — never an invalid empty `z.enum()`. A
 * requested `minItems` is only enforced when aliases actually exist; if the
 * catalog is empty the array can only be `[]` regardless, which the FINAL
 * `experimentDecisionAnalysisSchema` (unchanged) still separately enforces
 * a minimum length on where one is required — this is defense in depth,
 * not a weakening of final validation.
 */
function aliasArraySchema(aliases: string[], minItems: number, maxItems: number) {
  if (aliases.length === 0) return z.array(z.string()).max(0);
  return z.array(nonEmptyEnum(aliases)).min(minItems).max(maxItems);
}

/**
 * A single required alias field. Falls back to a string constrained to
 * length 0 (i.e. only `""` is valid) when the catalog is empty — `z.never()`
 * cannot be sent to Anthropic (structured-output conversion requires a
 * concrete JSON schema type). `""` is never a valid alias, so
 * growth/llm/experiment-decision-reference-aliases.ts's resolver rejects it
 * with a clear, sanitized "unknown alias" error rather than accepting it.
 * Only reachable in the pathological case of a "proceed" decision with zero
 * evidence, which should not occur in practice.
 */
function requiredAliasSchema(aliases: string[]) {
  return aliases.length === 0 ? z.string().max(0) : nonEmptyEnum(aliases);
}

/** Stage 2A per-option shape — RankedExperimentOption flattened: `target.*` becomes three sibling fields, each `""` when not applicable, and every evidence/finding/limitation reference field is constrained to that request's own E/F/L alias enum. Provider-facing only; growth/llm/experiment-decision-assembly.ts (via growth/llm/experiment-decision-reference-aliases.ts's alias resolution) converts it back to RankedExperimentOption with original IDs. */
function buildProceedOptionSchema(aliases: ReferenceAliasMaps) {
  return z.strictObject({
    id: z.string().min(1).max(60),
    rank: z.number().int().min(1),
    lever,
    title: shortText,
    targetTopicOrApp: z.string().max(SHORT),
    targetCtaType: ctaTypeOrEmpty,
    targetChannel: z.string().max(SHORT),
    hypothesis: mediumText,
    proposedChange: mediumText,
    controlDescription: mediumText,
    variantDescription: mediumText,
    primaryMetricRef: requiredAliasSchema(aliases.evidence.aliases),
    expectedDirection,
    successCriterion: mediumText,
    guardrailMetricRefs: aliasArraySchema(aliases.evidence.aliases, 0, 10),
    measurementCaveats: z.array(mediumText).max(5),
    evidenceRefs: aliasArraySchema(aliases.evidence.aliases, 1, 10),
    findingRefs: aliasArraySchema(aliases.finding.aliases, 0, 10),
    limitationRefs: aliasArraySchema(aliases.limitation.aliases, 0, 10),
    confidence,
    dependencies: z.array(mediumText).max(5),
    risks: z.array(mediumText).max(5),
    whyNotHigherRanked: z.string().max(MEDIUM),
  });
}

export type ProceedOption = z.infer<ReturnType<typeof buildProceedOptionSchema>>;

/**
 * Stage 2A — proceed details, built fresh per request from that request's
 * own E/F/L aliases. Capped at 3 ranked options (vs. the final schema's 5)
 * to keep this call's grammar small; 3 ⊆ the final schema's `.max(5)` so
 * nothing downstream needs to change. Deliberately omits `decisionStatus`
 * (already fixed by stage 1), `deferDecision` (not reachable from this
 * branch), and any duplicate `recommendedExperiment` object — growth/llm/
 * experiment-decision-assembly.ts derives `recommendedExperiment` and
 * `rejectedOrDeferredOptions` entirely from `rankedExperimentOptions`, so
 * the model never generates the same experiment's content twice.
 */
export function buildProceedDetailsSchema(aliases: ReferenceAliasMaps) {
  return z.strictObject({
    rankedExperimentOptions: z.array(buildProceedOptionSchema(aliases)).min(1).max(3),
    recommendedExperimentId: z.string().min(1).max(60),
    handoffItems: z.array(providerHandoffItemSchema).max(10),
  });
}

export type ProceedDetails = z.infer<ReturnType<typeof buildProceedDetailsSchema>>;

/** Provider-facing requiredNextObservation shape — `relatedEvidenceOrLimitationRefs` accepts only that request's E (evidence) or L (limitation) aliases; F (finding) aliases are never included in the enum, so a finding alias here is rejected by the structured-output schema itself, not just by later validation. */
function buildRequiredNextObservationSchemaForAliases(aliases: ReferenceAliasMaps) {
  return z.strictObject({
    observation: mediumText,
    relatedEvidenceOrLimitationRefs: aliasArraySchema([...aliases.evidence.aliases, ...aliases.limitation.aliases], 0, 10),
  });
}

/**
 * Stage 2B — defer details, built fresh per request. Otherwise unchanged
 * from before: already close to the final deferDecisionSchema shape,
 * folding handoffItems in alongside it, and deliberately omitting
 * `rankedExperimentOptions`/`recommendedExperiment`/`rejectedOrDeferredOptions`
 * — growth/llm/experiment-decision-assembly.ts sets those to `[]`/`null`
 * for a defer decision.
 */
export function buildDeferDetailsSchema(aliases: ReferenceAliasMaps) {
  return z.strictObject({
    reason: deferReasonText,
    missingEvidence: z.array(mediumText).min(1).max(10),
    requiredNextObservations: z.array(buildRequiredNextObservationSchemaForAliases(aliases)).min(1).max(10),
    earliestDecisionCondition: mediumText,
    handoffItems: z.array(providerHandoffItemSchema).max(10),
  });
}

export type DeferDetails = z.infer<ReturnType<typeof buildDeferDetailsSchema>>;

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
