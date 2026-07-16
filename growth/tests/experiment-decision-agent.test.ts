import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ExperimentDecisionValidationError,
  buildDecisionScope,
  buildExperimentDecisionContext,
  buildFindingCatalog,
  buildLimitationCatalog,
  runExperimentDecisionAgent,
  validateDecisionAnalysis,
} from "../agents/experiment-decision-agent";
import { experimentDecisionAnalysisSchema } from "../types/experiment-decision";
import type { ExperimentDecisionProvider } from "../llm/experiment-decision-provider";
import type { FinalGrowthReport } from "../types/growth-report";
import type { ExperimentDecisionAnalysis, ExperimentDecisionContext, ExperimentDecisionLLMRequest } from "../types/experiment-decision";
import type { LLMStructuredResult } from "../types/llm";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureReport(overrides: Partial<FinalGrowthReport> = {}): FinalGrowthReport {
  return {
    schemaVersion: "1.0.0",
    reportType: "growth_report",
    generatedAt: "2026-07-15T00:00:00.000Z",
    period: PERIOD,
    campaign: CAMPAIGN,
    provenance: {
      sourceSummaryFilename: "growth-summary-2026-07-08_to_2026-07-14.json",
      sourceSummarySha256: "abc123",
      sourceSummaryGeneratedAt: "2026-07-14T23:00:00.000Z",
      dataQualityStatus: "partial",
    },
    generation: {
      provider: "anthropic",
      model: "claude-test-model",
      language: "en",
      isMock: false,
      requestId: "req_1",
      stopReason: "end_turn",
      usage: { inputTokens: 500, outputTokens: 300 },
    },
    metrics: {
      traffic: {
        overview: { sessions: 100, screenPageViews: 300, engagedSessions: 60, engagementRate: 0.6, activeUsers: null, activeUsersMeasurementNote: "note" },
        acquisition: [],
        landingPages: [],
        topSources: [{ source: "google", medium: "organic", campaign: "(not set)", sessions: 40, engagedSessions: 20, engagementRate: 0.5 }],
        topLandingPages: [],
      },
      behavior: {
        eventTotals: { pageViews: 300, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, totalCtaClicks: 50 },
        uniqueUsers: null,
        uniqueUsersMeasurementNote: "note",
        byApp: [
          { appSlug: "unassigned", appName: null, pageViews: 300, viewDemoClicks: 0, remixClicks: 0, buildClicks: 0, copyPromptClicks: 0, totalCtaClicks: 0, eventBasedCtaRate: 0 },
          { appSlug: "bookly", appName: "Bookly", pageViews: 0, viewDemoClicks: 12, remixClicks: 10, buildClicks: 6, copyPromptClicks: 3, totalCtaClicks: 31, eventBasedCtaRate: null },
          { appSlug: "orderly", appName: "Orderly", pageViews: 0, viewDemoClicks: 8, remixClicks: 5, buildClicks: 4, copyPromptClicks: 2, totalCtaClicks: 19, eventBasedCtaRate: null },
        ],
        byPageType: [],
        byUtmSource: [
          { key: "unassigned", pageViews: 300, viewDemoClicks: 0, remixClicks: 0, buildClicks: 0, copyPromptClicks: 0, totalCtaClicks: 0 },
          { key: "growth_site", pageViews: 0, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, totalCtaClicks: 50 },
        ],
        byUtmMedium: [{ key: "demo_click", pageViews: 0, viewDemoClicks: 20, remixClicks: 0, buildClicks: 0, copyPromptClicks: 0, totalCtaClicks: 20 }],
        byUtmCampaign: [{ key: "small_business_toolkit", pageViews: 0, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, totalCtaClicks: 50 }],
        byUtmContent: [],
      },
      search: {
        status: "ok",
        totals: { clicks: 20, impressions: 500, ctr: 0.04, averagePosition: 8.5 },
        daily: [],
        topQueries: [],
        topPages: [],
        queryPages: [],
      },
      productConversions: { signups: null, firstAppCreated: null, appPublished: null, status: "not_connected", note: "Whacka product-side attribution has not been connected yet." },
    },
    evidenceCatalog: [
      { id: "traffic.sessions", label: "GA4 sessions", value: 100, source: "GA4", measurementBasis: "x" },
      { id: "traffic.engagement_rate", label: "GA4 engagement rate", value: 0.6, source: "GA4", measurementBasis: "x" },
      { id: "behavior.page_views", label: "PostHog pageviews", value: 300, source: "PostHog", measurementBasis: "x" },
      { id: "behavior.total_cta_clicks", label: "PostHog total CTA clicks", value: 50, source: "PostHog", measurementBasis: "x" },
      { id: "behavior.event_based_cta_rate", label: "Event-based CTA rate", value: 0.1667, source: "PostHog", measurementBasis: "x" },
      { id: "search.status", label: "Search Console data status", value: "ok", source: "Search Console", measurementBasis: "x" },
      { id: "search.clicks", label: "Search Console clicks", value: 20, source: "Search Console", measurementBasis: "x" },
      { id: "data_quality.overall_status", label: "Overall data-quality status", value: "partial", source: "Normalizer", measurementBasis: "x" },
      { id: "data_quality.product_conversions", label: "Whacka product-conversion status", value: "not_connected", source: "Normalizer", measurementBasis: "x" },
      { id: "product_conversions.signups", label: "Whacka signups", value: null, source: "Normalizer", measurementBasis: "x" },
    ],
    analysis: {
      executiveSummary: { headline: "H", summary: "S", confidence: "medium" },
      findings: [
        {
          id: "finding_1",
          category: "traffic",
          title: "Traffic finding",
          observation: "O",
          interpretation: "I",
          evidenceRefs: ["traffic.sessions"],
          confidence: "medium",
          caveats: [],
        },
        {
          id: "finding_2",
          category: "cta_behavior",
          title: "CTA finding",
          observation: "O2",
          interpretation: "I2",
          evidenceRefs: ["behavior.total_cta_clicks", "behavior.event_based_cta_rate"],
          confidence: "medium",
          caveats: [],
        },
      ],
      funnelObservations: [],
      channelAndContentObservations: [],
      anomaliesOrNotableSignals: [],
      dataLimitations: [
        {
          title: "Whacka product-side conversions are not connected",
          impact: "Signups, first-app-created, and app-published counts are unavailable.",
          relatedEvidenceRefs: ["data_quality.product_conversions"],
        },
      ],
      decisionInputs: { signalsWorthReviewing: [], questionsForDecisionAgent: [{ question: "Q?", reason: "R", evidenceRefs: ["traffic.sessions"] }] },
    },
    dataQuality: {
      overallStatus: "partial",
      dateRangeMatch: true,
      missingSources: [],
      emptySources: [],
      warnings: ["GA4 daily activeUsers were not summed into a period-level unique-user metric.", "Whacka product-side signup and activation attribution is not connected."],
      measurementNotes: ["note1"],
    },
    ...overrides,
  };
}

