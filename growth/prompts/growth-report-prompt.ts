import type { CampaignInfo, DateRange } from "../types/growth-summary";
import type { EvidenceEntry, GrowthReportLLMRequest, SupportedLanguage } from "../types/growth-report";

export const REPORT_PURPOSE =
  "Explain what happened during this growth campaign period using only the supplied evidence, distinguish " +
  "observed facts from interpretation, disclose data limitations, and prepare structured decision inputs for " +
  "a later Experiment Decision Agent. This report does not choose the next experiment, topic, CTA, or channel.";

/** Each entry is a self-contained "must"/"must not" rule — used verbatim in both the system prompt and request.reportingRules. */
export const REPORTING_RULES: string[] = [
  "You must distinguish observed facts from interpretations, and interpretations from hypotheses.",
  "You must cite evidence using only the supplied evidence IDs.",
  "You must not invent numbers that are not present in the evidence catalog.",
  "You must not invent causes, benchmarks, competitor comparisons, or user feedback.",
  "You must disclose missing or weak data.",
  "You must acknowledge when Search Console is empty or unavailable for this period.",
  "You must acknowledge that Whacka product-side conversions (signups, first app created, app published) are not connected yet.",
  "You must not present event-count ratios (e.g. CTA clicks / pageviews) as user conversion rates or session conversion rates.",
  "You must not treat GA4 pageviews and PostHog pageviews as identical measurements — they come from different instrumentation.",
  "You must not sum unique-user or active-user metrics that the evidence catalog marks as unavailable.",
  "You must not claim statistical significance.",
  "You must not claim causation from correlation.",
  "You must use clear, concise language and produce only the required structured output — no commentary outside the schema.",
  "You must not search the web or use external knowledge beyond the supplied evidence.",
  "You must not make final experiment decisions, choose the next topic, choose the next CTA, or choose the next distribution channel — a later Experiment Decision Agent does that.",
  "You must not fabricate benchmarks, competitor comparisons, user feedback, or product conversion data.",
];

export const RESPONSE_SCHEMA_DESCRIPTION = `A single JSON object with these top-level keys:
- executiveSummary: { headline, summary, confidence: "high"|"medium"|"low" }
- findings: 1-8 items, each { id, category, title, observation, interpretation, evidenceRefs (>=1 item), confidence, caveats }
  category is one of: traffic, acquisition, landing_page, engagement, cta_behavior, app_performance, search, data_quality
- funnelObservations: 0-6 items, each { stage, observation, evidenceRefs (>=1 item), confidence }
- channelAndContentObservations: 0-6 items, each { title, observation, evidenceRefs (>=1 item), confidence, caveats }
- anomaliesOrNotableSignals: 0-6 items, each { title, description, evidenceRefs (>=1 item), severity: "low"|"medium"|"high", requiresFurtherValidation: boolean }
- dataLimitations: items { title, impact, relatedEvidenceRefs } — include at least one item whenever data quality is not "complete"
- decisionInputs: { signalsWorthReviewing: 0-6 items { signal, whyItMatters, evidenceRefs (>=1 item), confidence }, questionsForDecisionAgent: 1-8 items { question, reason, evidenceRefs } }
Every evidenceRefs/relatedEvidenceRefs value must be an "id" that appears in the supplied evidence catalog — never invent one. No unknown top-level or nested keys are allowed.`;

function languageInstruction(language: SupportedLanguage): string {
  return language === "zh-CN"
    ? "Write every string value in the response (headline, summary, titles, observations, etc.) in Simplified Chinese (zh-CN)."
    : "Write every string value in the response in English (en).";
}

/** Combines the fixed reporting rules with the language instruction for this specific request. */
export function buildReportingRules(language: SupportedLanguage): string[] {
  return [...REPORTING_RULES, languageInstruction(language)];
}

export function buildSystemPrompt(language: SupportedLanguage): string {
  return [
    "You are an evidence-grounded growth reporting analyst producing a Growth Report for an internal growth loop.",
    "You may only use the supplied evidence catalog and data-quality context.",
    "",
    ...buildReportingRules(language).map((rule) => `- ${rule}`),
    "",
    "The later Experiment Decision Agent will make experiment decisions. This report provides evidence and decision inputs only.",
  ].join("\n");
}

export interface BuildUserPromptParams {
  purpose: string;
  period: DateRange;
  campaign: CampaignInfo;
  evidenceCatalog: EvidenceEntry[];
  dataQualityWarnings: string[];
  measurementNotes: string[];
  responseSchemaDescription: string;
}

export function buildUserPrompt(params: BuildUserPromptParams): string {
  const warnings = params.dataQualityWarnings.length > 0 ? params.dataQualityWarnings.map((w) => `- ${w}`).join("\n") : "(none)";
  const notes = params.measurementNotes.length > 0 ? params.measurementNotes.map((n) => `- ${n}`).join("\n") : "(none)";

  return [
    `Purpose: ${params.purpose}`,
    "",
    `Reporting period: ${params.period.start} to ${params.period.end}`,
    `Campaign: ${params.campaign.name} (id: ${params.campaign.id})`,
    "",
    'Evidence catalog (the ONLY facts you may cite; reference entries by their "id"):',
    JSON.stringify(params.evidenceCatalog, null, 2),
    "",
    "Data-quality warnings:",
    warnings,
    "",
    "Measurement notes:",
    notes,
    "",
    "Required response structure:",
    params.responseSchemaDescription,
  ].join("\n");
}

export interface BuildGrowthReportLLMRequestParams {
  period: DateRange;
  campaign: CampaignInfo;
  language: SupportedLanguage;
  evidenceCatalog: EvidenceEntry[];
  dataQualityWarnings: string[];
  measurementNotes: string[];
  maxTokens: number;
}

/** Builds the full, ready-to-send request: rendered system/user prompt strings plus the structured content they came from. */
export function buildGrowthReportLLMRequest(params: BuildGrowthReportLLMRequestParams): GrowthReportLLMRequest {
  const reportingRules = buildReportingRules(params.language);

  const systemPrompt = buildSystemPrompt(params.language);
  const userPrompt = buildUserPrompt({
    purpose: REPORT_PURPOSE,
    period: params.period,
    campaign: params.campaign,
    evidenceCatalog: params.evidenceCatalog,
    dataQualityWarnings: params.dataQualityWarnings,
    measurementNotes: params.measurementNotes,
    responseSchemaDescription: RESPONSE_SCHEMA_DESCRIPTION,
  });

  return {
    purpose: REPORT_PURPOSE,
    period: params.period,
    campaign: params.campaign,
    language: params.language,
    evidenceCatalog: params.evidenceCatalog,
    dataQualityWarnings: params.dataQualityWarnings,
    measurementNotes: params.measurementNotes,
    reportingRules,
    responseSchemaDescription: RESPONSE_SCHEMA_DESCRIPTION,
    maxTokens: params.maxTokens,
    systemPrompt,
    userPrompt,
  };
}
