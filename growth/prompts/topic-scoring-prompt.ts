import type {
  TopicScoringCatalogEntry,
  TopicScoringContext,
  TopicScoringLLMRequest,
  TopicScoringProfile,
} from "../types/topic-scoring";
import type { CampaignInfo, DateRange } from "../types/growth-summary";
import type { SupportedLanguage } from "../types/llm";

export const TOPIC_SCORING_PURPOSE =
  "Assess every supplied TopicCandidate against the fixed seven-dimension scoring rubric, grounding every score in the supplied " +
  "signals and source records. This Agent assesses topics; it does not weight, total, rank, or recommend — those are computed " +
  "deterministically afterward — and it does not generate app content, SEO copy, social copy, or write to a CMS.";

/** Each entry is a self-contained "must"/"must not" rule — used verbatim in both the system prompt and request.reportingRules. */
export const REPORTING_RULES: string[] = [
  "You are an evidence-grounded topic-assessment analyst. You may only use the supplied topics, signals, source records, existing-content relationships, data-quality context, and the fixed scoring rubric — nothing else.",
  "You must score every supplied topic using all seven required dimensions — never fewer, never more, never a duplicate.",
  "You must distinguish evidence-based scoring (scoreBasis: 'evidence', citing at least one real signalRef or sourceRecordRef) from policy-default scoring (scoreBasis: 'policy_default', using the fixed fallback score and at least one limitation explaining what evidence is missing).",
  "You must cite only signalRefs and sourceRecordRefs that belong to that specific topic's own supplied context — never a value from another topic's context, and never an invented ID.",
  "You must preserve uncertainty — do not present higher confidence than the underlying signals support.",
  "You must disclose missing evidence as a limitation rather than silently scoring around it.",
  "You must use the policy fallback score (see the supplied scoringProfile.insufficientEvidenceFallbackScore) whenever a dimension's evidence is insufficient — this is especially likely for competition, broad market demand, and platform-feasibility claims.",
  "You must treat the competition dimension as observed opportunity favourability within the supplied evidence and existing-content catalog only — never a claim about the whole external market.",
  "You must acknowledge when Search Console data was empty or missing for the source Signal Mining run, if that context is supplied.",
  "You must acknowledge that Whacka product-side conversions are not connected, if that context is supplied.",
  "You must acknowledge explicitly when the source Signal Mining run was mock-generated or its topics were not yet human-approved, if that context is supplied.",
  "You must keep every rationale concise and specific to the cited evidence.",
  "You must produce only the structured response — no prose outside the schema.",
  "You must not browse the web, use external knowledge, or cite external benchmarks.",
  "You must not invent search volume, market size, competitors, user feedback, traffic, or product conversions.",
  "You must not invent a Whacka platform capability that isn't supported by the supplied context.",
  "You must not alter any metric value supplied in a signal or source record.",
  "You must not calculate a weight, a weighted score, or a total score — the schema has no field for any of them.",
  "You must not rank the topics relative to each other.",
  "You must not choose or state a final recommendation (advance/hold/reject/needs_human_review) — that is computed deterministically after your response.",
  "You must not generate app content, SEO copy, or social copy, and you must not write to a CMS or publish anything.",
];

export const RESPONSE_SCHEMA_DESCRIPTION = `A single JSON object with these top-level keys:
- topicAssessments: exactly one entry per supplied topic (same topicId set, no more, no fewer, no duplicates), each { topicId, dimensions: exactly 7 items (one per required dimension key: demand, audience_relevance, product_fit, competition, feasibility, novelty, evidence_strength — each exactly once), each dimension { key, score (0-100), scoreBasis: "evidence"|"policy_default", rationale, signalRefs (ids from that topic's own supplied signals only), sourceRecordRefs (ids from that topic's own supplied source records only), limitations }, confidence: "high"|"medium"|"low", blockers: items { code: "insufficient_evidence"|"duplicate_or_existing"|"unclear_audience"|"outside_current_scope"|"requires_unavailable_data"|"other", description, signalRefs, sourceRecordRefs } (may be empty), reviewNotes }
- portfolioObservations: { topicCoverage, evidenceCoverage, majorLimitations, requiresHumanReview: true }
An "evidence" scoreBasis requires at least one signalRef or sourceRecordRef. A "policy_default" scoreBasis requires at least one limitation. No weights, weighted scores, totals, ranks, or recommendation fields are allowed anywhere in the response. No unknown top-level or nested keys are allowed.`;

