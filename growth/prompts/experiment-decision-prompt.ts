import type { DecisionGate, ExperimentDecisionContext, ExperimentDecisionLLMRequest, ReferenceAliasMaps } from "../types/experiment-decision";
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

// ---------------------------------------------------------------------------
// Two-stage live-generation prompts (Anthropic structured outputs only).
// Used exclusively by growth/llm/anthropic-experiment-decision-provider.ts —
// the single-call functions above remain unchanged and still back the
// --dry-run preview and every non-Anthropic provider. Stage 1 gets the same
// grounded context as the single-call prompt above; stage 2 gets that same
// context plus the stage 1 result and only the instructions its own branch
// needs. Neither stage prompt permits external research or automatic
// execution — both reuse the same REPORTING_RULES.
// ---------------------------------------------------------------------------

export const STAGE1_RESPONSE_SCHEMA_DESCRIPTION =
  'A single JSON object with exactly these required keys: decisionStatus ("proceed"|"defer"), headline, rationale, confidence ("high"|"medium"|"low"). No other keys, no nested objects. rationale must be concise: at most 3 sentences, ideally under 500 characters (hard limit 1500) — a short justification, not a restatement of the evidence catalog or an enumeration of every limitation.';

export const STAGE2_PROCEED_RESPONSE_SCHEMA_DESCRIPTION = `A single JSON object with these required keys:
- rankedExperimentOptions: 1-3 items, each { id, rank (1-based, unique, sequential starting at 1), lever: "topic"|"cta"|"channel", title, targetTopicOrApp (an entry from decisionScope.availableTopics, or "" if not applicable), targetCtaType ("view_demo"|"remix"|"build"|"copy_prompt", or "" if not applicable), targetChannel (an entry from decisionScope.availableChannels, or "" if not applicable), hypothesis, proposedChange, controlDescription, variantDescription, primaryMetricRef (an evidence alias, e.g. "E001"), expectedDirection: "increase"|"decrease"|"maintain", successCriterion, guardrailMetricRefs (evidence aliases), measurementCaveats, evidenceRefs (>=1 evidence alias), findingRefs (finding aliases), limitationRefs (limitation aliases), confidence, dependencies, risks, whyNotHigherRanked (a reason string, or "" for the top-ranked option) }
- recommendedExperimentId: must equal the "id" of exactly one item in rankedExperimentOptions
- handoffItems: items { item, destination: "signal_mining"|"topic_pool"|"asset_generation"|"manual_review", reason }
Reference fields accept ONLY the compact alias supplied in the catalogs below — never the catalog's original id, never an invented alias, never a descriptive name: evidenceRefs, guardrailMetricRefs, and primaryMetricRef accept ONLY evidence aliases ("E###"); findingRefs accepts ONLY finding aliases ("F###"); limitationRefs accepts ONLY limitation aliases ("L###"). Using an alias from the wrong catalog, or any value not present in the supplied alias list, is invalid. targetTopicOrApp/targetCtaType/targetChannel must be "" or an entry from the supplied decision scope — never invent a topic, CTA type, or channel. Do not invent a numeric uplift target or sample size — describe successCriterion in terms of the available metrics instead (e.g. "higher event-based CTA rate than the control during the same window", never "increase conversion by 20%"). No unknown keys are allowed. Do not repeat decisionStatus, and do not produce a separate recommendedExperiment or deferDecision object — the recommended option is identified only by recommendedExperimentId.`;

export const STAGE2_DEFER_RESPONSE_SCHEMA_DESCRIPTION = `A single JSON object with these required keys: reason, missingEvidence (>=1 item), requiredNextObservations (>=1 item, each { observation, relatedEvidenceOrLimitationRefs }), earliestDecisionCondition, handoffItems (items { item, destination: "signal_mining"|"topic_pool"|"asset_generation"|"manual_review", reason }). relatedEvidenceOrLimitationRefs accepts ONLY evidence aliases ("E###") or limitation aliases ("L###") from the supplied catalogs below — never a finding alias ("F###"), never the catalog's original id, never an invented alias. Findings may be discussed in the prose "reason" field, but a finding must never be placed in relatedEvidenceOrLimitationRefs. No unknown keys are allowed. Do not produce rankedExperimentOptions or a recommendedExperiment — this decision is deferred. reason must be concise: at most 3 sentences, ideally under 500 characters (hard limit 1500) — a short justification, not a restatement of the evidence catalog or an enumeration of every limitation; put individual missing items in missingEvidence instead.`;