describe("buildFindingCatalog", () => {
  it("prefixes Growth Report finding IDs deterministically", () => {
    const catalog = buildFindingCatalog(fixtureReport());
    expect(catalog.map((entry) => entry.id)).toEqual(["finding.finding_1", "finding.finding_2"]);
  });

  it("has no duplicate IDs even if two Growth Report findings share the same raw id", () => {
    const report = fixtureReport();
    report.analysis.findings = [...report.analysis.findings, { ...report.analysis.findings[0] }];
    const catalog = buildFindingCatalog(report);
    const ids = catalog.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is deterministic across repeated calls", () => {
    const report = fixtureReport();
    expect(buildFindingCatalog(report)).toEqual(buildFindingCatalog(report));
  });
});

describe("buildLimitationCatalog", () => {
  it("always includes the product-conversions-not-connected limitation", () => {
    const catalog = buildLimitationCatalog(fixtureReport());
    expect(catalog.find((entry) => entry.id === "data_limit.product_conversions_not_connected")).toBeDefined();
  });

  it("represents empty Search Console as a limitation", () => {
    const report = fixtureReport({
      metrics: { ...fixtureReport().metrics, search: { status: "empty", totals: { clicks: 0, impressions: 0, ctr: null, averagePosition: null }, daily: [], topQueries: [], topPages: [], queryPages: [] } },
    });
    const catalog = buildLimitationCatalog(report);
    expect(catalog.find((entry) => entry.id === "data_limit.search_console_empty")).toBeDefined();
  });

  it("represents missing Search Console as a limitation", () => {
    const report = fixtureReport({
      metrics: { ...fixtureReport().metrics, search: { status: "missing", totals: { clicks: 0, impressions: 0, ctr: null, averagePosition: null }, daily: [], topQueries: [], topPages: [], queryPages: [] } },
    });
    const catalog = buildLimitationCatalog(report);
    expect(catalog.find((entry) => entry.id === "data_limit.search_console_missing")).toBeDefined();
  });

  it("represents a mock source Growth Report as a limitation", () => {
    const report = fixtureReport({ generation: { ...fixtureReport().generation, isMock: true } });
    const catalog = buildLimitationCatalog(report);
    expect(catalog.find((entry) => entry.id === "data_limit.mock_growth_report")).toBeDefined();
  });

  it("omits the mock-source limitation when the source report is not mock", () => {
    const catalog = buildLimitationCatalog(fixtureReport({ generation: { ...fixtureReport().generation, isMock: false } }));
    expect(catalog.find((entry) => entry.id === "data_limit.mock_growth_report")).toBeUndefined();
  });

  it("represents partial data quality as a limitation", () => {
    const catalog = buildLimitationCatalog(fixtureReport());
    expect(catalog.find((entry) => entry.id === "data_limit.partial_data_quality")).toBeDefined();
  });

  it("carries over the Growth Report's own disclosed limitations", () => {
    const catalog = buildLimitationCatalog(fixtureReport());
    expect(catalog.find((entry) => entry.id.startsWith("data_limit.from_report."))).toBeDefined();
  });

  it("has no duplicate IDs", () => {
    const ids = buildLimitationCatalog(fixtureReport()).map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildDecisionScope", () => {
  it("derives availableTopics only from observed, non-'unassigned' apps", () => {
    const scope = buildDecisionScope(fixtureReport());
    expect(scope.availableTopics).toEqual(["Bookly", "Orderly"]);
    expect(scope.availableTopics).not.toContain("unassigned");
  });

  it("never invents a topic not present in the report", () => {
    const scope = buildDecisionScope(fixtureReport());
    expect(scope.availableTopics).not.toContain("TikTok");
  });

  it("derives availableCtaTypes only from CTA types with nonzero observed clicks", () => {
    const report = fixtureReport();
    report.metrics.behavior.eventTotals = { pageViews: 300, viewDemoClicks: 5, remixClicks: 0, buildClicks: 0, copyPromptClicks: 0, totalCtaClicks: 5 };
    const scope = buildDecisionScope(report);
    expect(scope.availableCtaTypes).toEqual(["view_demo"]);
  });

  it("never invents a channel that wasn't observed", () => {
    const scope = buildDecisionScope(fixtureReport());
    expect(scope.availableChannels).not.toContain("tiktok");
    expect(scope.availableChannels).not.toContain("google_ads");
  });

  it("represents channels as unavailable (empty array) when no meaningful channel data exists", () => {
    const report = fixtureReport();
    report.metrics.traffic.topSources = [];
    report.metrics.behavior.byUtmSource = [{ key: "unassigned", pageViews: 300, viewDemoClicks: 0, remixClicks: 0, buildClicks: 0, copyPromptClicks: 0, totalCtaClicks: 0 }];
    report.metrics.behavior.byUtmMedium = [];
    report.metrics.behavior.byUtmCampaign = [];
    const scope = buildDecisionScope(report);
    expect(scope.availableChannels).toEqual([]);
  });

  it("is deterministic across repeated calls", () => {
    const report = fixtureReport();
    expect(buildDecisionScope(report)).toEqual(buildDecisionScope(report));
  });
});

describe("buildExperimentDecisionContext", () => {
  it("preserves the evidence catalog exactly, without mutation", () => {
    const report = fixtureReport();
    const originalJson = JSON.stringify(report.evidenceCatalog);
    const context = buildExperimentDecisionContext(report, "growth-report-x.json", "hash123");
    expect(context.evidenceCatalog).toEqual(report.evidenceCatalog);
    expect(JSON.stringify(report.evidenceCatalog)).toBe(originalJson);
  });

  it("keeps null metrics null rather than coercing to zero", () => {
    const context = buildExperimentDecisionContext(fixtureReport(), "f.json", "hash");
    expect(context.metrics.productConversions.signups).toBeNull();
    expect(context.metrics.traffic.overview.activeUsers).toBeNull();
  });
});

function validProceedAnalysis(context: ExperimentDecisionContext): ExperimentDecisionAnalysis {
  return {
    decisionSummary: {
      decisionStatus: "proceed",
      headline: "Headline",
      rationale: "Rationale",
      confidence: "low",
      recommendedExperimentId: "experiment_1",
    },
    rankedExperimentOptions: [
      {
        id: "experiment_1",
        rank: 1,
        lever: "cta",
        title: "Title",
        target: { topicOrApp: context.decisionScope.availableTopics[0] ?? null, ctaType: context.decisionScope.availableCtaTypes[0] ?? null, channel: null },
        hypothesis: "H",
        proposedChange: "P",
        controlDescription: "C",
        variantDescription: "V",
        measurementPlan: {
          primaryMetricRef: "behavior.event_based_cta_rate",
          expectedDirection: "increase",
          successCriterion: "Higher event-based CTA rate than the control.",
          guardrailMetricRefs: ["traffic.sessions"],
          measurementCaveats: [],
        },
        evidenceRefs: ["behavior.event_based_cta_rate"],
        findingRefs: ["finding.finding_2"],
        limitationRefs: ["data_limit.product_conversions_not_connected"],
        confidence: "low",
        dependencies: [],
        risks: [],
        whyNotHigherRanked: null,
      },
    ],
    recommendedExperiment: {
      experimentId: "experiment_1",
      objective: "Objective",
      hypothesis: "H",
      implementationBrief: {
        change: "Change",
        unchangedElements: [],
        targetPagesOrApps: [context.decisionScope.availableTopics[0] ?? "n/a"],
        targetCta: context.decisionScope.availableCtaTypes[0] ?? null,
        targetChannel: null,
      },
      measurementPlan: {
        primaryMetricRef: "behavior.event_based_cta_rate",
        secondaryMetricRefs: [],
        guardrailMetricRefs: ["traffic.sessions"],
        successCriterion: "Higher event-based CTA rate than the control.",
        failureCriterion: "No improvement.",
        minimumObservationRequirement: "Both control and variant must receive measurable pageviews.",
        knownMeasurementLimitations: [],
      },
      evidenceRefs: ["behavior.event_based_cta_rate"],
      findingRefs: ["finding.finding_2"],
      confidence: "low",
    },
    deferDecision: null,
    rejectedOrDeferredOptions: [],
    handoff: { forNextLoop: [], humanReviewRequired: true },
  };
}

function validDeferAnalysis(context: ExperimentDecisionContext): ExperimentDecisionAnalysis {
  return {
    decisionSummary: { decisionStatus: "defer", headline: "H", rationale: "R", confidence: "low", recommendedExperimentId: null },
    rankedExperimentOptions: [],
    recommendedExperiment: null,
    deferDecision: {
      reason: "Not enough evidence.",
      missingEvidence: ["More data."],
      requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: [context.evidenceCatalog[0]?.id ?? "traffic.sessions"] }],
      earliestDecisionCondition: "Once more data is available.",
    },
    rejectedOrDeferredOptions: [],
    handoff: { forNextLoop: [], humanReviewRequired: true },
  };
}

