import { describe, expect, it } from "vitest";
import { buildGrowthSummary, WARNINGS } from "../normalizers/growth-summary";
import type { PostHogSnapshot } from "../types/posthog";
import type { GA4ReportSnapshot, GA4Snapshot } from "../types/ga4";
import type { GSCReportSnapshot, GSCSnapshot } from "../types/gsc";
import type { DateRange } from "../types/growth-summary";

const PERIOD: DateRange = { start: "2026-07-08", end: "2026-07-09" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };
const GENERATED_AT = "2026-07-10T00:00:00.000Z";

function posthogFixture(rows: unknown[][], period: DateRange = PERIOD): PostHogSnapshot {
  return {
    source: "posthog",
    collectedAt: "2026-07-09T23:00:00.000Z",
    period,
    queryName: "growth_events_aggregate_v1",
    rows,
    results: rows,
  };
}

const POSTHOG_ROWS: unknown[][] = [
  ["2026-07-08", "$pageview", null, null, null, null, null, null, null, 10, 7],
  ["2026-07-09", "$pageview", null, null, null, null, null, null, null, 15, 9],
  [
    "2026-07-08",
    "view_demo_click",
    "bookly",
    "Bookly",
    "app_detail",
    "growth_site",
    "demo_click",
    "small_business_toolkit",
    "booking_appointment_form",
    3,
    2,
  ],
  [
    "2026-07-08",
    "remix_click",
    "bookly",
    "Bookly",
    "app_detail",
    "growth_site",
    "remix_click",
    "small_business_toolkit",
    "booking_appointment_form",
    2,
    2,
  ],
  ["2026-07-09", "build_click", "", null, "homepage", "growth_site", "build_click", "small_business_toolkit", "homepage", 4, 3],
  [
    "2026-07-09",
    "copy_prompt_click",
    "orderly",
    "Orderly",
    "app_detail",
    "growth_site",
    "copy_prompt_click",
    "small_business_toolkit",
    "order_inventory_tracker",
    1,
    1,
  ],
];

function ga4Row(dimensionValues: string[], metricValues: string[]): { dimensionValues: { value: string }[]; metricValues: { value: string }[] } {
  return {
    dimensionValues: dimensionValues.map((value) => ({ value })),
    metricValues: metricValues.map((value) => ({ value })),
  };
}

function ga4ReportFixture(dimensionHeaders: string[], metricHeaders: string[], rows: unknown[]): GA4ReportSnapshot {
  return {
    headers: { dimensionHeaders, metricHeaders },
    rows,
    rowCount: rows.length,
    responseMeta: { totals: [], maximums: [], minimums: [] },
  };
}

function ga4Fixture(period: DateRange = PERIOD): GA4Snapshot {
  return {
    source: "ga4",
    collectedAt: "2026-07-09T23:05:00.000Z",
    period,
    propertyId: "123456789",
    trafficOverview: ga4ReportFixture(
      ["date"],
      ["sessions", "activeUsers", "screenPageViews", "engagedSessions", "engagementRate"],
      [
        ga4Row(["20260708"], ["10", "7", "20", "6", "0.6"]),
        ga4Row(["20260709"], ["15", "9", "30", "10", "0.6667"]),
      ]
    ),
    trafficAcquisition: ga4ReportFixture(
      ["date", "sessionSource", "sessionMedium", "sessionCampaignName"],
      ["sessions", "activeUsers", "engagedSessions", "engagementRate"],
      [
        ga4Row(["20260708", "google", "organic", "(not set)"], ["6", "5", "4", "0.6667"]),
        ga4Row(["20260708", "direct", "(none)", "(direct)"], ["4", "3", "2", "0.5"]),
        ga4Row(["20260709", "google", "organic", "(not set)"], ["15", "9", "10", "0.6667"]),
      ]
    ),
    landingPages: ga4ReportFixture(
      ["date", "landingPagePlusQueryString"],
      ["sessions", "activeUsers", "screenPageViews", "engagedSessions", "engagementRate"],
      [
        ga4Row(["20260708", "/"], ["8", "6", "12", "5", "0.625"]),
        ga4Row(["20260709", "/apps/bookly"], ["17", "10", "38", "11", "0.647"]),
      ]
    ),
  };
}

