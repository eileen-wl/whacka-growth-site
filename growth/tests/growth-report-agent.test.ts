import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GrowthReportValidationError, buildEvidenceCatalog, runGrowthReportAgent, validateAnalysis } from "../agents/growth-report-agent";
import type { LLMProvider } from "../llm/provider";
import type { GrowthSummary } from "../types/growth-summary";
import type { EvidenceEntry, GrowthReportAnalysis, GrowthReportLLMRequest, LLMStructuredResult } from "../types/growth-report";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureSummary(overrides: Partial<GrowthSummary> = {}): GrowthSummary {
  return {
    schemaVersion: "1.0.0",
    source: "normalized_growth_summary",
    generatedAt: "2026-07-15T00:00:00.000Z",
    period: PERIOD,
    campaign: CAMPAIGN,
    inputs: {
      posthog: { status: "ok", filename: "posthog-2026-07-08_to_2026-07-14.json", collectedAt: "2026-07-14T23:00:00.000Z", rowCount: 10 },
      ga4: {
        status: "ok",
        filename: "ga4-2026-07-08_to_2026-07-14.json",
        collectedAt: "2026-07-14T23:05:00.000Z",
        reportRowCounts: { trafficOverview: 7, trafficAcquisition: 5, landingPages: 4 },
      },
      searchConsole: {
        status: "ok",
        filename: "gsc-2026-07-08_to_2026-07-14.json",
        collectedAt: "2026-07-14T23:10:00.000Z",
        reportRowCounts: { dailyOverview: 7, queries: 10, queryPages: 10, pages: 5 },
      },
    },
    traffic: {
      overview: { sessions: 100, screenPageViews: 300, engagedSessions: 60, engagementRate: 0.6, activeUsers: null, activeUsersMeasurementNote: "note" },
      acquisition: [],
      landingPages: [],
      topSources: [{ source: "google", medium: "organic", campaign: "(not set)", sessions: 40, engagedSessions: 20, engagementRate: 0.5 }],
      topLandingPages: [{ landingPage: "/", sessions: 100, screenPageViews: 300, engagedSessions: 60, engagementRate: 0.6 }],
    },
    behavior: {
      eventTotals: { pageViews: 300, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, totalCtaClicks: 50 },
      uniqueUsers: null,
      uniqueUsersMeasurementNote: "note",
      byApp: [{ appSlug: "bookly", appName: "Bookly", pageViews: 0, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, totalCtaClicks: 50, eventBasedCtaRate: null }],
      byPageType: [{ key: "app_detail", pageViews: 0, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, totalCtaClicks: 50 }],
      byUtmSource: [{ key: "growth_site", pageViews: 0, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, totalCtaClicks: 50 }],
      byUtmMedium: [],
      byUtmCampaign: [],
      byUtmContent: [],
    },
    search: {
      status: "ok",
      totals: { clicks: 20, impressions: 500, ctr: 0.04, averagePosition: 8.5 },
      daily: [],
      topQueries: [{ query: "widget install", clicks: 10, impressions: 200, ctr: 0.05, position: 5 }],
      topPages: [{ page: "/", clicks: 20, impressions: 500, ctr: 0.04, position: 8.5 }],
      queryPages: [],
    },
    funnel: {
      growthSite: { pageViews: 300, totalCtaClicks: 50, eventBasedCtaRate: 50 / 300, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, measurementBasis: "PostHog event counts" },
    },
    productConversions: { signups: null, firstAppCreated: null, appPublished: null, status: "not_connected", note: "Whacka product-side attribution has not been connected yet." },
    dataQuality: {
      overallStatus: "partial",
      dateRangeMatch: true,
      missingSources: [],
      emptySources: [],
      warnings: [
        "GA4 daily activeUsers were not summed into a period-level unique-user metric.",
        "PostHog grouped unique-user counts were not summed because users may occur in multiple groups.",
        "Whacka product-side signup and activation attribution is not connected.",
      ],
      measurementNotes: ["note1", "note2"],
    },
    ...overrides,
  };
}

function emptySearchSummary(): GrowthSummary {
  return fixtureSummary({
    search: {
      status: "empty",
      totals: { clicks: 0, impressions: 0, ctr: null, averagePosition: null },
      daily: [],
      topQueries: [],
      topPages: [],
      queryPages: [],
    },
  });
}

