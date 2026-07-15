import { describe, expect, it } from "vitest";
import { renderGrowthReportMarkdown } from "../renderers/growth-report-markdown";
import type { EvidenceEntry, FinalGrowthReport, GrowthReportAnalysis } from "../types/growth-report";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

const EVIDENCE_CATALOG: EvidenceEntry[] = [
  { id: "traffic.sessions", label: "GA4 sessions", value: 100, source: "GA4", measurementBasis: "Sum of daily sessions." },
  { id: "behavior.page_views", label: "PostHog pageviews", value: 300, source: "PostHog", measurementBasis: "Sum of $pageview events." },
  { id: "data_quality.product_conversions", label: "Whacka product-conversion status", value: "not_connected", source: "Normalizer", measurementBasis: "Not connected yet." },
];

function fixtureAnalysis(overrides: Partial<GrowthReportAnalysis> = {}): GrowthReportAnalysis {
  return {
    executiveSummary: { headline: "Headline text", summary: "Summary text.", confidence: "medium" },
    findings: [
      {
        id: "finding_1",
        category: "traffic",
        title: "Traffic finding",
        observation: "Observation text.",
        interpretation: "Interpretation text.",
        evidenceRefs: ["traffic.sessions"],
        confidence: "high",
        caveats: ["Caveat text."],
      },
    ],
    funnelObservations: [],
    channelAndContentObservations: [],
    anomaliesOrNotableSignals: [],
    dataLimitations: [
      { title: "Product conversions unavailable", impact: "Cannot measure downstream funnel.", relatedEvidenceRefs: ["data_quality.product_conversions"] },
    ],
    decisionInputs: {
      signalsWorthReviewing: [],
      questionsForDecisionAgent: [{ question: "Question text?", reason: "Reason text.", evidenceRefs: ["traffic.sessions"] }],
    },
    ...overrides,
  };
}

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
      provider: "mock",
      model: "mock-v0",
      language: "en",
      isMock: true,
      requestId: null,
      stopReason: "end_turn",
      usage: { inputTokens: null, outputTokens: null },
    },
    metrics: {
      traffic: {
        overview: { sessions: 100, screenPageViews: 300, engagedSessions: 60, engagementRate: 0.6, activeUsers: null, activeUsersMeasurementNote: "note" },
        acquisition: [],
        landingPages: [],
        topSources: [],
        topLandingPages: [],
      },
      behavior: {
        eventTotals: { pageViews: 300, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, totalCtaClicks: 50 },
        uniqueUsers: null,
        uniqueUsersMeasurementNote: "note",
        byApp: [],
        byPageType: [],
        byUtmSource: [],
        byUtmMedium: [],
        byUtmCampaign: [],
        byUtmContent: [],
      },
      search: {
        status: "empty",
        totals: { clicks: 0, impressions: 0, ctr: null, averagePosition: null },
        daily: [],
        topQueries: [],
        topPages: [],
        queryPages: [],
      },
      productConversions: { signups: null, firstAppCreated: null, appPublished: null, status: "not_connected", note: "Not connected yet." },
    },
    evidenceCatalog: EVIDENCE_CATALOG,
    analysis: fixtureAnalysis(),
    dataQuality: {
      overallStatus: "partial",
      dateRangeMatch: true,
      missingSources: [],
      emptySources: ["search_console"],
      warnings: ["Search Console API connection succeeded, but all search-performance reports returned zero rows."],
      measurementNotes: ["GA4 activeUsers could not be safely summed."],
    },
    ...overrides,
  };
}

const REQUIRED_HEADINGS = [
  "# Growth Report",
  "## Reporting Period",
  "## Campaign",
  "## Executive Summary",
  "## Performance Snapshot",
  "## Key Findings",
  "## Funnel Observations",
  "## Channel and Content Observations",
  "## Anomalies or Notable Signals",
  "## Data Limitations",
  "## Signals for the Decision Agent",
  "## Questions for the Decision Agent",
  "## Evidence Index",
  "## Generation Metadata",
];