function gscReportFixture(dimensions: string[], rows: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[]): GSCReportSnapshot {
  return { dimensions, rows, rowCount: rows.length, responseAggregationType: "auto" };
}

function gscFixture(period: DateRange = PERIOD): GSCSnapshot {
  return {
    source: "search_console",
    collectedAt: "2026-07-09T23:10:00.000Z",
    period,
    siteUrl: "sc-domain:example.com",
    reports: {
      dailyOverview: gscReportFixture(
        ["date"],
        [
          { keys: ["2026-07-08"], clicks: 5, impressions: 100, ctr: 0.05, position: 8.2 },
          { keys: ["2026-07-09"], clicks: 3, impressions: 50, ctr: 0.06, position: 6.0 },
        ]
      ),
      queries: gscReportFixture(
        ["query"],
        [
          { keys: ["widget install"], clicks: 5, impressions: 80, ctr: 0.0625, position: 5.0 },
          { keys: ["small business app"], clicks: 3, impressions: 70, ctr: 0.0429, position: 9.0 },
        ]
      ),
      queryPages: gscReportFixture(
        ["query", "page"],
        [
          { keys: ["widget install", "/"], clicks: 5, impressions: 80, ctr: 0.0625, position: 5.0 },
          { keys: ["small business app", "/"], clicks: 3, impressions: 70, ctr: 0.0429, position: 9.0 },
        ]
      ),
      pages: gscReportFixture(["page"], [{ keys: ["/"], clicks: 8, impressions: 150, ctr: 0.0533, position: 7.4667 }]),
    },
  };
}

function emptyGSCFixture(period: DateRange = PERIOD): GSCSnapshot {
  return {
    source: "search_console",
    collectedAt: "2026-07-09T23:10:00.000Z",
    period,
    siteUrl: "sc-domain:example.com",
    reports: {
      dailyOverview: gscReportFixture(["date"], []),
      queries: gscReportFixture(["query"], []),
      queryPages: gscReportFixture(["query", "page"], []),
      pages: gscReportFixture(["page"], []),
    },
  };
}

function buildValidSummary() {
  return buildGrowthSummary({
    period: PERIOD,
    campaign: CAMPAIGN,
    posthog: { filename: "posthog-2026-07-08_to_2026-07-09.json", snapshot: posthogFixture(POSTHOG_ROWS) },
    ga4: { filename: "ga4-2026-07-08_to_2026-07-09.json", snapshot: ga4Fixture() },
    searchConsole: { found: true, filename: "gsc-2026-07-08_to_2026-07-09.json", snapshot: gscFixture() },
    generatedAt: GENERATED_AT,
  });
}

describe("buildGrowthSummary — valid three-source normalization", () => {
  it("produces the top-level processed snapshot structure", () => {
    const summary = buildValidSummary();

    expect(summary.schemaVersion).toBe("1.0.0");
    expect(summary.source).toBe("normalized_growth_summary");
    expect(summary.generatedAt).toBe(GENERATED_AT);
    expect(summary.period).toEqual(PERIOD);
    expect(summary.campaign).toEqual(CAMPAIGN);
    expect(Object.keys(summary).sort()).toEqual(
      ["schemaVersion", "source", "generatedAt", "period", "campaign", "inputs", "traffic", "behavior", "search", "funnel", "productConversions", "dataQuality"].sort()
    );
  });

  it("records input metadata for all three sources", () => {
    const summary = buildValidSummary();

    expect(summary.inputs.posthog).toEqual({
      status: "ok",
      filename: "posthog-2026-07-08_to_2026-07-09.json",
      collectedAt: "2026-07-09T23:00:00.000Z",
      rowCount: POSTHOG_ROWS.length,
    });
    expect(summary.inputs.ga4).toEqual({
      status: "ok",
      filename: "ga4-2026-07-08_to_2026-07-09.json",
      collectedAt: "2026-07-09T23:05:00.000Z",
      reportRowCounts: { trafficOverview: 2, trafficAcquisition: 3, landingPages: 2 },
    });
    expect(summary.inputs.searchConsole).toEqual({
      status: "ok",
      filename: "gsc-2026-07-08_to_2026-07-09.json",
      collectedAt: "2026-07-09T23:10:00.000Z",
      reportRowCounts: { dailyOverview: 2, queries: 2, queryPages: 2, pages: 1 },
    });
  });

  it("matches the requested date range and reports dateRangeMatch true", () => {
    const summary = buildValidSummary();
    expect(summary.dataQuality.dateRangeMatch).toBe(true);
  });
});