describe("validateDecisionAnalysis", () => {
  const report = fixtureReport();
  const context = buildExperimentDecisionContext(report, "growth-report-x.json", "hash");

  it("accepts a valid proceed decision", () => {
    expect(() => validateDecisionAnalysis(validProceedAnalysis(context), context)).not.toThrow();
  });

  it("accepts a valid defer decision", () => {
    expect(() => validateDecisionAnalysis(validDeferAnalysis(context), context)).not.toThrow();
  });

  it("rejects proceed without a recommendation", () => {
    const bad = validProceedAnalysis(context);
    bad.recommendedExperiment = null;
    expect(() => validateDecisionAnalysis(bad, context)).toThrow(ExperimentDecisionValidationError);
  });

  it("rejects defer that still sets a recommendation", () => {
    const bad = validDeferAnalysis(context);
    bad.decisionSummary.recommendedExperimentId = "experiment_1";
    expect(() => validateDecisionAnalysis(bad, context)).toThrow(ExperimentDecisionValidationError);
  });

  it("rejects a recommendedExperimentId that doesn't match any option", () => {
    const bad = validProceedAnalysis(context);
    bad.decisionSummary.recommendedExperimentId = "experiment_missing";
    expect(() => validateDecisionAnalysis(bad, context)).toThrow(ExperimentDecisionValidationError);
  });

  it("rejects duplicate option IDs", () => {
    const bad = validProceedAnalysis(context);
    bad.rankedExperimentOptions.push({ ...bad.rankedExperimentOptions[0], rank: 2 });
    expect(() => validateDecisionAnalysis(bad, context)).toThrow(ExperimentDecisionValidationError);
  });

  it("rejects non-sequential ranks", () => {
    const bad = validProceedAnalysis(context);
    bad.rankedExperimentOptions.push({ ...bad.rankedExperimentOptions[0], id: "experiment_2", rank: 3 });
    expect(() => validateDecisionAnalysis(bad, context)).toThrow(ExperimentDecisionValidationError);
  });

  it("rejects an unknown evidence reference", () => {
    const bad = validProceedAnalysis(context);
    bad.rankedExperimentOptions[0].evidenceRefs = ["nonexistent.evidence"];
    expect(() => validateDecisionAnalysis(bad, context)).toThrow(ExperimentDecisionValidationError);
  });

  it("rejects an unknown finding reference", () => {
    const bad = validProceedAnalysis(context);
    bad.rankedExperimentOptions[0].findingRefs = ["finding.nonexistent"];
    expect(() => validateDecisionAnalysis(bad, context)).toThrow(ExperimentDecisionValidationError);
  });

  it("rejects an unknown limitation reference", () => {
    const bad = validProceedAnalysis(context);
    bad.rankedExperimentOptions[0].limitationRefs = ["data_limit.nonexistent"];
    expect(() => validateDecisionAnalysis(bad, context)).toThrow(ExperimentDecisionValidationError);
  });

  it("rejects a target topic outside the decision scope", () => {
    const bad = validProceedAnalysis(context);
    bad.rankedExperimentOptions[0].target.topicOrApp = "TikTok";
    expect(() => validateDecisionAnalysis(bad, context)).toThrow(ExperimentDecisionValidationError);
  });

  it("rejects a target channel outside the decision scope", () => {
    const bad = validProceedAnalysis(context);
    bad.rankedExperimentOptions[0].target.channel = "reddit";
    expect(() => validateDecisionAnalysis(bad, context)).toThrow(ExperimentDecisionValidationError);
  });

  it("rejects a primaryMetricRef that isn't a measurable (numeric) evidence entry", () => {
    const bad = validProceedAnalysis(context);
    bad.rankedExperimentOptions[0].measurementPlan.primaryMetricRef = "search.status"; // categorical string value
    expect(() => validateDecisionAnalysis(bad, context)).toThrow(ExperimentDecisionValidationError);
  });

  it("rejects an unsupported confidence enum value", () => {
    const bad = validProceedAnalysis(context) as unknown as Record<string, unknown>;
    (bad.decisionSummary as Record<string, unknown>).confidence = "extreme";
    expect(() => validateDecisionAnalysis(bad, context)).toThrow(ExperimentDecisionValidationError);
  });

  it("rejects unknown top-level schema keys", () => {
    const bad = validProceedAnalysis(context) as unknown as Record<string, unknown>;
    bad.unexpectedKey = "surprise";
    expect(() => validateDecisionAnalysis(bad, context)).toThrow(ExperimentDecisionValidationError);
  });

  it("rejects empty evidenceRefs on a ranked option", () => {
    const bad = validProceedAnalysis(context);
    bad.rankedExperimentOptions[0].evidenceRefs = [];
    expect(() => validateDecisionAnalysis(bad, context)).toThrow(ExperimentDecisionValidationError);
  });
});

