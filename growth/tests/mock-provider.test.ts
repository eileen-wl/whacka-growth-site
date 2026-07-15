import { describe, expect, it } from "vitest";
import { MockGrowthReportProvider } from "../llm/mock-provider";
import { growthReportAnalysisSchema } from "../types/growth-report";
import type { EvidenceEntry, GrowthReportLLMRequest } from "../types/growth-report";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

const FULL_EVIDENCE_CATALOG: EvidenceEntry[] = [
  { id: "traffic.sessions", label: "GA4 sessions", value: 100, source: "GA4", measurementBasis: "x" },
  { id: "traffic.screen_page_views", label: "GA4 screen/page views", value: 300, source: "GA4", measurementBasis: "x" },
  { id: "traffic.engaged_sessions", label: "GA4 engaged sessions", value: 60, source: "GA4", measurementBasis: "x" },
  { id: "traffic.top_source.1", label: "Top source #1", value: 40, source: "GA4", measurementBasis: "x" },
  { id: "traffic.top_landing_page.1", label: "Top landing page #1", value: 30, source: "GA4", measurementBasis: "x" },
  { id: "behavior.page_views", label: "PostHog pageviews", value: 300, source: "PostHog", measurementBasis: "x" },
  { id: "behavior.total_cta_clicks", label: "PostHog total CTA clicks", value: 50, source: "PostHog", measurementBasis: "x" },
  { id: "behavior.event_based_cta_rate", label: "Event-based CTA rate", value: 0.16, source: "PostHog", measurementBasis: "x" },
  { id: "search.status", label: "Search Console data status", value: "ok", source: "Search Console", measurementBasis: "x" },
  { id: "search.clicks", label: "Search Console clicks", value: 20, source: "Search Console", measurementBasis: "x" },
  { id: "search.impressions", label: "Search Console impressions", value: 500, source: "Search Console", measurementBasis: "x" },
  { id: "data_quality.overall_status", label: "Overall data-quality status", value: "partial", source: "Normalizer", measurementBasis: "x" },
  { id: "data_quality.product_conversions", label: "Whacka product-conversion status", value: "not_connected", source: "Normalizer", measurementBasis: "x" },
];

function requestWithCatalog(evidenceCatalog: EvidenceEntry[]): GrowthReportLLMRequest {
  return {
    purpose: "test purpose",
    period: PERIOD,
    campaign: CAMPAIGN,
    language: "en",
    evidenceCatalog,
    dataQualityWarnings: [],
    measurementNotes: [],
    reportingRules: [],
    responseSchemaDescription: "desc",
    maxTokens: 4000,
    systemPrompt: "system",
    userPrompt: "user",
  };
}

function collectAllEvidenceRefs(analysis: import("../types/growth-report").GrowthReportAnalysis): string[] {
  const refs: string[] = [];
  for (const f of analysis.findings) refs.push(...f.evidenceRefs);
  for (const f of analysis.funnelObservations) refs.push(...f.evidenceRefs);
  for (const c of analysis.channelAndContentObservations) refs.push(...c.evidenceRefs);
  for (const a of analysis.anomaliesOrNotableSignals) refs.push(...a.evidenceRefs);
  for (const d of analysis.dataLimitations) refs.push(...d.relatedEvidenceRefs);
  for (const s of analysis.decisionInputs.signalsWorthReviewing) refs.push(...s.evidenceRefs);
  for (const q of analysis.decisionInputs.questionsForDecisionAgent) refs.push(...q.evidenceRefs);
  return refs;
}