describe("date mismatch rejection", () => {
  it("flags dateRangeMatch false and overallStatus invalid when a snapshot's period differs", () => {
    const summary = buildGrowthSummary({
      period: PERIOD,
      campaign: CAMPAIGN,
      posthog: {
        filename: "posthog-2026-07-01_to_2026-07-02.json",
        snapshot: posthogFixture(POSTHOG_ROWS, { start: "2026-07-01", end: "2026-07-02" }),
      },
      ga4: { filename: "ga4-2026-07-08_to_2026-07-09.json", snapshot: ga4Fixture() },
      searchConsole: { found: true, filename: "gsc-2026-07-08_to_2026-07-09.json", snapshot: gscFixture() },
      generatedAt: GENERATED_AT,
    });

    expect(summary.dataQuality.dateRangeMatch).toBe(false);
    expect(summary.dataQuality.overallStatus).toBe("invalid");
    expect(summary.dataQuality.warnings).toContain(WARNINGS.dateRangeMismatch);
  });
});

describe("Search Console handling", () => {
  it("accepts a missing Search Console snapshot with a warning and status 'missing'", () => {
    const summary = buildGrowthSummary({
      period: PERIOD,
      campaign: CAMPAIGN,
      posthog: { filename: "posthog-2026-07-08_to_2026-07-09.json", snapshot: posthogFixture(POSTHOG_ROWS) },
      ga4: { filename: "ga4-2026-07-08_to_2026-07-09.json", snapshot: ga4Fixture() },
      searchConsole: { found: false },
      generatedAt: GENERATED_AT,
    });

    expect(summary.search.status).toBe("missing");
    expect(summary.inputs.searchConsole).toEqual({ status: "missing" });
    expect(summary.dataQuality.missingSources).toEqual(["search_console"]);
    expect(summary.dataQuality.warnings).toContain(WARNINGS.searchConsoleMissing);
    expect(summary.search.totals).toEqual({ clicks: 0, impressions: 0, ctr: null, averagePosition: null });
  });

  it("accepts an all-empty Search Console snapshot with status 'empty' and a warning", () => {
    const summary = buildGrowthSummary({
      period: PERIOD,
      campaign: CAMPAIGN,
      posthog: { filename: "posthog-2026-07-08_to_2026-07-09.json", snapshot: posthogFixture(POSTHOG_ROWS) },
      ga4: { filename: "ga4-2026-07-08_to_2026-07-09.json", snapshot: ga4Fixture() },
      searchConsole: { found: true, filename: "gsc-2026-07-08_to_2026-07-09.json", snapshot: emptyGSCFixture() },
      generatedAt: GENERATED_AT,
    });

    expect(summary.search.status).toBe("empty");
    expect(summary.inputs.searchConsole.status).toBe("empty");
    expect(summary.dataQuality.emptySources).toEqual(["search_console"]);
    expect(summary.dataQuality.warnings).toContain(WARNINGS.searchConsoleAllEmpty);
    expect(summary.search.totals).toEqual({ clicks: 0, impressions: 0, ctr: null, averagePosition: null });
  });
});