class StubProvider implements ExperimentDecisionProvider {
  readonly name: string;
  private readonly result: LLMStructuredResult<unknown>;
  public lastRequest: ExperimentDecisionLLMRequest | undefined;

  constructor(name: string, result: LLMStructuredResult<unknown>) {
    this.name = name;
    this.result = result;
  }

  async generateStructuredDecision(request: ExperimentDecisionLLMRequest): Promise<LLMStructuredResult<ExperimentDecisionAnalysis>> {
    this.lastRequest = request;
    return this.result as LLMStructuredResult<ExperimentDecisionAnalysis>;
  }
}

describe("runExperimentDecisionAgent", () => {
  it("assembles a proceed decision with provenance, decision scope, and catalogs preserved", async () => {
    const report = fixtureReport();
    const context = buildExperimentDecisionContext(report, "growth-report-x.json", "hash123");
    const provider = new StubProvider("anthropic", {
      data: validProceedAnalysis(context),
      provider: "anthropic",
      model: "claude-test-model",
      requestId: "req_1",
      stopReason: "end_turn",
      inputTokens: 500,
      outputTokens: 300,
    });

    const decision = await runExperimentDecisionAgent({
      report,
      sourceReportFilename: "growth-report-x.json",
      sourceReportSha256: "hash123",
      language: "en",
      maxTokens: 4000,
      provider,
      generatedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(decision.provenance).toEqual({
      sourceGrowthReportFilename: "growth-report-x.json",
      sourceGrowthReportSha256: "hash123",
      sourceGrowthReportGeneratedAt: report.generatedAt,
      sourceGrowthReportProvider: report.generation.provider,
      sourceGrowthReportModel: report.generation.model,
      sourceGrowthReportIsMock: false,
      sourceDataQualityStatus: "partial",
    });
    expect(decision.decisionScope.availableTopics).toEqual(["Bookly", "Orderly"]);
    expect(decision.evidenceCatalog).toEqual(report.evidenceCatalog);
    expect(decision.decision.decisionSummary.decisionStatus).toBe("proceed");
    expect(decision.generation.isMock).toBe(false);
  });

  it("always requires human review and defaults approved to false", async () => {
    const report = fixtureReport();
    const context = buildExperimentDecisionContext(report, "f.json", "hash");
    const provider = new StubProvider("mock", {
      data: validDeferAnalysis(context),
      provider: "mock",
      model: "mock-v0",
      requestId: null,
      stopReason: "end_turn",
      inputTokens: null,
      outputTokens: null,
    });

    const decision = await runExperimentDecisionAgent({
      report,
      sourceReportFilename: "f.json",
      sourceReportSha256: "hash",
      language: "en",
      maxTokens: 4000,
      provider,
    });

    expect(decision.humanReview).toEqual({
      required: true,
      approved: false,
      approvedBy: null,
      approvedAt: null,
      note: "The Experiment Decision Agent does not execute changes automatically.",
    });
  });

  it("marks isMock true only for the mock provider", async () => {
    const report = fixtureReport();
    const context = buildExperimentDecisionContext(report, "f.json", "hash");
    const provider = new StubProvider("mock", {
      data: validDeferAnalysis(context),
      provider: "mock",
      model: "mock-v0",
      requestId: null,
      stopReason: "end_turn",
      inputTokens: null,
      outputTokens: null,
    });

    const decision = await runExperimentDecisionAgent({ report, sourceReportFilename: "f.json", sourceReportSha256: "hash", language: "en", maxTokens: 4000, provider });
    expect(decision.generation.isMock).toBe(true);
  });

  it("rejects (does not resolve to a decision) when the provider's response fails validation", async () => {
    const report = fixtureReport();
    const context = buildExperimentDecisionContext(report, "f.json", "hash");
    const bad = validProceedAnalysis(context);
    bad.rankedExperimentOptions[0].evidenceRefs = ["nonexistent.id"];

    const provider = new StubProvider("mock", {
      data: bad,
      provider: "mock",
      model: "mock-v0",
      requestId: null,
      stopReason: "end_turn",
      inputTokens: null,
      outputTokens: null,
    });

    await expect(
      runExperimentDecisionAgent({ report, sourceReportFilename: "f.json", sourceReportSha256: "hash", language: "en", maxTokens: 4000, provider })
    ).rejects.toThrow(ExperimentDecisionValidationError);
  });

  it("passes the decision context and rendered prompts to the provider", async () => {
    const report = fixtureReport();
    const context = buildExperimentDecisionContext(report, "f.json", "hash");
    const provider = new StubProvider("mock", {
      data: validDeferAnalysis(context),
      provider: "mock",
      model: "mock-v0",
      requestId: null,
      stopReason: "end_turn",
      inputTokens: null,
      outputTokens: null,
    });

    await runExperimentDecisionAgent({ report, sourceReportFilename: "f.json", sourceReportSha256: "hash", language: "en", maxTokens: 4000, provider });

    expect(provider.lastRequest?.context.evidenceCatalog.length).toBeGreaterThan(0);
    expect(provider.lastRequest?.systemPrompt).toContain("experiment decision analyst");
  });

  it("does not mutate the input Growth Report", async () => {
    const report = fixtureReport();
    const originalJson = JSON.stringify(report);
    const context = buildExperimentDecisionContext(report, "f.json", "hash");
    const provider = new StubProvider("mock", {
      data: validDeferAnalysis(context),
      provider: "mock",
      model: "mock-v0",
      requestId: null,
      stopReason: "end_turn",
      inputTokens: null,
      outputTokens: null,
    });

    await runExperimentDecisionAgent({ report, sourceReportFilename: "f.json", sourceReportSha256: "hash", language: "en", maxTokens: 4000, provider });

    expect(JSON.stringify(report)).toBe(originalJson);
  });
});

describe("schema-validity sanity check", () => {
  it("the fixture proceed/defer analyses used above are themselves schema-valid", () => {
    const context = buildExperimentDecisionContext(fixtureReport(), "f.json", "hash");
    expect(experimentDecisionAnalysisSchema.safeParse(validProceedAnalysis(context)).success).toBe(true);
    expect(experimentDecisionAnalysisSchema.safeParse(validDeferAnalysis(context)).success).toBe(true);
  });
});

describe("architecture: provider-neutral agent", () => {
  it("experiment-decision-agent.ts never imports the Anthropic SDK directly", () => {
    const source = readFileSync(new URL("../agents/experiment-decision-agent.ts", import.meta.url), "utf-8");
    expect(source).not.toContain("@anthropic-ai/sdk");
  });
});