describe("MockGrowthReportProvider", () => {
  it("requires no API key to construct", () => {
    expect(() => new MockGrowthReportProvider()).not.toThrow();
  });

  it("is named 'mock'", () => {
    expect(new MockGrowthReportProvider().name).toBe("mock");
  });

  it("performs no network call (fetch is never invoked)", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      called = true;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      await new MockGrowthReportProvider().generateStructuredReport(requestWithCatalog(FULL_EVIDENCE_CATALOG));
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a schema-valid GrowthReportAnalysis", async () => {
    const result = await new MockGrowthReportProvider().generateStructuredReport(requestWithCatalog(FULL_EVIDENCE_CATALOG));
    const parsed = growthReportAnalysisSchema.safeParse(result.data);
    expect(parsed.success).toBe(true);
  });

  it("cites only evidence IDs present in the supplied catalog", async () => {
    const result = await new MockGrowthReportProvider().generateStructuredReport(requestWithCatalog(FULL_EVIDENCE_CATALOG));
    const catalogIds = new Set(FULL_EVIDENCE_CATALOG.map((e) => e.id));
    const refs = collectAllEvidenceRefs(result.data);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(catalogIds.has(ref)).toBe(true);
    }
  });

  it("always includes at least one dataLimitations entry, satisfying the partial-data-quality rule", async () => {
    const result = await new MockGrowthReportProvider().generateStructuredReport(requestWithCatalog(FULL_EVIDENCE_CATALOG));
    expect(result.data.dataLimitations.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves mock metadata: no requestId/token usage, stopReason end_turn", async () => {
    const result = await new MockGrowthReportProvider().generateStructuredReport(requestWithCatalog(FULL_EVIDENCE_CATALOG));
    expect(result.provider).toBe("mock");
    expect(result.model).toBe("mock-v0");
    expect(result.requestId).toBeNull();
    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
    expect(result.stopReason).toBe("end_turn");
  });

  it("adapts to a minimal evidence catalog missing optional entries (empty Search Console / no top sources) without crashing or citing missing IDs", async () => {
    const minimalCatalog: EvidenceEntry[] = [
      { id: "traffic.sessions", label: "GA4 sessions", value: 0, source: "GA4", measurementBasis: "x" },
      { id: "traffic.screen_page_views", label: "GA4 screen/page views", value: 0, source: "GA4", measurementBasis: "x" },
      { id: "behavior.page_views", label: "PostHog pageviews", value: 0, source: "PostHog", measurementBasis: "x" },
      { id: "behavior.total_cta_clicks", label: "PostHog total CTA clicks", value: 0, source: "PostHog", measurementBasis: "x" },
      { id: "search.status", label: "Search Console data status", value: "empty", source: "Search Console", measurementBasis: "x" },
      { id: "search.clicks", label: "Search Console clicks", value: 0, source: "Search Console", measurementBasis: "x" },
      { id: "data_quality.overall_status", label: "Overall data-quality status", value: "partial", source: "Normalizer", measurementBasis: "x" },
      { id: "data_quality.product_conversions", label: "Whacka product-conversion status", value: "not_connected", source: "Normalizer", measurementBasis: "x" },
    ];

    const result = await new MockGrowthReportProvider().generateStructuredReport(requestWithCatalog(minimalCatalog));

    const parsed = growthReportAnalysisSchema.safeParse(result.data);
    expect(parsed.success).toBe(true);

    const catalogIds = new Set(minimalCatalog.map((e) => e.id));
    for (const ref of collectAllEvidenceRefs(result.data)) {
      expect(catalogIds.has(ref)).toBe(true);
    }
    // No channel/content observation should be produced when there's no top-source/top-landing-page evidence.
    expect(result.data.channelAndContentObservations).toHaveLength(0);
  });

  it("reflects an empty Search Console status in its search finding's observation text", async () => {
    const catalog = FULL_EVIDENCE_CATALOG.map((entry) => (entry.id === "search.status" ? { ...entry, value: "empty" as const } : entry));
    const result = await new MockGrowthReportProvider().generateStructuredReport(requestWithCatalog(catalog));
    const searchFinding = result.data.findings.find((f) => f.category === "search");
    expect(searchFinding?.observation.toLowerCase()).toContain("zero rows");
  });

  it("reflects unavailable product-conversion data in a data limitation", async () => {
    const result = await new MockGrowthReportProvider().generateStructuredReport(requestWithCatalog(FULL_EVIDENCE_CATALOG));
    const limitation = result.data.dataLimitations.find((d) => d.title.toLowerCase().includes("whacka"));
    expect(limitation).toBeDefined();
    expect(limitation?.relatedEvidenceRefs).toContain("data_quality.product_conversions");
  });
});