describe("GA4 traffic normalization", () => {
  it("sums additive metrics (sessions, screenPageViews, engagedSessions) across daily rows", () => {
    const summary = buildValidSummary();
    expect(summary.traffic.overview.sessions).toBe(25);
    expect(summary.traffic.overview.screenPageViews).toBe(50);
    expect(summary.traffic.overview.engagedSessions).toBe(16);
  });

  it("recomputes engagementRate from summed totals instead of averaging daily rates", () => {
    const summary = buildValidSummary();
    // Additive: 16 / 25 = 0.64. Averaging the raw per-row rates (0.6, 0.6667) would give ~0.633 instead.
    expect(summary.traffic.overview.engagementRate).toBeCloseTo(0.64, 5);
  });

  it("does not sum daily activeUsers into a period-level unique-user metric", () => {
    const summary = buildValidSummary();
    expect(summary.traffic.overview.activeUsers).toBeNull();
    expect(summary.traffic.overview.activeUsersMeasurementNote).toBeTruthy();
    expect(summary.dataQuality.warnings).toContain(WARNINGS.ga4ActiveUsersNotSummed);
  });

  it("normalizes acquisition rows with recomputed per-row engagementRate", () => {
    const summary = buildValidSummary();
    expect(summary.traffic.acquisition).toHaveLength(3);
    const directRow = summary.traffic.acquisition.find((r) => r.source === "direct");
    expect(directRow).toMatchObject({ date: "2026-07-08", medium: "(none)", campaign: "(direct)", sessions: 4, engagedSessions: 2 });
    expect(directRow?.engagementRate).toBeCloseTo(0.5, 5);
  });

  it("aggregates topSources by source/medium/campaign, sorted by sessions descending", () => {
    const summary = buildValidSummary();
    expect(summary.traffic.topSources[0]).toMatchObject({ source: "google", medium: "organic", campaign: "(not set)", sessions: 21, engagedSessions: 14 });
    expect(summary.traffic.topSources[1]).toMatchObject({ source: "direct", sessions: 4 });
  });

  it("aggregates topLandingPages sorted by sessions descending", () => {
    const summary = buildValidSummary();
    expect(summary.traffic.topLandingPages[0]).toMatchObject({ landingPage: "/apps/bookly", sessions: 17 });
    expect(summary.traffic.topLandingPages[1]).toMatchObject({ landingPage: "/", sessions: 8 });
  });

  it("converts GA4's YYYYMMDD date dimension to YYYY-MM-DD", () => {
    const summary = buildValidSummary();
    expect(summary.traffic.landingPages.map((r) => r.date)).toEqual(["2026-07-08", "2026-07-09"]);
  });
});

describe("PostHog behavior normalization", () => {
  it("aggregates event totals across all rows", () => {
    const summary = buildValidSummary();
    expect(summary.behavior.eventTotals).toEqual({
      pageViews: 25,
      viewDemoClicks: 3,
      remixClicks: 2,
      buildClicks: 4,
      copyPromptClicks: 1,
      totalCtaClicks: 10,
    });
  });

  it("groups by app, routing missing/empty app_slug into 'unassigned'", () => {
    const summary = buildValidSummary();
    const byApp = Object.fromEntries(summary.behavior.byApp.map((r) => [r.appSlug, r]));

    expect(byApp.unassigned).toMatchObject({ pageViews: 25, buildClicks: 4, totalCtaClicks: 4 });
    expect(byApp.bookly).toMatchObject({ appName: "Bookly", viewDemoClicks: 3, remixClicks: 2, totalCtaClicks: 5, pageViews: 0 });
    expect(byApp.orderly).toMatchObject({ appName: "Orderly", copyPromptClicks: 1, totalCtaClicks: 1 });
  });

  it("returns null eventBasedCtaRate when an app group has zero pageViews", () => {
    const summary = buildValidSummary();
    const bookly = summary.behavior.byApp.find((r) => r.appSlug === "bookly");
    expect(bookly?.eventBasedCtaRate).toBeNull();
  });

  it("computes a non-null eventBasedCtaRate when pageViews is positive", () => {
    const summary = buildValidSummary();
    const unassigned = summary.behavior.byApp.find((r) => r.appSlug === "unassigned");
    expect(unassigned?.eventBasedCtaRate).toBeCloseTo(4 / 25, 5);
  });

  it("groups by page type, routing null page_type into 'unassigned'", () => {
    const summary = buildValidSummary();
    const byPageType = Object.fromEntries(summary.behavior.byPageType.map((r) => [r.key, r]));
    expect(byPageType.unassigned.pageViews).toBe(25);
    expect(byPageType.app_detail.totalCtaClicks).toBe(6);
    expect(byPageType.homepage.buildClicks).toBe(4);
  });

  it("does not sum grouped unique_users into a global unique-user count", () => {
    const summary = buildValidSummary();
    expect(summary.behavior.uniqueUsers).toBeNull();
    expect(summary.behavior.uniqueUsersMeasurementNote).toBeTruthy();
    expect(summary.dataQuality.warnings).toContain(WARNINGS.posthogUniqueUsersNotSummed);
  });
});