function languageInstruction(language: SupportedLanguage): string {
  return language === "zh-CN"
    ? "Write every string value in the response (rationales, descriptions, review notes, etc.) in Simplified Chinese (zh-CN)."
    : "Write every string value in the response in English (en).";
}

/** Combines the fixed reporting rules with the language instruction for this specific request. */
export function buildReportingRules(language: SupportedLanguage): string[] {
  return [...REPORTING_RULES, languageInstruction(language)];
}

export function buildSystemPrompt(language: SupportedLanguage): string {
  return [
    "You are an evidence-grounded topic-assessment analyst scoring candidate topics for an internal growth loop.",
    "You may only use the supplied topics, signals, source records, existing-content relationships, data-quality context, and the fixed scoring rubric.",
    "",
    ...buildReportingRules(language).map((rule) => `- ${rule}`),
    "",
    "This Agent assesses topics only. Weighting, totals, ranking, and the final recommendation are computed deterministically afterward, and a human reviews the result before Asset Generation.",
  ].join("\n");
}

export interface BuildUserPromptParams {
  purpose: string;
  period: DateRange;
  campaign: CampaignInfo;
  scoringProfile: TopicScoringProfile;
  topicContexts: TopicScoringContext[];
  topicCatalog: TopicScoringCatalogEntry[];
  dataQualityWarnings: string[];
  sourceIsMock: boolean;
  sourceHumanReviewed: boolean;
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
    `Source Signal Mining run mock-generated: ${params.sourceIsMock}`,
    `Source topics human-approved: ${params.sourceHumanReviewed}`,
    "",
    "Fixed scoring rubric (dimensions, weights, and meanings — weights are informational only; you never compute a weighted score yourself):",
    JSON.stringify(params.scoringProfile, null, 2),
    "",
    "Topic catalog (concise, for relative novelty/duplication comparison only — cite signalRefs/sourceRecordRefs from a topic's own context below, never from this catalog):",
    JSON.stringify(params.topicCatalog, null, 2),
    "",
    'Topic contexts (the ONLY evidence you may cite for each topic; reference signals/source records by their "id", scoped to that topic only):',
    JSON.stringify(params.topicContexts, null, 2),
    "",
    "Data-quality warnings:",
    warnings,
    "",
    "Required response structure:",
    params.responseSchemaDescription,
  ].join("\n");
}

export interface BuildTopicScoringLLMRequestParams {
  campaign: CampaignInfo;
  period: DateRange;
  language: SupportedLanguage;
  scoringProfile: TopicScoringProfile;
  topicContexts: TopicScoringContext[];
  topicCatalog: TopicScoringCatalogEntry[];
  dataQualityWarnings: string[];
  sourceIsMock: boolean;
  sourceHumanReviewed: boolean;
  maxTokens: number;
}

/** Builds the full, ready-to-send request: rendered system/user prompt strings plus the structured content they came from. */
export function buildTopicScoringLLMRequest(params: BuildTopicScoringLLMRequestParams): TopicScoringLLMRequest {
  const reportingRules = buildReportingRules(params.language);

  const systemPrompt = buildSystemPrompt(params.language);
  const userPrompt = buildUserPrompt({
    purpose: TOPIC_SCORING_PURPOSE,
    period: params.period,
    campaign: params.campaign,
    scoringProfile: params.scoringProfile,
    topicContexts: params.topicContexts,
    topicCatalog: params.topicCatalog,
    dataQualityWarnings: params.dataQualityWarnings,
    sourceIsMock: params.sourceIsMock,
    sourceHumanReviewed: params.sourceHumanReviewed,
    responseSchemaDescription: RESPONSE_SCHEMA_DESCRIPTION,
  });

  return {
    purpose: TOPIC_SCORING_PURPOSE,
    campaign: params.campaign,
    period: params.period,
    language: params.language,
    scoringProfile: params.scoringProfile,
    topicContexts: params.topicContexts,
    topicCatalog: params.topicCatalog,
    dataQualityWarnings: params.dataQualityWarnings,
    sourceIsMock: params.sourceIsMock,
    sourceHumanReviewed: params.sourceHumanReviewed,
    reportingRules,
    responseSchemaDescription: RESPONSE_SCHEMA_DESCRIPTION,
    maxTokens: params.maxTokens,
    systemPrompt,
    userPrompt,
  };
}
