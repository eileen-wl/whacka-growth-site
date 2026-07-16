import type { ExperimentDecisionContext, ExperimentDecisionLLMRequest } from "../types/experiment-decision";
import type { SupportedLanguage } from "../types/llm";

export const DECISION_PURPOSE =
  "Compare evidence-backed experiment options from the supplied Growth Report, then either recommend exactly one " +
  "bounded next experiment or explicitly defer when evidence is insufficient. This Agent records a decision; it " +
  "does not execute it, publish it, distribute it, or write final creative copy.";

/** Each entry is a self-contained "must"/"must not" rule — used verbatim in both the system prompt and request.reportingRules. */
export const REPORTING_RULES: string[] = [
  "You must distinguish measured facts from interpretations, and hypotheses from conclusions.",
  "You must cite every recommendation using valid evidence IDs from the supplied evidence catalog.",
  "You must cite relevant Growth Report finding IDs from the supplied finding catalog.",
  "You must disclose data limitations using the supplied limitation catalog IDs.",
  "You must respect the source Growth Report's own confidence levels — do not present higher confidence than the underlying findings support.",
  "You must lower your confidence when the source Growth Report is mock-generated.",
  "You must lower your confidence when data quality is partial.",
  "You must produce an actionable but bounded experiment brief — one clear change, not a redesign.",
  'You must recommend exactly one primary experiment when decisionStatus is "proceed".',
  "You must rank alternative options when the evidence supports more than one viable option.",
  'You must set decisionStatus to "defer" instead of forcing a recommendation when evidence is insufficient — deferring is a valid, expected outcome, not a failure.',
  "You must not search the web, use external knowledge, or cite external benchmarks.",
  "You must not fabricate competitors, keywords, user research, traffic sources, conversion data, statistical significance, or sample sizes.",
  "You must not claim causality from correlation.",
  "You must not describe an event-count ratio (e.g. CTA clicks / pageviews) as a user conversion rate or session conversion rate.",
  "You must not treat GA4 pageviews and PostHog pageviews as identical measurements.",
  "You must not optimize for signups, firstAppCreated, or appPublished while those metrics are unavailable (null) — never treat null as zero.",
  "You must not select a topic/app that does not appear in availableTopics, or a channel that does not appear in availableChannels — new topic and channel discovery belongs to Signal Mining, not this Agent.",
  "You must not write final landing-page copy, final social copy, or any other publish-ready creative content.",
  "You must not change the CMS, publish an experiment, distribute to a channel, or execute the recommendation — this Agent only records a decision for human review.",
  "If Search Console data is empty for this period, you must not recommend a topic based on claimed search demand or SEO performance.",
  "If the source Growth Report is mock-generated, you must mark your decision as mock-derived and must not present it as a real strategic decision.",
];

export const RESPONSE_SCHEMA_DESCRIPTION = `A single JSON object with these top-level keys:
- decisionSummary: { decisionStatus: "proceed"|"defer", headline, rationale, confidence, recommendedExperimentId: string|null }
- rankedExperimentOptions: 0-5 items (0-3 when decisionStatus is "defer"), each { id, rank (1-based, unique, sequential starting at 1), lever: "topic"|"cta"|"channel", title, target: {topicOrApp, ctaType, channel} (each null or must exist in the supplied decision scope), hypothesis, proposedChange, controlDescription, variantDescription, measurementPlan: {primaryMetricRef, expectedDirection: "increase"|"decrease"|"maintain", successCriterion, guardrailMetricRefs, measurementCaveats}, evidenceRefs (>=1 item), findingRefs, limitationRefs, confidence, dependencies, risks, whyNotHigherRanked }
- recommendedExperiment: required (non-null) when decisionStatus is "proceed" and its experimentId must match decisionSummary.recommendedExperimentId and an option id; otherwise must be null. { experimentId, objective, hypothesis, implementationBrief: {change, unchangedElements, targetPagesOrApps, targetCta, targetChannel}, measurementPlan: {primaryMetricRef, secondaryMetricRefs, guardrailMetricRefs, successCriterion, failureCriterion, minimumObservationRequirement, knownMeasurementLimitations}, evidenceRefs (>=1 item), findingRefs, confidence }
- deferDecision: required (non-null) when decisionStatus is "defer", otherwise must be null. { reason, missingEvidence (>=1 item), requiredNextObservations (>=1 item, each {observation, relatedEvidenceOrLimitationRefs}), earliestDecisionCondition }
- rejectedOrDeferredOptions: items { title, reason, evidenceRefs, limitationRefs }
- handoff: { forNextLoop: items {item, destination: "signal_mining"|"topic_pool"|"asset_generation"|"manual_review", reason}, humanReviewRequired: true }
Every evidenceRefs/relatedEvidenceRefs/relatedEvidenceOrLimitationRefs value must be an "id" from the supplied evidence catalog — never invent one. Every findingRefs value must be an "id" from the supplied finding catalog. Every limitationRefs value must be an "id" from the supplied limitation catalog. target.topicOrApp/target.ctaType/target.channel and implementationBrief.targetCta/targetChannel must exist in the supplied decision scope when non-null — never invent a topic, CTA type, or channel. Do not invent a numeric uplift target or sample size that isn't in the supplied evidence — describe success/failure/minimum-observation criteria in terms of the available metrics instead (e.g. "higher event-based CTA rate than the control during the same window", never "increase conversion by 20%" or "reach significance after 1,000 users"). No unknown top-level or nested keys are allowed.`;

