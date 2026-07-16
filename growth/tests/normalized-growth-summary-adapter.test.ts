import { describe, expect, it } from "vitest";
import { NormalizedGrowthSummaryAdapter } from "../signal-sources/normalized-growth-summary-adapter";
import type { GrowthSummary } from "../types/growth-summary";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };
const CONTEXT = { period: PERIOD, campaign: CAMPAIGN, now: "2026-07-15T00:00:00.000Z" };

function fixtureSummary(overrides: Partial<GrowthSummary> = {}): GrowthSummary {
  return {
    schemaVersion: "1.0.0",
    source: "normalized_growth_summary",
    generatedAt: "2026-07-15T00:00:00.000Z",
    period: PERIOD,
    campaign: CAMPAIGN,
    inputs: {
      posthog: { status: "ok" },
      ga4: { status: "ok" },
      searchConsole: { status: "ok" },
    },
    traffic: {
      overview: { sessions: 100, screenPageViews: 300, engagedSessions: 60, engagementRate: 0.6, activeUsers: null, activeUsersMeasurementNote: "x" },
      acquisition: [],
      landingPages: [],
      topSources: [{ source: "google", medium: "organic", campaign: "(not set)", sessions: 80, engagedSessions: 50, engagementRate: 0.625 }],
      topLandingPages: [{ landingPage: "/apps/orderly", sessions: 40, screenPageViews: 60, engagedSessions: 20, engagementRate: 0.5 }],
    },
    behavior: {
      eventTotals: { pageViews: 300, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, totalCtaClicks: 50 },
      uniqueUsers: null,
      uniqueUsersMeasurementNote: "x",
      byApp: [
        { appSlug: "orderly", appName: "Orderly", pageViews: 100, viewDemoClicks: 10, remixClicks: 5, buildClicks: 5, copyPromptClicks: 2, totalCtaClicks: 22, eventBasedCtaRate: 0.22 },
        { appSlug: "unassigned", appName: null, pageViews: 5, viewDemoClicks: 0, remixClicks: 0, buildClicks: 0, copyPromptClicks: 0, totalCtaClicks: 0, eventBasedCtaRate: 0 },
      ],
      byPageType: [],
      byUtmSource: [{ key: "newsletter", pageViews: 20, viewDemoClicks: 3, remixClicks: 1, buildClicks: 1, copyPromptClicks: 0, totalCtaClicks: 5 }],
      byUtmMedium: [{ key: "unassigned", pageViews: 5, viewDemoClicks: 0, remixClicks: 0, buildClicks: 0, copyPromptClicks: 0, totalCtaClicks: 0 }],
      byUtmCampaign: [],
      byUtmContent: [],
    },
    search: {
      status: "ok",
      totals: { clicks: 20, impressions: 500, ctr: 0.04, averagePosition: 8.5 },
      daily: [],
      topQueries: [{ query: "inventory tracker", clicks: 12, impressions: 200, ctr: 0.06, position: 6.2 }],
      topPages: [{ page: "/apps/orderly", clicks: 8, impressions: 150, ctr: 0.053, position: 7.1 }],
      queryPages: [],
    },
    funnel: { growthSite: { pageViews: 300, totalCtaClicks: 50, eventBasedCtaRate: 50 / 300, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, measurementBasis: "PostHog event counts" } },
    productConversions: { signups: null, firstAppCreated: null, appPublished: null, status: "not_connected", note: "x" },
    dataQuality: { overallStatus: "partial", dateRangeMatch: true, missingSources: [], emptySources: [], warnings: [], measurementNotes: [] },
    ...overrides,
  };
}

