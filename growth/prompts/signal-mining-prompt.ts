import type { SignalMiningLLMRequest, SignalMiningFeedbackContext, ExistingContentCatalogEntry, SignalSourceRecord } from "../types/signal-mining";
import type { CampaignInfo, DateRange } from "../types/growth-summary";
import type { SupportedLanguage } from "../types/llm";

export const SIGNAL_MINING_PURPOSE =
  "Identify concrete, evidence-backed signals from the supplied source records, and cluster validated signals into a " +
  "candidate topic pool for Topic Scoring. This Agent mines and normalizes signals; it does not score, rank, or decide " +
  "advance/hold/reject, and it does not generate app content, SEO copy, or social copy.";

/** Each entry is a self-contained "must"/"must not" rule — used verbatim in both the system prompt and request.reportingRules. */
export const REPORTING_RULES: string[] = [
  "You are an evidence-grounded signal-mining analyst. You may only use the supplied source record catalog, existing content catalog, and supplied Growth Loop Feedback context — nothing else.",
  "You must identify concrete signals, not hypotheses presented as facts — distinguish an observed signal from a hypothesis explicitly.",
  "You must cite sourceRecordRefs (valid ids from the supplied source record catalog) for every proposed signal — at least one, never zero.",
  "You must preserve uncertainty: use the quality.confidence and quality.freshness fields honestly instead of defaulting to high confidence.",
  "You must create topic clusters only from validated proposed signals (via signalProposalRefs) — never from a source record directly.",
  "You must keep related but meaningfully different topics as separate topic clusters — do not force unrelated signals into one cluster to reduce count.",
  "You must merge obvious duplicate signals into a single topic cluster rather than proposing near-identical clusters.",
  "You must disclose weak, stale, incomplete, or single-source evidence in the relevant quality.limitations or topic limitations field.",
  "You must acknowledge when Search Console data is empty or missing for this period, if that context is supplied — never invent a keyword signal to compensate.",
  "You must acknowledge that Whacka product-side conversions (signups, first app created, app published) are not connected, if that context is supplied.",
  "You must acknowledge explicitly when supplied Growth Loop Feedback context is mock-generated (isMock: true) — do not treat it as a real strategic instruction.",
  "You must identify overlap with existing apps using only the supplied existing content catalog's appSlug values — never invent an app slug.",
  "You must use clear, concise language and produce only the structured response — no prose outside the schema.",
  "You must not search the web, browse, or use knowledge external to the supplied source records and existing content catalog.",
  "You must not invent search volume, social engagement, competitors, user quotations, keywords, source URLs, or metrics not present in the supplied source records.",
  "You must not alter any metric value supplied in a source record — only the deterministic pipeline computes metrics.",
  "You must not score or rank topics, or recommend advance, hold, or reject for any topic — that belongs to the Topic Scoring Agent.",
  "You must not generate app content, SEO copy, or social copy — that belongs to the Asset Generation Agent.",
  "You must not choose or describe a final experiment — that belongs to the Experiment Decision Agent.",
  "You must not write to a CMS or publish anything.",
  "Zero signal proposals and zero topic clusters are valid outputs when the supplied evidence is genuinely insufficient — do not fabricate a signal or topic just to produce a non-empty response.",
  "When Growth Loop Feedback constraints are supplied, you must stay within allowedTopics/allowedCtaTypes/allowedChannels when proposing a relationship to existing content, and you must not treat a feedback instruction as measured demand evidence on its own — a topic cluster still needs supporting signalProposalRefs backed by real source records.",
];

export const RESPONSE_SCHEMA_DESCRIPTION = `A single JSON object with these top-level keys:
- signalProposals: 0-100 items, each { temporaryId (unique string), signalType: "keyword"|"user_need"|"pain_point"|"use_case"|"competitor_pattern"|"content_pattern"|"product_request"|"search_pattern"|"engagement_pattern"|"manual_input", title, summary, evidenceExcerpt (string or null), sourceRecordRefs (>=1 item, each an "id" from the supplied source record catalog), entities: {keywords, topics, audiences, productsOrApps, channels}, quality: {confidence: "high"|"medium"|"low", freshness: "current"|"recent"|"unknown"|"stale", limitations} }
- topicClusters: 0-50 items, each { temporaryId (unique string), canonicalName, slugSuggestion (lowercase kebab-case), aliases, problemStatement, targetAudience (>=1 item), useCases, desiredOutcome, signalProposalRefs (>=1 item, each a temporaryId from signalProposals above), relationshipToExistingContent: {status: "new"|"existing"|"overlapping"|"duplicate"|"unknown", relatedAppSlugs (each must be an appSlug from the supplied existing content catalog — never invent one)}, confidence: "high"|"medium"|"low", limitations }
- unresolvedSourceRecords: 0-150 items, each { sourceRecordRef (an "id" from the supplied source record catalog), reason: "insufficient_evidence"|"ambiguous"|"duplicate"|"irrelevant"|"unsupported", note }
- analysisNotes: { sourceCoverage, majorLimitations, requiresHumanReview: true }
Every sourceRecordRefs value must be an "id" from the supplied source record catalog — never invent one. Every topicClusters.signalProposalRefs value must be a temporaryId that appears in signalProposals. Every relatedAppSlugs value must be an appSlug from the supplied existing content catalog. temporaryId values must be unique within signalProposals and unique within topicClusters. No scoring fields, no ranking fields, no generated content fields, no CMS fields, and no final experiment recommendation fields are allowed anywhere in the response. No unknown top-level or nested keys are allowed.`;

