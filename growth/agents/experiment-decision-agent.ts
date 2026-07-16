import { ensureUniqueId, slugify } from "../lib/ids";
import { buildExperimentDecisionLLMRequest } from "../prompts/experiment-decision-prompt";
import { experimentDecisionAnalysisSchema } from "../types/experiment-decision";
import type { ExperimentDecisionProvider } from "../llm/experiment-decision-provider";
import type { EvidenceEntry, FinalGrowthReport } from "../types/growth-report";
import type {
  CtaType,
  DecisionScope,
  ExperimentDecisionAnalysis,
  ExperimentDecisionContext,
  FinalExperimentDecision,
  FindingCatalogEntry,
  LimitationCatalogEntry,
} from "../types/experiment-decision";
import type { LLMStructuredResult, SupportedLanguage } from "../types/llm";

export class ExperimentDecisionValidationError extends Error {}

// ---------------------------------------------------------------------------
// Deterministic finding/limitation catalogs
// ---------------------------------------------------------------------------

/**
 * Wraps the Growth Report's own findings with stable, prefixed IDs
 * (`finding.{growthReportFindingId}`). The model may only cite these —
 * never an ID it invents itself.
 */
export function buildFindingCatalog(report: FinalGrowthReport): FindingCatalogEntry[] {
  const used = new Set<string>();
  return report.analysis.findings.map((finding) => ({
    id: ensureUniqueId(`finding.${finding.id}`, used),
    title: finding.title,
    observation: finding.observation,
    interpretation: finding.interpretation,
    evidenceRefs: finding.evidenceRefs,
    confidence: finding.confidence,
  }));
}

function existingEvidenceIds(catalog: EvidenceEntry[], ids: string[]): string[] {
  const catalogIds = new Set(catalog.map((entry) => entry.id));
  return ids.filter((id) => catalogIds.has(id));
}

/**
 * Deterministic, code-derived limitations — never left for the model to
 * notice or phrase itself. Always includes the standing v0 limitations
 * (product conversions not connected) plus whichever of the
 * period-specific ones apply, and carries over the Growth Report's own
 * disclosed `dataLimitations` under stable IDs too.
 */
