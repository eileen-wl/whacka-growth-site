import { describe, expect, it } from "vitest";
import { MockExperimentDecisionProvider } from "../llm/mock-experiment-decision-provider";
import { experimentDecisionAnalysisSchema } from "../types/experiment-decision";
import type { ExperimentDecisionAnalysis, ExperimentDecisionContext, ExperimentDecisionLLMRequest } from "../types/experiment-decision";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureContext(overrides: Partial<ExperimentDecisionContext> = {}): ExperimentDecisionContext {
  return {
    period: PERIOD,
    campaign: CAMPAIGN,
    sourceReportFilename: "growth-report-2026-07-08_to_2026-07-14.json",
    sourceReportSha256: "abc123",
    sourceReportGeneratedAt: "2026-07-15T00:00:00.000Z",
    sourceReportProvider: "anthropic",
    sourceReportModel: "claude-test-model",
    sourceReportIsMock: false,
    metrics: {
      traffic: { overview: { sessions: 100, screenPageViews: 300, engagedSessions: 60, engagementRate: 0.6, activeUsers: null, activeUsersMeasurementNote: "x" }, acquisition: [], landingPages: [], topSources: [], topLandingPages: [] },
      behavior: { eventTotals: { pageViews: 300, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, totalCtaClicks: 50 }, uniqueUsers: null, uniqueUsersMeasurementNote: "x", byApp: [], byPageType: [], byUtmSource: [], byUtmMedium: [], byUtmCampaign: [], byUtmContent: [] },
      search: { status: "ok", totals: { clicks: 20, impressions: 500, ctr: 0.04, averagePosition: 8.5 }, daily: [], topQueries: [], topPages: [], queryPages: [] },
      productConversions: { signups: null, firstAppCreated: null, appPublished: null, status: "not_connected", note: "x" },
    },
    evidenceCatalog: [
      { id: "behavior.event_based_cta_rate", label: "Event-based CTA rate", value: 0.1667, source: "PostHog", measurementBasis: "x" },
      { id: "behavior.total_cta_clicks", label: "PostHog total CTA clicks", value: 50, source: "PostHog", measurementBasis: "x" },
      { id: "traffic.sessions", label: "GA4 sessions", value: 100, source: "GA4", measurementBasis: "x" },
    ],
    findingCatalog: [{ id: "finding.finding_1", title: "T", observation: "O", interpretation: "I", evidenceRefs: ["traffic.sessions"], confidence: "medium" }],
    limitationCatalog: [{ id: "data_limit.product_conversions_not_connected", title: "T", impact: "I", relatedEvidenceRefs: [] }],
    decisionScope: { availableTopics: ["Bookly", "Orderly"], availableCtaTypes: ["view_demo", "build"], availableChannels: ["google / organic"] },
    dataQualityStatus: "partial",
    dataQualityWarnings: ["Some warning."],
    measurementNotes: ["Some note."],
    ...overrides,
  };
}

function requestWithContext(context: ExperimentDecisionContext): ExperimentDecisionLLMRequest {
  return {
    purpose: "purpose",
    language: "en",
    context,
    reportingRules: [],
    responseSchemaDescription: "desc",
    maxTokens: 4000,
    systemPrompt: "system",
    userPrompt: "user",
  };
}

function collectAllRefs(analysis: ExperimentDecisionAnalysis): { evidenceRefs: string[]; findingRefs: string[]; limitationRefs: string[] } {
  const evidenceRefs: string[] = [];
  const findingRefs: string[] = [];
  const limitationRefs: string[] = [];

  for (const option of analysis.rankedExperimentOptions) {
    evidenceRefs.push(...option.evidenceRefs, option.measurementPlan.primaryMetricRef, ...option.measurementPlan.guardrailMetricRefs);
    findingRefs.push(...option.findingRefs);
    limitationRefs.push(...option.limitationRefs);
  }
  if (analysis.recommendedExperiment) {
    const r = analysis.recommendedExperiment;
    evidenceRefs.push(...r.evidenceRefs, r.measurementPlan.primaryMetricRef, ...r.measurementPlan.secondaryMetricRefs, ...r.measurementPlan.guardrailMetricRefs);
    findingRefs.push(...r.findingRefs);
  }
  if (analysis.deferDecision) {
    for (const observation of analysis.deferDecision.requiredNextObservations) {
      evidenceRefs.push(...observation.relatedEvidenceOrLimitationRefs);
    }
  }
  for (const option of analysis.rejectedOrDeferredOptions) {
    evidenceRefs.push(...option.evidenceRefs);
    limitationRefs.push(...option.limitationRefs);
  }

  return { evidenceRefs, findingRefs, limitationRefs };
}