describe("Search Console normalization", () => {
  it("sums clicks and impressions from the daily_overview report", () => {
    const summary = buildValidSummary();
    expect(summary.search.totals.clicks).toBe(8);
    expect(summary.search.totals.impressions).toBe(150);
  });

  it("recomputes ctr from summed totals instead of averaging row-level ctr", () => {
    const summary = buildValidSummary();
    // Additive: 8 / 150 ≈ 0.05333. Averaging the raw row ctrs (0.05, 0.06) would give 0.055 instead.
    expect(summary.search.totals.ctr).toBeCloseTo(8 / 150, 5);
    expect(summary.search.totals.ctr).not.toBeCloseTo(0.055, 5);
  });

  it("computes an impressions-weighted average position", () => {
    const summary = buildValidSummary();
    // (8.2*100 + 6.0*50) / 150 ≈ 7.4667. A plain average of (8.2, 6.0) would give 7.1 instead.
    expect(summary.search.totals.averagePosition).toBeCloseTo((8.2 * 100 + 6.0 * 50) / 150, 4);
    expect(summary.search.totals.averagePosition).not.toBeCloseTo(7.1, 2);
  });

  it("sorts topQueries by clicks descending, then impressions descending", () => {
    const summary = buildValidSummary();
    expect(summary.search.topQueries.map((r) => r.query)).toEqual(["widget install", "small business app"]);
  });

  it("sorts topPages by clicks descending", () => {
    const summary = buildValidSummary();
    expect(summary.search.topPages[0]).toMatchObject({ page: "/", clicks: 8 });
  });

  it("includes queryPages rows with both query and page keys", () => {
    const summary = buildValidSummary();
    expect(summary.search.queryPages).toHaveLength(2);
    expect(summary.search.queryPages[0]).toMatchObject({ query: "widget install", page: "/" });
  });

  it("caps topQueries and topPages at 20 rows", () => {
    const manyQueries = Array.from({ length: 25 }, (_, i) => ({
      keys: [`query-${i}`],
      clicks: 25 - i,
      impressions: 100,
      ctr: 0.1,
      position: 5,
    }));
    const snapshot = gscFixture();
    snapshot.reports.queries = gscReportFixture(["query"], manyQueries);

    const summary = buildGrowthSummary({
      period: PERIOD,
      campaign: CAMPAIGN,
      posthog: { filename: "posthog-2026-07-08_to_2026-07-09.json", snapshot: posthogFixture(POSTHOG_ROWS) },
      ga4: { filename: "ga4-2026-07-08_to_2026-07-09.json", snapshot: ga4Fixture() },
      searchConsole: { found: true, filename: "gsc-2026-07-08_to_2026-07-09.json", snapshot },
      generatedAt: GENERATED_AT,
    });

    expect(summary.search.topQueries).toHaveLength(20);
    expect(summary.search.topQueries[0].query).toBe("query-0");
  });
});