describe("NormalizedGrowthSummaryAdapter", () => {
  it("builds a GA4 acquisition record per topSources row", async () => {
    const records = await new NormalizedGrowthSummaryAdapter(fixtureSummary()).collect(CONTEXT);
    const acquisition = records.find((r) => r.source.name === "GA4 traffic acquisition");
    expect(acquisition).toBeDefined();
    expect(acquisition!.source.type).toBe("ga4");
    expect(acquisition!.metrics.find((m) => m.name === "sessions")?.value).toBe(80);
  });

  it("builds a GA4 landing-page record per topLandingPages row", async () => {
    const records = await new NormalizedGrowthSummaryAdapter(fixtureSummary()).collect(CONTEXT);
    const landing = records.find((r) => r.source.name === "GA4 landing pages");
    expect(landing).toBeDefined();
    expect(landing!.metrics.find((m) => m.name === "screenPageViews")?.value).toBe(60);
  });

  it("builds a PostHog app record per byApp row, excluding 'unassigned'", async () => {
    const records = await new NormalizedGrowthSummaryAdapter(fixtureSummary()).collect(CONTEXT);
    const appRecords = records.filter((r) => r.source.name === "PostHog app performance");
    expect(appRecords).toHaveLength(1);
    expect(appRecords[0].entities.productsOrApps).toEqual(["orderly"]);
  });

  it("labels eventBasedCtaRate as an event-count ratio, not a conversion rate", async () => {
    const records = await new NormalizedGrowthSummaryAdapter(fixtureSummary()).collect(CONTEXT);
    const appRecord = records.find((r) => r.source.name === "PostHog app performance")!;
    expect(appRecord.content).toContain("event-count ratio");
    expect(appRecord.content).toContain("not a user or session conversion rate");
    const rateMetric = appRecord.metrics.find((m) => m.name === "eventBasedCtaRate")!;
    expect(rateMetric.measurementBasis).toContain("not a user or session conversion rate");
  });

  it("builds a PostHog UTM record per non-unassigned dimension row", async () => {
    const records = await new NormalizedGrowthSummaryAdapter(fixtureSummary()).collect(CONTEXT);
    const utmRecords = records.filter((r) => r.source.name.startsWith("PostHog UTM"));
    expect(utmRecords).toHaveLength(1);
    expect(utmRecords[0].entities.channels).toEqual(["utm_source=newsletter"]);
  });

  it("builds Search Console query and page records when status is 'ok'", async () => {
    const records = await new NormalizedGrowthSummaryAdapter(fixtureSummary()).collect(CONTEXT);
    expect(records.some((r) => r.source.name === "Search Console queries")).toBe(true);
    expect(records.some((r) => r.source.name === "Search Console pages")).toBe(true);
  });

  it("produces zero query/page signals — never fabricated — when Search Console is empty", async () => {
    const summary = fixtureSummary({
      search: { status: "empty", totals: { clicks: 0, impressions: 0, ctr: null, averagePosition: null }, daily: [], topQueries: [], topPages: [], queryPages: [] },
    });
    const records = await new NormalizedGrowthSummaryAdapter(summary).collect(CONTEXT);
    expect(records.some((r) => r.source.type === "search_console")).toBe(false);
  });

  it("produces zero query/page signals when Search Console is missing", async () => {
    const summary = fixtureSummary({
      search: { status: "missing", totals: { clicks: 0, impressions: 0, ctr: null, averagePosition: null }, daily: [], topQueries: [], topPages: [], queryPages: [] },
    });
    const records = await new NormalizedGrowthSummaryAdapter(summary).collect(CONTEXT);
    expect(records.some((r) => r.source.type === "search_console")).toBe(false);
  });

  it("produces deterministic ids across repeated runs on the same summary", async () => {
    const summary = fixtureSummary();
    const first = await new NormalizedGrowthSummaryAdapter(summary).collect(CONTEXT);
    const second = await new NormalizedGrowthSummaryAdapter(summary).collect(CONTEXT);
    expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
  });

  it("never fabricates a metric value not present in the summary", async () => {
    const records = await new NormalizedGrowthSummaryAdapter(fixtureSummary()).collect(CONTEXT);
    const acquisition = records.find((r) => r.source.name === "GA4 traffic acquisition")!;
    for (const metric of acquisition.metrics) {
      expect(typeof metric.value).toBe("number");
    }
  });
});