describe("MockExperimentDecisionProvider", () => {
  it("requires no API key to construct", () => {
    expect(() => new MockExperimentDecisionProvider()).not.toThrow();
  });

  it("is named 'mock'", () => {
    expect(new MockExperimentDecisionProvider().name).toBe("mock");
  });

  it("performs no network call (fetch is never invoked)", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      called = true;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      await new MockExperimentDecisionProvider().generateStructuredDecision(requestWithContext(fixtureContext()));
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a schema-valid ExperimentDecisionAnalysis for a non-mock source with sufficient scope", async () => {
    const result = await new MockExperimentDecisionProvider().generateStructuredDecision(requestWithContext(fixtureContext()));
    expect(experimentDecisionAnalysisSchema.safeParse(result.data).success).toBe(true);
  });

  it("proceeds with a bounded recommendation when the source report is not mock and scope is sufficient", async () => {
    const result = await new MockExperimentDecisionProvider().generateStructuredDecision(requestWithContext(fixtureContext()));
    expect(result.data.decisionSummary.decisionStatus).toBe("proceed");
    expect(result.data.recommendedExperiment).not.toBeNull();
  });

  it("always defers when the source Growth Report is mock-generated", async () => {
    const context = fixtureContext({ sourceReportIsMock: true });
    const result = await new MockExperimentDecisionProvider().generateStructuredDecision(requestWithContext(context));
    expect(result.data.decisionSummary.decisionStatus).toBe("defer");
    expect(result.data.recommendedExperiment).toBeNull();
    expect(result.data.rankedExperimentOptions).toHaveLength(0);
    expect(experimentDecisionAnalysisSchema.safeParse(result.data).success).toBe(true);
  });

  it("defers when no topics are available in the decision scope", async () => {
    const context = fixtureContext({ decisionScope: { availableTopics: [], availableCtaTypes: ["view_demo"], availableChannels: [] } });
    const result = await new MockExperimentDecisionProvider().generateStructuredDecision(requestWithContext(context));
    expect(result.data.decisionSummary.decisionStatus).toBe("defer");
  });

  it("defers when no CTA types are available in the decision scope", async () => {
    const context = fixtureContext({ decisionScope: { availableTopics: ["Bookly"], availableCtaTypes: [], availableChannels: [] } });
    const result = await new MockExperimentDecisionProvider().generateStructuredDecision(requestWithContext(context));
    expect(result.data.decisionSummary.decisionStatus).toBe("defer");
  });

  it("adapts to empty available channels without crashing, using a null channel target", async () => {
    const context = fixtureContext({ decisionScope: { availableTopics: ["Bookly"], availableCtaTypes: ["view_demo"], availableChannels: [] } });
    const result = await new MockExperimentDecisionProvider().generateStructuredDecision(requestWithContext(context));
    expect(experimentDecisionAnalysisSchema.safeParse(result.data).success).toBe(true);
    if (result.data.decisionSummary.decisionStatus === "proceed") {
      for (const option of result.data.rankedExperimentOptions) {
        expect(option.target.channel).toBeNull();
      }
    }
  });

  it("only cites evidence IDs present in the supplied catalog", async () => {
    const context = fixtureContext();
    const result = await new MockExperimentDecisionProvider().generateStructuredDecision(requestWithContext(context));
    const catalogIds = new Set(context.evidenceCatalog.map((entry) => entry.id));
    const refs = collectAllRefs(result.data);
    expect(refs.evidenceRefs.length).toBeGreaterThan(0);
    for (const id of refs.evidenceRefs) {
      expect(catalogIds.has(id)).toBe(true);
    }
  });

  it("only cites finding IDs present in the supplied finding catalog", async () => {
    const context = fixtureContext();
    const result = await new MockExperimentDecisionProvider().generateStructuredDecision(requestWithContext(context));
    const findingIds = new Set(context.findingCatalog.map((entry) => entry.id));
    const refs = collectAllRefs(result.data);
    for (const id of refs.findingRefs) {
      expect(findingIds.has(id)).toBe(true);
    }
  });

  it("only cites limitation IDs present in the supplied limitation catalog", async () => {
    const context = fixtureContext();
    const result = await new MockExperimentDecisionProvider().generateStructuredDecision(requestWithContext(context));
    const limitationIds = new Set(context.limitationCatalog.map((entry) => entry.id));
    const refs = collectAllRefs(result.data);
    for (const id of refs.limitationRefs) {
      expect(limitationIds.has(id)).toBe(true);
    }
  });

  it("only targets topics/CTAs present in the supplied decision scope", async () => {
    const context = fixtureContext();
    const result = await new MockExperimentDecisionProvider().generateStructuredDecision(requestWithContext(context));
    const topics = new Set(context.decisionScope.availableTopics);
    const ctaTypes = new Set(context.decisionScope.availableCtaTypes);
    for (const option of result.data.rankedExperimentOptions) {
      if (option.target.topicOrApp !== null) expect(topics.has(option.target.topicOrApp)).toBe(true);
      if (option.target.ctaType !== null) expect(ctaTypes.has(option.target.ctaType)).toBe(true);
    }
  });

  it("reflects unavailable product conversions in the deferred/limitation context (never treats null as zero)", async () => {
    const context = fixtureContext({ sourceReportIsMock: true });
    const result = await new MockExperimentDecisionProvider().generateStructuredDecision(requestWithContext(context));
    expect(context.metrics.productConversions.signups).toBeNull();
    // The mock provider's output never references productConversions numerically — only via limitation catalog IDs.
    const refs = collectAllRefs(result.data);
    expect(refs.evidenceRefs).not.toContain("product_conversions.signups");
  });

  it("preserves mock metadata: no requestId/token usage, stopReason end_turn", async () => {
    const result = await new MockExperimentDecisionProvider().generateStructuredDecision(requestWithContext(fixtureContext()));
    expect(result.provider).toBe("mock");
    expect(result.model).toBe("mock-v0");
    expect(result.requestId).toBeNull();
    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
    expect(result.stopReason).toBe("end_turn");
  });
});