describe("Funnel", () => {
  it("computes an event-count-based CTA rate, not a session/user conversion rate", () => {
    const summary = buildValidSummary();
    expect(summary.funnel.growthSite).toEqual({
      pageViews: 25,
      totalCtaClicks: 10,
      eventBasedCtaRate: 10 / 25,
      viewDemoClicks: 3,
      remixClicks: 2,
      buildClicks: 4,
      copyPromptClicks: 1,
      measurementBasis: "PostHog event counts",
    });
  });

  it("returns null eventBasedCtaRate when pageViews is zero", () => {
    const summary = buildGrowthSummary({
      period: PERIOD,
      campaign: CAMPAIGN,
      posthog: { filename: "posthog-2026-07-08_to_2026-07-09.json", snapshot: posthogFixture([]) },
      ga4: { filename: "ga4-2026-07-08_to_2026-07-09.json", snapshot: ga4Fixture() },
      searchConsole: { found: true, filename: "gsc-2026-07-08_to_2026-07-09.json", snapshot: gscFixture() },
      generatedAt: GENERATED_AT,
    });
    expect(summary.funnel.growthSite.eventBasedCtaRate).toBeNull();
  });
});

describe("Zero-denominator rates", () => {
  it("returns null engagementRate when sessions is zero", () => {
    const ga4Empty = ga4Fixture();
    ga4Empty.trafficOverview = ga4ReportFixture(["date"], ["sessions", "activeUsers", "screenPageViews", "engagedSessions", "engagementRate"], []);

    const summary = buildGrowthSummary({
      period: PERIOD,
      campaign: CAMPAIGN,
      posthog: { filename: "posthog-2026-07-08_to_2026-07-09.json", snapshot: posthogFixture(POSTHOG_ROWS) },
      ga4: { filename: "ga4-2026-07-08_to_2026-07-09.json", snapshot: ga4Empty },
      searchConsole: { found: true, filename: "gsc-2026-07-08_to_2026-07-09.json", snapshot: gscFixture() },
      generatedAt: GENERATED_AT,
    });

    expect(summary.traffic.overview.sessions).toBe(0);
    expect(summary.traffic.overview.engagementRate).toBeNull();
  });

  it("returns null ctr and averagePosition when impressions is zero", () => {
    const summary = buildGrowthSummary({
      period: PERIOD,
      campaign: CAMPAIGN,
      posthog: { filename: "posthog-2026-07-08_to_2026-07-09.json", snapshot: posthogFixture(POSTHOG_ROWS) },
      ga4: { filename: "ga4-2026-07-08_to_2026-07-09.json", snapshot: ga4Fixture() },
      searchConsole: { found: true, filename: "gsc-2026-07-08_to_2026-07-09.json", snapshot: emptyGSCFixture() },
      generatedAt: GENERATED_AT,
    });

    expect(summary.search.totals.ctr).toBeNull();
    expect(summary.search.totals.averagePosition).toBeNull();
  });
});

describe("Product conversions", () => {
  it("remain null and not_connected, never substituting zeros", () => {
    const summary = buildValidSummary();
    expect(summary.productConversions).toEqual({
      signups: null,
      firstAppCreated: null,
      appPublished: null,
      status: "not_connected",
      note: "Whacka product-side attribution has not been connected yet.",
    });
    expect(summary.dataQuality.warnings).toContain(WARNINGS.productConversionsNotConnected);
  });
});

describe("Data quality", () => {
  it("is 'partial' for a currently-expected v0 run (unique-user + product-conversion caveats always apply)", () => {
    const summary = buildValidSummary();
    expect(summary.dataQuality.overallStatus).toBe("partial");
    expect(summary.dataQuality.missingSources).toEqual([]);
    expect(summary.dataQuality.emptySources).toEqual([]);
  });

  it("never includes credentials, tokens, or secrets in the output", () => {
    const summary = buildValidSummary();
    const serialized = JSON.stringify(summary).toLowerCase();
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("refresh_token");
  });
});