function decisionGateSummary(gate: Pick<DecisionGate, "decisionStatus" | "headline" | "rationale" | "confidence">): string {
  return JSON.stringify(
    { decisionStatus: gate.decisionStatus, headline: gate.headline, rationale: gate.rationale, confidence: gate.confidence },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// Stage 2 alias-substituted catalog rendering. Stage 1's grounded context
// (buildStage1UserPrompt, unchanged) still shows the real evidence/finding/
// limitation IDs — Stage 1 never returns a reference, so there is nothing to
// alias-constrain. Stage 2 instead sees ONLY the compact alias for each
// catalog entry, never the original id, so there is nothing for the model
// to invent or copy incorrectly from context — it can only cite what's
// printed here, and growth/types/experiment-decision.ts's per-request
// enum-constrained schema rejects anything else at the API level.
// ---------------------------------------------------------------------------

function renderAliasedEvidenceCatalog(context: ExperimentDecisionContext, aliases: ReferenceAliasMaps) {
  return context.evidenceCatalog.map((entry) => ({
    alias: aliases.evidence.toAlias.get(entry.id) ?? "",
    label: entry.label,
    value: entry.value,
    source: entry.source,
    measurementBasis: entry.measurementBasis,
  }));
}

function renderAliasedFindingCatalog(context: ExperimentDecisionContext, aliases: ReferenceAliasMaps) {
  return context.findingCatalog.map((entry) => ({
    alias: aliases.finding.toAlias.get(entry.id) ?? "",
    title: entry.title,
    observation: entry.observation,
    interpretation: entry.interpretation,
    confidence: entry.confidence,
  }));
}

function renderAliasedLimitationCatalog(context: ExperimentDecisionContext, aliases: ReferenceAliasMaps) {
  return context.limitationCatalog.map((entry) => ({
    alias: aliases.limitation.toAlias.get(entry.id) ?? "",
    title: entry.title,
    impact: entry.impact,
  }));
}

/** Same overall shape as buildUserPrompt above, but every catalog entry is keyed by its compact alias instead of its original id — the model is never shown an id it could cite instead of the alias. */
function buildStage2UserPromptBase(context: ExperimentDecisionContext, aliases: ReferenceAliasMaps, responseSchemaDescription: string): string {
  const warnings = context.dataQualityWarnings.length > 0 ? context.dataQualityWarnings.map((w) => `- ${w}`).join("\n") : "(none)";
  const notes = context.measurementNotes.length > 0 ? context.measurementNotes.map((n) => `- ${n}`).join("\n") : "(none)";

  return [
    `Purpose: ${DECISION_PURPOSE}`,
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
    'Evidence catalog — reference ONLY by "alias" below (e.g. "E001"). The alias is the only valid reference value; do not use any other id and never invent one:',
    JSON.stringify(renderAliasedEvidenceCatalog(context, aliases), null, 2),
    "",
    'Finding catalog — reference ONLY by "alias" below (e.g. "F001"). Do not invent an alias, and do not reference a finding by its title or any descriptive name:',
    JSON.stringify(renderAliasedFindingCatalog(context, aliases), null, 2),
    "",
    'Limitation catalog — reference ONLY by "alias" below (e.g. "L001"). Do not invent an alias, and do not reference a limitation by its title:',
    JSON.stringify(renderAliasedLimitationCatalog(context, aliases), null, 2),
    "",
    "Data-quality warnings:",
    warnings,
    "",
    "Measurement notes:",
    notes,
    "",
    "Required response structure:",
    responseSchemaDescription,
  ].join("\n");
}

export function buildStage1SystemPrompt(language: SupportedLanguage): string {
  return [
    "You are an evidence-grounded growth experiment decision analyst producing an Experiment Decision for an internal growth loop. This is stage 1 of 2.",
    "You may only use the supplied decision context: the evidence catalog, finding catalog, limitation catalog, and decision scope.",
    "",
    ...buildReportingRules(language).map((rule) => `- ${rule}`),
    "",
    "Produce ONLY the decision gate — decisionStatus, headline, rationale, confidence. Do not produce ranked experiment options, a recommended experiment, or a defer plan yet; those are decided in a separate stage 2 request after this one.",
    "The rationale must be concise: at most 3 sentences, ideally under 500 characters. State the decisive reason(s) only — do not restate or copy the evidence catalog, and do not enumerate every limitation; save that detail for stage 2 and rely on the deterministic catalogs already recorded elsewhere in this decision.",
    "This Agent records a decision only. A human reviews and approves before anything is executed, published, or built.",
  ].join("\n");
}

export function buildStage1UserPrompt(context: ExperimentDecisionContext): string {
  return buildUserPrompt({
    purpose: DECISION_PURPOSE,
    context,
    responseSchemaDescription: STAGE1_RESPONSE_SCHEMA_DESCRIPTION,
  });
}

export function buildStage2ProceedSystemPrompt(language: SupportedLanguage): string {
  return [
    'You are an evidence-grounded growth experiment decision analyst. This is stage 2 of 2. Stage 1 already decided decisionStatus = "proceed" — your only job now is to produce the ranked experiment options, identify which one is recommended, and list handoff items.',
    "You may only use the supplied decision context: the evidence catalog, finding catalog, limitation catalog, and decision scope.",
    "",
    ...buildReportingRules(language).map((rule) => `- ${rule}`),
    "",
    'Every evidence/finding/limitation catalog entry below is identified ONLY by a compact alias (e.g. "E001", "F001", "L001") — there is no other id shown, and you may return ONLY an alias that is printed in the supplied catalogs. Never invent an alias, never reference a finding by its title or any descriptive name, and never reuse an alias from one catalog in a field that expects another. evidenceRefs, guardrailMetricRefs, and primaryMetricRef accept ONLY evidence aliases ("E###"). findingRefs accepts ONLY finding aliases ("F###"). limitationRefs accepts ONLY limitation aliases ("L###").',
    'Use "" for a target field (targetTopicOrApp/targetCtaType/targetChannel) when it does not apply — never invent a value outside the supplied decision scope.',
    "This Agent records a decision only. A human reviews and approves before anything is executed, published, or built.",
  ].join("\n");
}

export function buildStage2ProceedUserPrompt(context: ExperimentDecisionContext, gate: DecisionGate, aliases: ReferenceAliasMaps): string {
  const base = buildStage2UserPromptBase(context, aliases, STAGE2_PROCEED_RESPONSE_SCHEMA_DESCRIPTION);
  return [base, "", "Stage 1 decision gate (already fixed — do not repeat or change it):", decisionGateSummary(gate)].join("\n");
}

export function buildStage2DeferSystemPrompt(language: SupportedLanguage): string {
  return [
    'You are an evidence-grounded growth experiment decision analyst. This is stage 2 of 2. Stage 1 already decided decisionStatus = "defer" — your only job now is to produce the defer plan and list handoff items.',
    "You may only use the supplied decision context: the evidence catalog, finding catalog, limitation catalog, and decision scope.",
    "",
    ...buildReportingRules(language).map((rule) => `- ${rule}`),
    "",
    'Every evidence/limitation catalog entry below is identified ONLY by a compact alias (e.g. "E001", "L001") — there is no other id shown. relatedEvidenceOrLimitationRefs accepts ONLY an evidence alias ("E###") or a limitation alias ("L###") that is printed in the supplied catalogs — never invent one, never use a finding alias ("F###") there, and never reference anything by a descriptive name. Findings may be discussed in the prose "reason" field, but a finding must never be placed in relatedEvidenceOrLimitationRefs.',
    "Do not propose ranked experiment options or a recommended experiment — this decision is deferred.",
    "The reason must be concise: at most 3 sentences, ideally under 500 characters. State the decisive reason(s) only — do not restate or copy the evidence catalog, and do not enumerate every limitation in the reason; put each individual missing item in missingEvidence instead.",
    "This Agent records a decision only. A human reviews and approves before anything is executed, published, or built.",
  ].join("\n");
}

export function buildStage2DeferUserPrompt(context: ExperimentDecisionContext, gate: DecisionGate, aliases: ReferenceAliasMaps): string {
  const base = buildStage2UserPromptBase(context, aliases, STAGE2_DEFER_RESPONSE_SCHEMA_DESCRIPTION);
  return [base, "", "Stage 1 decision gate (already fixed — do not repeat or change it):", decisionGateSummary(gate)].join("\n");
}