describe("renderGrowthReportMarkdown", () => {
  it("renders every required section heading", () => {
    const markdown = renderGrowthReportMarkdown(fixtureReport());
    for (const heading of REQUIRED_HEADINGS) {
      expect(markdown).toContain(heading);
    }
  });

  it("shows each finding's observation, interpretation, confidence, evidence, and caveats", () => {
    const markdown = renderGrowthReportMarkdown(fixtureReport());
    expect(markdown).toContain("Observation text.");
    expect(markdown).toContain("Interpretation text.");
    expect(markdown).toContain("**Confidence:** high");
    expect(markdown).toContain("Caveat text.");
    expect(markdown).toContain("traffic.sessions");
  });

  it("resolves evidence references to their label and value", () => {
    const markdown = renderGrowthReportMarkdown(fixtureReport());
    expect(markdown).toContain("`traffic.sessions` (GA4 sessions: 100)");
  });

  it("shows an unresolved marker for an evidence ID missing from the catalog, instead of crashing", () => {
    const report = fixtureReport({
      analysis: fixtureAnalysis({
        findings: [
          {
            id: "finding_1",
            category: "traffic",
            title: "T",
            observation: "O",
            interpretation: "I",
            evidenceRefs: ["traffic.sessions", "nonexistent.id"],
            confidence: "high",
            caveats: [],
          },
        ],
      }),
    });
    const markdown = renderGrowthReportMarkdown(report);
    expect(markdown).toContain("`nonexistent.id` (unresolved)");
  });

  it("renders null metrics as Unavailable, never as 0", () => {
    const markdown = renderGrowthReportMarkdown(fixtureReport());
    expect(markdown).toContain("- Active users: Unavailable");
    expect(markdown).toContain("- Signups: Unavailable");
    expect(markdown).toContain("- First app created: Unavailable");
    expect(markdown).toContain("- App published: Unavailable");
    expect(markdown).toContain("- CTR: Unavailable");
    expect(markdown).toContain("- Average position: Unavailable");
    expect(markdown).not.toMatch(/Active users: 0\b/);
  });

  it("shows the evidence index with resolved labels/values for every catalog entry", () => {
    const markdown = renderGrowthReportMarkdown(fixtureReport());
    expect(markdown).toContain("| `traffic.sessions` | GA4 sessions | 100 | GA4 | Sum of daily sessions. |");
    expect(markdown).toContain("| `data_quality.product_conversions` | Whacka product-conversion status | not_connected | Normalizer | Not connected yet. |");
  });

  it("shows data limitations prominently, including the deterministic data-quality summary", () => {
    const markdown = renderGrowthReportMarkdown(fixtureReport());
    expect(markdown).toContain("## Data Limitations");
    expect(markdown).toContain("Product conversions unavailable");
    expect(markdown).toContain("Cannot measure downstream funnel.");
    expect(markdown).toContain("### Deterministic Data-Quality Summary");
    expect(markdown).toContain("**Overall status:** partial");
    expect(markdown).toContain("Search Console API connection succeeded, but all search-performance reports returned zero rows.");
  });

  it("clearly marks a mock-generated report", () => {
    const markdown = renderGrowthReportMarkdown(fixtureReport());
    expect(markdown).toContain("MOCK — not a real analysis");
  });

  it("does not mark a non-mock (live) report as mock", () => {
    const report = fixtureReport({
      generation: { provider: "anthropic", model: "claude-x", language: "en", isMock: false, requestId: "req_123", stopReason: "end_turn", usage: { inputTokens: 500, outputTokens: 300 } },
    });
    const markdown = renderGrowthReportMarkdown(report);
    expect(markdown).not.toContain("MOCK — not a real analysis");
    expect(markdown).toContain("**Input tokens:** 500");
    expect(markdown).toContain("**Output tokens:** 300");
    expect(markdown).toContain("**Request ID:** req_123");
  });

  it("shows placeholders for empty optional sections instead of omitting them", () => {
    const markdown = renderGrowthReportMarkdown(fixtureReport());
    expect(markdown).toContain("## Funnel Observations");
    expect(markdown).toContain("_None reported._");
  });
});