function languageInstruction(language: SupportedLanguage): string {
  return language === "zh-CN"
    ? "Write every string value in the response (headline, rationale, titles, hypotheses, etc.) in Simplified Chinese (zh-CN)."
    : "Write every string value in the response in English (en).";
}

/** Combines the fixed reporting rules with the language instruction for this specific request. */
export function buildReportingRules(language: SupportedLanguage): string[] {
  return [...REPORTING_RULES, languageInstruction(language)];
}

export function buildSystemPrompt(language: SupportedLanguage): string {
  return [
    "You are an evidence-grounded growth experiment decision analyst producing an Experiment Decision for an internal growth loop.",
    "You may only use the supplied decision context: the evidence catalog, finding catalog, limitation catalog, and decision scope.",
    "",
    ...buildReportingRules(language).map((rule) => `- ${rule}`),
    "",
    "This Agent records a decision only. A human reviews and approves before anything is executed, published, or built.",
  ].join("\n");
}

export interface BuildUserPromptParams {
  purpose: string;
  context: ExperimentDecisionContext;
  responseSchemaDescription: string;
}

export function buildUserPrompt(params: BuildUserPromptParams): string {
  const { context } = params;
  const warnings = context.dataQualityWarnings.length > 0 ? context.dataQualityWarnings.map((w) => `- ${w}`).join("\n") : "(none)";
  const notes = context.measurementNotes.length > 0 ? context.measurementNotes.map((n) => `- ${n}`).join("\n") : "(none)";

  return [
    `Purpose: ${params.purpose}`,
    "",
    `Reporting period: ${context.period.start} to ${context.period.end}`,
    `Campaign: ${context.campaign.name} (id: ${context.campaign.id})`,
    "",
    `Source Growth Report: ${context.sourceReportFilename} (provider: ${context.sourceReportProvider}, model: ${context.sourceReportModel}, mock: ${context.sourceReportIsMock})`,
    `Source data-quality status: ${context.dataQualityStatus}`,
    "",
    "Decision scope (the ONLY topics/apps, CTA types, and channels you may target — never propose one outside this list):",
    JSON.stringify(context.decisionScope, null, 2),
    "",
    'Evidence catalog (the ONLY facts you may cite; reference entries by their "id"):',
    JSON.stringify(context.evidenceCatalog, null, 2),
    "",
    'Finding catalog (the source Growth Report\'s own findings; reference by "id"):',
    JSON.stringify(context.findingCatalog, null, 2),
    "",
    'Limitation catalog (known data limitations; reference by "id"):',
    JSON.stringify(context.limitationCatalog, null, 2),
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

export interface BuildExperimentDecisionLLMRequestParams {
  context: ExperimentDecisionContext;
  language: SupportedLanguage;
  maxTokens: number;
}

/** Builds the full, ready-to-send request: rendered system/user prompt strings plus the structured content they came from. */
export function buildExperimentDecisionLLMRequest(params: BuildExperimentDecisionLLMRequestParams): ExperimentDecisionLLMRequest {
  const reportingRules = buildReportingRules(params.language);

  const systemPrompt = buildSystemPrompt(params.language);
  const userPrompt = buildUserPrompt({
    purpose: DECISION_PURPOSE,
    context: params.context,
    responseSchemaDescription: RESPONSE_SCHEMA_DESCRIPTION,
  });

  return {
    purpose: DECISION_PURPOSE,
    language: params.language,
    context: params.context,
    reportingRules,
    responseSchemaDescription: RESPONSE_SCHEMA_DESCRIPTION,
    maxTokens: params.maxTokens,
    systemPrompt,
    userPrompt,
  };
}