describe("buildEvidenceCatalog", () => {
  it("is deterministic — the same summary always produces the same IDs", () => {
    const summary = fixtureSummary();
    const first = buildEvidenceCatalog(summary).map((e) => e.id);
    const second = buildEvidenceCatalog(summary).map((e) => e.id);
    expect(first).toEqual(second);
  });

  it("includes core traffic metrics", () => {
    const catalog = buildEvidenceCatalog(fixtureSummary());
    const byId = new Map(catalog.map((e) => [e.id, e]));
    expect(byId.get("traffic.sessions")?.value).toBe(100);
    expect(byId.get("traffic.screen_page_views")?.value).toBe(300);
    expect(byId.get("traffic.engaged_sessions")?.value).toBe(60);
    expect(byId.get("traffic.engagement_rate")?.value).toBe(0.6);
    expect(byId.get("traffic.top_source.1")?.value).toBe(40);
    expect(byId.get("traffic.top_landing_page.1")?.value).toBe(100);
  });

  it("includes core behavior metrics", () => {
    const catalog = buildEvidenceCatalog(fixtureSummary());
    const byId = new Map(catalog.map((e) => [e.id, e]));
    expect(byId.get("behavior.page_views")?.value).toBe(300);
    expect(byId.get("behavior.total_cta_clicks")?.value).toBe(50);
    expect(byId.get("behavior.by_app.bookly")).toBeDefined();
    expect(byId.get("behavior.by_utm_source.growth_site")).toBeDefined();
  });

  it("omits traffic.active_users entirely when GA4 gave no reliable period total (never fabricates 0)", () => {
    const catalog = buildEvidenceCatalog(fixtureSummary());
    expect(catalog.find((e) => e.id === "traffic.active_users")).toBeUndefined();
  });

  it("preserves a null metric value as null rather than coercing it to 0", () => {
    const catalog = buildEvidenceCatalog(emptySearchSummary());
    const byId = new Map(catalog.map((e) => [e.id, e]));
    expect(byId.get("search.ctr")?.value).toBeNull();
    expect(byId.get("search.average_position")?.value).toBeNull();
  });

  it("represents empty Search Console data correctly: status 'empty', zero totals, no top query/page entries", () => {
    const catalog = buildEvidenceCatalog(emptySearchSummary());
    const byId = new Map(catalog.map((e) => [e.id, e]));
    expect(byId.get("search.status")?.value).toBe("empty");
    expect(byId.get("search.clicks")?.value).toBe(0);
    expect(byId.get("search.impressions")?.value).toBe(0);
    expect(catalog.find((e) => e.id.startsWith("search.top_query."))).toBeUndefined();
    expect(catalog.find((e) => e.id.startsWith("search.top_page."))).toBeUndefined();
  });

  it("keeps product conversions unavailable (null), never substituting zero", () => {
    const catalog = buildEvidenceCatalog(fixtureSummary());
    const byId = new Map(catalog.map((e) => [e.id, e]));
    expect(byId.get("product_conversions.signups")?.value).toBeNull();
    expect(byId.get("product_conversions.first_app_created")?.value).toBeNull();
    expect(byId.get("product_conversions.app_published")?.value).toBeNull();
    expect(byId.get("data_quality.product_conversions")?.value).toBe("not_connected");
  });

  it("has no duplicate evidence IDs", () => {
    const catalog = buildEvidenceCatalog(fixtureSummary());
    const ids = catalog.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("de-duplicates IDs even if two dimension values would slugify to the same base ID", () => {
    const summary = fixtureSummary({
      behavior: {
        ...fixtureSummary().behavior,
        byUtmSource: [
          { key: "growth-site", pageViews: 0, viewDemoClicks: 1, remixClicks: 0, buildClicks: 0, copyPromptClicks: 0, totalCtaClicks: 1 },
          { key: "growth_site", pageViews: 0, viewDemoClicks: 2, remixClicks: 0, buildClicks: 0, copyPromptClicks: 0, totalCtaClicks: 2 },
        ],
      },
    });
    const catalog = buildEvidenceCatalog(summary);
    const ids = catalog.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

function validAnalysis(evidenceCatalog: EvidenceEntry[]): GrowthReportAnalysis {
  const firstId = evidenceCatalog[0]?.id ?? "traffic.sessions";
  return {
    executiveSummary: { headline: "Headline", summary: "Summary text.", confidence: "medium" },
    findings: [
      {
        id: "finding_1",
        category: "traffic",
        title: "Title",
        observation: "Observation.",
        interpretation: "Interpretation.",
        evidenceRefs: [firstId],
        confidence: "high",
        caveats: [],
      },
    ],
    funnelObservations: [],
    channelAndContentObservations: [],
    anomaliesOrNotableSignals: [],
    dataLimitations: [{ title: "Limitation", impact: "Impact.", relatedEvidenceRefs: [firstId] }],
    decisionInputs: {
      signalsWorthReviewing: [],
      questionsForDecisionAgent: [{ question: "Question?", reason: "Reason.", evidenceRefs: [firstId] }],
    },
  };
}

describe("validateAnalysis", () => {
  const catalog = buildEvidenceCatalog(fixtureSummary());

  it("accepts a valid structured analysis and returns the parsed data", () => {
    const analysis = validateAnalysis(validAnalysis(catalog), catalog, "partial");
    expect(analysis.findings).toHaveLength(1);
  });

  it("rejects an analysis citing an unknown evidence ID", () => {
    const bad = validAnalysis(catalog);
    bad.findings[0].evidenceRefs = ["nonexistent.evidence.id"];
    expect(() => validateAnalysis(bad, catalog, "partial")).toThrow(GrowthReportValidationError);
  });

  it("rejects an analysis with an empty required evidenceRefs array", () => {
    const bad = validAnalysis(catalog);
    bad.findings[0].evidenceRefs = [];
    expect(() => validateAnalysis(bad, catalog, "partial")).toThrow(GrowthReportValidationError);
  });

  it("rejects an invalid confidence enum value", () => {
    const bad = validAnalysis(catalog) as unknown as Record<string, unknown>;
    (bad.executiveSummary as Record<string, unknown>).confidence = "extreme";
    expect(() => validateAnalysis(bad, catalog, "partial")).toThrow(GrowthReportValidationError);
  });

  it("rejects unknown top-level schema keys", () => {
    const bad = validAnalysis(catalog) as unknown as Record<string, unknown>;
    bad.unexpectedKey = "surprise";
    expect(() => validateAnalysis(bad, catalog, "partial")).toThrow(GrowthReportValidationError);
  });

  it("rejects unknown nested schema keys", () => {
    const bad = validAnalysis(catalog) as unknown as { findings: Record<string, unknown>[] };
    bad.findings[0].unexpectedKey = "surprise";
    expect(() => validateAnalysis(bad, catalog, "partial")).toThrow(GrowthReportValidationError);
  });

  it("requires at least one dataLimitations entry when data quality is not complete", () => {
    const bad = validAnalysis(catalog);
    bad.dataLimitations = [];
    expect(() => validateAnalysis(bad, catalog, "partial")).toThrow(GrowthReportValidationError);
  });

  it("does not require dataLimitations when data quality is complete", () => {
    const analysis = validAnalysis(catalog);
    analysis.dataLimitations = [];
    expect(() => validateAnalysis(analysis, catalog, "complete")).not.toThrow();
  });
});

class StubProvider implements LLMProvider {
  readonly name: string;
  private readonly result: LLMStructuredResult<unknown>;
  public lastRequest: GrowthReportLLMRequest | undefined;

  constructor(name: string, result: LLMStructuredResult<unknown>) {
    this.name = name;
    this.result = result;
  }

  async generateStructuredReport(request: GrowthReportLLMRequest): Promise<LLMStructuredResult<GrowthReportAnalysis>> {
    this.lastRequest = request;
    return this.result as LLMStructuredResult<GrowthReportAnalysis>;
  }
}

describe("runGrowthReportAgent", () => {
  it("preserves the normalized metrics exactly in the final report", async () => {
    const summary = fixtureSummary();
    const catalog = buildEvidenceCatalog(summary);
    const provider = new StubProvider("mock", {
      data: validAnalysis(catalog),
      provider: "mock",
      model: "mock-v0",
      requestId: null,
      stopReason: "end_turn",
      inputTokens: null,
      outputTokens: null,
    });

    const report = await runGrowthReportAgent({
      summary,
      sourceSummaryFilename: "growth-summary-2026-07-08_to_2026-07-14.json",
      sourceSummarySha256: "deadbeef",
      language: "en",
      maxTokens: 4000,
      provider,
      generatedAt: "2026-07-15T12:00:00.000Z",
    });

    expect(report.metrics.traffic).toEqual(summary.traffic);
    expect(report.metrics.behavior).toEqual(summary.behavior);
    expect(report.metrics.search).toEqual(summary.search);
    expect(report.metrics.productConversions).toEqual(summary.productConversions);
    expect(report.metrics.productConversions.signups).toBeNull();
  });

  it("attaches provider metadata and provenance", async () => {
    const summary = fixtureSummary();
    const catalog = buildEvidenceCatalog(summary);
    const provider = new StubProvider("anthropic", {
      data: validAnalysis(catalog),
      provider: "anthropic",
      model: "claude-test-model",
      requestId: "req_abc123",
      stopReason: "end_turn",
      inputTokens: 1200,
      outputTokens: 400,
    });

    const report = await runGrowthReportAgent({
      summary,
      sourceSummaryFilename: "growth-summary-2026-07-08_to_2026-07-14.json",
      sourceSummarySha256: "cafebabe",
      language: "en",
      maxTokens: 4000,
      provider,
      generatedAt: "2026-07-15T12:00:00.000Z",
    });

    expect(report.generation).toEqual({
      provider: "anthropic",
      model: "claude-test-model",
      language: "en",
      isMock: false,
      requestId: "req_abc123",
      stopReason: "end_turn",
      usage: { inputTokens: 1200, outputTokens: 400 },
    });
    expect(report.provenance).toEqual({
      sourceSummaryFilename: "growth-summary-2026-07-08_to_2026-07-14.json",
      sourceSummarySha256: "cafebabe",
      sourceSummaryGeneratedAt: summary.generatedAt,
      dataQualityStatus: "partial",
    });
  });

  it("marks isMock true only for the mock provider", async () => {
    const summary = fixtureSummary();
    const catalog = buildEvidenceCatalog(summary);
    const provider = new StubProvider("mock", {
      data: validAnalysis(catalog),
      provider: "mock",
      model: "mock-v0",
      requestId: null,
      stopReason: "end_turn",
      inputTokens: null,
      outputTokens: null,
    });

    const report = await runGrowthReportAgent({
      summary,
      sourceSummaryFilename: "f.json",
      sourceSummarySha256: "hash",
      language: "en",
      maxTokens: 4000,
      provider,
    });

    expect(report.generation.isMock).toBe(true);
  });

  it("rejects (does not resolve to a report) when the provider's response fails validation", async () => {
    const summary = fixtureSummary();
    const catalog = buildEvidenceCatalog(summary);
    const badAnalysis = validAnalysis(catalog);
    badAnalysis.findings[0].evidenceRefs = ["nonexistent.id"];

    const provider = new StubProvider("mock", {
      data: badAnalysis,
      provider: "mock",
      model: "mock-v0",
      requestId: null,
      stopReason: "end_turn",
      inputTokens: null,
      outputTokens: null,
    });

    await expect(
      runGrowthReportAgent({
        summary,
        sourceSummaryFilename: "f.json",
        sourceSummarySha256: "hash",
        language: "en",
        maxTokens: 4000,
        provider,
      })
    ).rejects.toThrow(GrowthReportValidationError);
  });

  it("passes the evidence catalog and rendered prompts to the provider", async () => {
    const summary = fixtureSummary();
    const catalog = buildEvidenceCatalog(summary);
    const provider = new StubProvider("mock", {
      data: validAnalysis(catalog),
      provider: "mock",
      model: "mock-v0",
      requestId: null,
      stopReason: "end_turn",
      inputTokens: null,
      outputTokens: null,
    });

    await runGrowthReportAgent({
      summary,
      sourceSummaryFilename: "f.json",
      sourceSummarySha256: "hash",
      language: "en",
      maxTokens: 4000,
      provider,
    });

    expect(provider.lastRequest?.evidenceCatalog.length).toBeGreaterThan(0);
    expect(provider.lastRequest?.systemPrompt).toContain("evidence-grounded growth reporting analyst");
    expect(provider.lastRequest?.period).toEqual(summary.period);
  });
});

describe("architecture: provider-neutral agent", () => {
  it("growth-report-agent.ts never imports the Anthropic SDK directly", () => {
    const source = readFileSync(new URL("../agents/growth-report-agent.ts", import.meta.url), "utf-8");
    expect(source).not.toContain("@anthropic-ai/sdk");
  });
});