export function buildLimitationCatalog(report: FinalGrowthReport): LimitationCatalogEntry[] {
  const entries: LimitationCatalogEntry[] = [];
  const used = new Set<string>();

  function add(id: string, title: string, impact: string, relatedEvidenceRefs: string[]): void {
    entries.push({ id: ensureUniqueId(id, used), title, impact, relatedEvidenceRefs });
  }

  add(
    "data_limit.product_conversions_not_connected",
    "Whacka product-side conversions are not connected",
    "Signups, first app created, and app published cannot be used as measured outcomes for any experiment — never treat these null values as zero.",
    existingEvidenceIds(report.evidenceCatalog, [
      "data_quality.product_conversions",
      "product_conversions.signups",
      "product_conversions.first_app_created",
      "product_conversions.app_published",
    ])
  );

  if (report.metrics.search.status === "empty") {
    add(
      "data_limit.search_console_empty",
      "Search Console returned zero rows for this period",
      "SEO/search-demand comparisons between topics cannot be made from this data.",
      existingEvidenceIds(report.evidenceCatalog, ["search.status", "search.clicks", "search.impressions"])
    );
  } else if (report.metrics.search.status === "missing") {
    add(
      "data_limit.search_console_missing",
      "No Search Console snapshot was available for this period",
      "SEO/search-demand comparisons between topics cannot be made from this data.",
      existingEvidenceIds(report.evidenceCatalog, ["search.status"])
    );
  }

  if (report.generation.isMock) {
    add(
      "data_limit.mock_growth_report",
      "The source Growth Report was mock-generated",
      "This decision is derived from placeholder analysis for pipeline validation, not a real strategic report.",
      []
    );
  }

  if (report.dataQuality.overallStatus === "partial") {
    add(
      "data_limit.partial_data_quality",
      "Underlying data quality is partial",
      "Some period-level metrics (e.g. GA4 active users, PostHog unique users) are unavailable and were not summed; treat related conclusions cautiously.",
      existingEvidenceIds(report.evidenceCatalog, ["data_quality.overall_status"])
    );
  }

  for (const limitation of report.analysis.dataLimitations) {
    add(
      `data_limit.from_report.${slugify(limitation.title)}`,
      limitation.title,
      limitation.impact,
      existingEvidenceIds(report.evidenceCatalog, limitation.relatedEvidenceRefs)
    );
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Deterministic decision scope: only entities actually observed in the
// Growth Report. New topic/channel discovery belongs to Signal Mining.
// ---------------------------------------------------------------------------

export function buildDecisionScope(report: FinalGrowthReport): DecisionScope {
  const { metrics } = report;

  const availableTopics = [...metrics.behavior.byApp]
    .filter((app) => app.appSlug !== "unassigned")
    .sort((a, b) => b.totalCtaClicks - a.totalCtaClicks)
    .map((app) => app.appName ?? app.appSlug);

  const ctaTypeCounts: { type: CtaType; count: number }[] = [
    { type: "view_demo", count: metrics.behavior.eventTotals.viewDemoClicks },
    { type: "remix", count: metrics.behavior.eventTotals.remixClicks },
    { type: "build", count: metrics.behavior.eventTotals.buildClicks },
    { type: "copy_prompt", count: metrics.behavior.eventTotals.copyPromptClicks },
  ];
  const availableCtaTypes = ctaTypeCounts.filter((entry) => entry.count > 0).map((entry) => entry.type);

  const channels = new Set<string>();
  for (const source of metrics.traffic.topSources) {
    channels.add(`${source.source} / ${source.medium}`);
  }
  for (const row of metrics.behavior.byUtmSource) {
    if (row.key !== "unassigned") channels.add(`utm_source=${row.key}`);
  }
  for (const row of metrics.behavior.byUtmMedium) {
    if (row.key !== "unassigned") channels.add(`utm_medium=${row.key}`);
  }
  for (const row of metrics.behavior.byUtmCampaign) {
    if (row.key !== "unassigned") channels.add(`utm_campaign=${row.key}`);
  }

  return { availableTopics, availableCtaTypes, availableChannels: [...channels] };
}

export function buildExperimentDecisionContext(
  report: FinalGrowthReport,
  sourceReportFilename: string,
  sourceReportSha256: string
): ExperimentDecisionContext {
  return {
    period: report.period,
    campaign: report.campaign,
    sourceReportFilename,
    sourceReportSha256,
    sourceReportGeneratedAt: report.generatedAt,
    sourceReportProvider: report.generation.provider,
    sourceReportModel: report.generation.model,
    sourceReportIsMock: report.generation.isMock,
    metrics: report.metrics,
    evidenceCatalog: report.evidenceCatalog,
    findingCatalog: buildFindingCatalog(report),
    limitationCatalog: buildLimitationCatalog(report),
    decisionScope: buildDecisionScope(report),
    dataQualityStatus: report.dataQuality.overallStatus,
    dataQualityWarnings: report.dataQuality.warnings,
    measurementNotes: report.dataQuality.measurementNotes,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertKnown(ids: string[], known: Set<string>, label: string): void {
  const unknown = [...new Set(ids.filter((id) => !known.has(id)))];
  if (unknown.length > 0) {
    throw new ExperimentDecisionValidationError(`Model response referenced unknown ${label}: ${unknown.join(", ")}.`);
  }
}

function assertMeasurable(evidenceId: string, catalog: EvidenceEntry[]): void {
  const entry = catalog.find((e) => e.id === evidenceId);
  if (!entry) return; // already reported by assertKnown
  const isMeasurable = entry.value === null || typeof entry.value === "number";
  if (!isMeasurable) {
    throw new ExperimentDecisionValidationError(
      `primaryMetricRef "${evidenceId}" does not reference a measurable (numeric) evidence item — its value is ${JSON.stringify(entry.value)}.`
    );
  }
}

/**
 * Validates a provider's raw response before it's trusted downstream. Two
 * layers, mirroring growth-report-agent.ts: (1) the static Zod schema —
 * re-checked here for every provider (not just Anthropic's, since the Mock
 * Provider skips the SDK's own client-side parsing); (2) cross-referential
 * rules the static schema can't express — every cited evidence/finding/
 * limitation ID must exist in its catalog, every target must fall inside
 * the deterministic decision scope, ranks/IDs must be well-formed, and the
 * proceed/defer field pairing must be internally consistent. Throws
 * ExperimentDecisionValidationError on any failure — callers must not
 * write a final decision when this throws.
 */
export function validateDecisionAnalysis(rawData: unknown, context: ExperimentDecisionContext): ExperimentDecisionAnalysis {
  const parsed = experimentDecisionAnalysisSchema.safeParse(rawData);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new ExperimentDecisionValidationError(`Model response did not match the required schema: ${issues.join("; ")}`);
  }
  const analysis = parsed.data;

  const evidenceIds = new Set(context.evidenceCatalog.map((entry) => entry.id));
  const findingIds = new Set(context.findingCatalog.map((entry) => entry.id));
  const limitationIds = new Set(context.limitationCatalog.map((entry) => entry.id));
  const evidenceOrLimitationIds = new Set([...evidenceIds, ...limitationIds]);

  const topics = new Set(context.decisionScope.availableTopics);
  const ctaTypes = new Set(context.decisionScope.availableCtaTypes);
  const channels = new Set(context.decisionScope.availableChannels);

  const seenOptionIds = new Set<string>();
  for (const option of analysis.rankedExperimentOptions) {
    if (seenOptionIds.has(option.id)) {
      throw new ExperimentDecisionValidationError(`Duplicate rankedExperimentOptions id "${option.id}".`);
    }
    seenOptionIds.add(option.id);

    assertKnown(option.evidenceRefs, evidenceIds, "evidence ID(s)");
    assertKnown([option.measurementPlan.primaryMetricRef, ...option.measurementPlan.guardrailMetricRefs], evidenceIds, "measurement evidence ID(s)");
    assertKnown(option.findingRefs, findingIds, "finding ID(s)");
    assertKnown(option.limitationRefs, limitationIds, "limitation ID(s)");
    assertMeasurable(option.measurementPlan.primaryMetricRef, context.evidenceCatalog);

    if (option.target.topicOrApp !== null && !topics.has(option.target.topicOrApp)) {
      throw new ExperimentDecisionValidationError(
        `Option "${option.id}" targets a topic/app ("${option.target.topicOrApp}") outside the supplied decision scope.`
      );
    }
    if (option.target.ctaType !== null && !ctaTypes.has(option.target.ctaType)) {
      throw new ExperimentDecisionValidationError(
        `Option "${option.id}" targets a CTA type ("${option.target.ctaType}") outside the supplied decision scope.`
      );
    }
    if (option.target.channel !== null && !channels.has(option.target.channel)) {
      throw new ExperimentDecisionValidationError(
        `Option "${option.id}" targets a channel ("${option.target.channel}") outside the supplied decision scope.`
      );
    }
  }

  const actualRanks = analysis.rankedExperimentOptions.map((option) => option.rank);
  const sortedRanks = [...actualRanks].sort((a, b) => a - b);
  const expectedRanks = analysis.rankedExperimentOptions.map((_, index) => index + 1);
  if (JSON.stringify(sortedRanks) !== JSON.stringify(expectedRanks)) {
    throw new ExperimentDecisionValidationError(
      `rankedExperimentOptions ranks must be unique and sequential starting at 1; got [${actualRanks.join(", ")}].`
    );
  }

  for (const option of analysis.rejectedOrDeferredOptions) {
    assertKnown(option.evidenceRefs, evidenceIds, "evidence ID(s)");
    assertKnown(option.limitationRefs, limitationIds, "limitation ID(s)");
  }

  if (analysis.decisionSummary.decisionStatus === "proceed") {
    if (analysis.rankedExperimentOptions.length === 0) {
      throw new ExperimentDecisionValidationError('decisionStatus is "proceed" but rankedExperimentOptions is empty; at least one option is required.');
    }
    if (analysis.decisionSummary.recommendedExperimentId === null) {
      throw new ExperimentDecisionValidationError('decisionStatus is "proceed" but recommendedExperimentId is null.');
    }
    if (!seenOptionIds.has(analysis.decisionSummary.recommendedExperimentId)) {
      throw new ExperimentDecisionValidationError(
        `recommendedExperimentId "${analysis.decisionSummary.recommendedExperimentId}" does not match any rankedExperimentOptions id.`
      );
    }
    if (!analysis.recommendedExperiment) {
      throw new ExperimentDecisionValidationError('decisionStatus is "proceed" but recommendedExperiment is null.');
    }
    if (analysis.recommendedExperiment.experimentId !== analysis.decisionSummary.recommendedExperimentId) {
      throw new ExperimentDecisionValidationError("recommendedExperiment.experimentId does not match decisionSummary.recommendedExperimentId.");
    }
    if (analysis.deferDecision !== null) {
      throw new ExperimentDecisionValidationError('decisionStatus is "proceed" but deferDecision is non-null.');
    }

    const recommended = analysis.recommendedExperiment;
    assertKnown(recommended.evidenceRefs, evidenceIds, "evidence ID(s)");
    assertKnown(
      [recommended.measurementPlan.primaryMetricRef, ...recommended.measurementPlan.secondaryMetricRefs, ...recommended.measurementPlan.guardrailMetricRefs],
      evidenceIds,
      "measurement evidence ID(s)"
    );
    assertKnown(recommended.findingRefs, findingIds, "finding ID(s)");
    assertMeasurable(recommended.measurementPlan.primaryMetricRef, context.evidenceCatalog);

    if (recommended.implementationBrief.targetCta !== null && !ctaTypes.has(recommended.implementationBrief.targetCta)) {
      throw new ExperimentDecisionValidationError(
        `recommendedExperiment targets a CTA type ("${recommended.implementationBrief.targetCta}") outside the supplied decision scope.`
      );
    }
    if (recommended.implementationBrief.targetChannel !== null && !channels.has(recommended.implementationBrief.targetChannel)) {
      throw new ExperimentDecisionValidationError(
        `recommendedExperiment targets a channel ("${recommended.implementationBrief.targetChannel}") outside the supplied decision scope.`
      );
    }
  } else {
    if (analysis.decisionSummary.recommendedExperimentId !== null) {
      throw new ExperimentDecisionValidationError('decisionStatus is "defer" but recommendedExperimentId is non-null.');
    }
    if (analysis.recommendedExperiment !== null) {
      throw new ExperimentDecisionValidationError('decisionStatus is "defer" but recommendedExperiment is non-null.');
    }
    if (!analysis.deferDecision) {
      throw new ExperimentDecisionValidationError('decisionStatus is "defer" but deferDecision is null.');
    }
    if (analysis.rankedExperimentOptions.length > 3) {
      throw new ExperimentDecisionValidationError('decisionStatus is "defer" but rankedExperimentOptions has more than 3 provisional options.');
    }
    assertKnown(
      analysis.deferDecision.requiredNextObservations.flatMap((observation) => observation.relatedEvidenceOrLimitationRefs),
      evidenceOrLimitationIds,
      "evidence or limitation ID(s)"
    );
  }

  return analysis;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunExperimentDecisionAgentParams {
  report: FinalGrowthReport;
  sourceReportFilename: string;
  sourceReportSha256: string;
  language: SupportedLanguage;
  maxTokens: number;
  provider: ExperimentDecisionProvider;
  /** Injectable for deterministic tests; defaults to the current time. */
  generatedAt?: string;
}

/**
 * Runs the full Experiment Decision Agent pipeline against an already-
 * loaded, already-validated Growth Report: build the deterministic
 * context (catalogs + decision scope), build the LLM request, call the
 * given provider, validate the response, and assemble the final decision.
 * Depends only on the provider-neutral ExperimentDecisionProvider
 * interface — never imports an SDK directly.
 */
export async function runExperimentDecisionAgent(params: RunExperimentDecisionAgentParams): Promise<FinalExperimentDecision> {
  const context = buildExperimentDecisionContext(params.report, params.sourceReportFilename, params.sourceReportSha256);

  const request = buildExperimentDecisionLLMRequest({ context, language: params.language, maxTokens: params.maxTokens });

  const result = await params.provider.generateStructuredDecision(request);

  const decision = validateDecisionAnalysis(result.data, context);

  return assembleFinalDecision({
    report: params.report,
    context,
    decision,
    result: { ...result, data: decision },
    isMock: params.provider.name === "mock",
    language: params.language,
    generatedAt: params.generatedAt,
  });
}

interface AssembleFinalDecisionParams {
  report: FinalGrowthReport;
  context: ExperimentDecisionContext;
  decision: ExperimentDecisionAnalysis;
  result: LLMStructuredResult<ExperimentDecisionAnalysis>;
  isMock: boolean;
  language: SupportedLanguage;
  generatedAt?: string;
}

function assembleFinalDecision(params: AssembleFinalDecisionParams): FinalExperimentDecision {
  const { report, context } = params;

  return {
    schemaVersion: "1.0.0",
    decisionType: "experiment_decision",
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    period: report.period,
    campaign: report.campaign,
    provenance: {
      sourceGrowthReportFilename: context.sourceReportFilename,
      sourceGrowthReportSha256: context.sourceReportSha256,
      sourceGrowthReportGeneratedAt: context.sourceReportGeneratedAt,
      sourceGrowthReportProvider: context.sourceReportProvider,
      sourceGrowthReportModel: context.sourceReportModel,
      sourceGrowthReportIsMock: context.sourceReportIsMock,
      sourceDataQualityStatus: context.dataQualityStatus,
    },
    generation: {
      provider: params.result.provider,
      model: params.result.model,
      language: params.language,
      isMock: params.isMock,
      requestId: params.result.requestId,
      stopReason: params.result.stopReason,
      usage: { inputTokens: params.result.inputTokens, outputTokens: params.result.outputTokens },
    },
    decisionScope: context.decisionScope,
    evidenceCatalog: context.evidenceCatalog,
    findingCatalog: context.findingCatalog,
    limitationCatalog: context.limitationCatalog,
    decision: params.decision,
    humanReview: {
      required: true,
      approved: false,
      approvedBy: null,
      approvedAt: null,
      note: "The Experiment Decision Agent does not execute changes automatically.",
    },
    dataQuality: report.dataQuality,
  };
}