function languageInstruction(language: SupportedLanguage): string {
  return language === "zh-CN"
    ? "Write every string value in the response (titles, summaries, problem statements, etc.) in Simplified Chinese (zh-CN)."
    : "Write every string value in the response in English (en).";
}

/** Combines the fixed reporting rules with the language instruction for this specific request. */
export function buildReportingRules(language: SupportedLanguage): string[] {
  return [...REPORTING_RULES, languageInstruction(language)];
}

export function buildSystemPrompt(language: SupportedLanguage): string {
  return [
    "You are an evidence-grounded signal-mining analyst producing candidate signals and a topic pool for an internal growth loop.",
    "You may only use the supplied source record catalog, existing content catalog, and Growth Loop Feedback context (when present).",
    "",
    ...buildReportingRules(language).map((rule) => `- ${rule}`),
    "",
    "This Agent mines and clusters signals only. A human reviews the resulting topic pool before Topic Scoring runs.",
  ].join("\n");
}

export interface BuildUserPromptParams {
  purpose: string;
  period: DateRange;
  campaign: CampaignInfo;
  sourceRecordCatalog: SignalSourceRecord[];
  existingContentCatalog: ExistingContentCatalogEntry[];
  feedbackContext: SignalMiningFeedbackContext | null;
  dataQualityWarnings: string[];
  responseSchemaDescription: string;
}

export function buildUserPrompt(params: BuildUserPromptParams): string {
  const warnings = params.dataQualityWarnings.length > 0 ? params.dataQualityWarnings.map((w) => `- ${w}`).join("\n") : "(none)";

  return [
    `Purpose: ${params.purpose}`,
    "",
    `Reporting period: ${params.period.start} to ${params.period.end}`,
    `Campaign: ${params.campaign.name} (id: ${params.campaign.id})`,
    "",
    'Source record catalog (the ONLY evidence you may cite; reference entries by their "id"):',
    JSON.stringify(params.sourceRecordCatalog, null, 2),
    "",
    'Existing content catalog (the ONLY valid values for relatedAppSlugs; reference entries by "appSlug"):',
    JSON.stringify(params.existingContentCatalog, null, 2),
    "",
    "Growth Loop Feedback context (instructions/constraints from the prior Experiment Decision, when present — NOT measured evidence; null when no feedback was supplied):",
    JSON.stringify(params.feedbackContext, null, 2),
    "",
    "Data-quality warnings:",
    warnings,
    "",
    "Required response structure:",
    params.responseSchemaDescription,
  ].join("\n");
}

export interface BuildSignalMiningLLMRequestParams {
  campaign: CampaignInfo;
  period: DateRange;
  language: SupportedLanguage;
  sourceRecordCatalog: SignalSourceRecord[];
  existingContentCatalog: ExistingContentCatalogEntry[];
  feedbackContext: SignalMiningFeedbackContext | null;
  dataQualityWarnings: string[];
  maxTokens: number;
}

/** Builds the full, ready-to-send request: rendered system/user prompt strings plus the structured content they came from. */
export function buildSignalMiningLLMRequest(params: BuildSignalMiningLLMRequestParams): SignalMiningLLMRequest {
  const reportingRules = buildReportingRules(params.language);

  const systemPrompt = buildSystemPrompt(params.language);
  const userPrompt = buildUserPrompt({
    purpose: SIGNAL_MINING_PURPOSE,
    period: params.period,
    campaign: params.campaign,
    sourceRecordCatalog: params.sourceRecordCatalog,
    existingContentCatalog: params.existingContentCatalog,
    feedbackContext: params.feedbackContext,
    dataQualityWarnings: params.dataQualityWarnings,
    responseSchemaDescription: RESPONSE_SCHEMA_DESCRIPTION,
  });

  return {
    purpose: SIGNAL_MINING_PURPOSE,
    campaign: params.campaign,
    period: params.period,
    language: params.language,
    sourceRecordCatalog: params.sourceRecordCatalog,
    existingContentCatalog: params.existingContentCatalog,
    feedbackContext: params.feedbackContext,
    dataQualityWarnings: params.dataQualityWarnings,
    reportingRules,
    responseSchemaDescription: RESPONSE_SCHEMA_DESCRIPTION,
    maxTokens: params.maxTokens,
    systemPrompt,
    userPrompt,
  };
}
