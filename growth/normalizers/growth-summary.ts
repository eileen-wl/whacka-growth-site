import { AGGREGATE_COLUMNS } from "../types/posthog";
import type { PostHogSnapshot } from "../types/posthog";
import type { GA4ReportSnapshot, GA4Snapshot } from "../types/ga4";
import type { GSCDataRow, GSCReportSnapshot, GSCSnapshot } from "../types/gsc";
import type {
  Behavior,
  ByAppRow,
  ByDimensionRow,
  CampaignInfo,
  DataQuality,
  DateRange,
  EventTotals,
  Funnel,
  GrowthSiteFunnel,
  GrowthSummary,
  GrowthSummaryInputs,
  LandingPageRow,
  ProductConversions,
  Search,
  SearchDailyRow,
  SearchPageRow,
  SearchQueryPageRow,
  SearchQueryRow,
  SearchTotals,
  Traffic,
  TrafficAcquisitionRow,
  TrafficOverview,
  TopLandingPageAggregate,
  TopSourceAggregate,
} from "../types/growth-summary";

const UNASSIGNED = "unassigned";
const TOP_LIMIT = 20;

export const WARNINGS = {
  ga4ActiveUsersNotSummed: "GA4 daily activeUsers were not summed into a period-level unique-user metric.",
  posthogUniqueUsersNotSummed: "PostHog grouped unique-user counts were not summed because users may occur in multiple groups.",
  productConversionsNotConnected: "Whacka product-side signup and activation attribution is not connected.",
  searchConsoleAllEmpty:
    "Search Console API connection succeeded, but all search-performance reports returned zero rows.",
  searchConsoleMissing: "Search Console raw snapshot was not found for this date range; search-performance data is unavailable.",
  dateRangeMismatch: "One or more input snapshots' internal period does not match the requested period.",
} as const;

const ACTIVE_USERS_NOTE =
  "Period-level unique active users cannot be safely derived by summing daily GA4 activeUsers values, " +
  "since the same person may appear on multiple days; GA4 did not return a reliable period-level total for this range.";

const UNIQUE_USERS_NOTE =
  "PostHog's raw snapshot only contains unique_users grouped by dimension (event/app/page/utm); the same " +
  "distinct_id can appear in multiple groups, so a site-wide unique-user count cannot be safely derived by summing them.";

// ---------------------------------------------------------------------------
// PostHog behavior normalization
// ---------------------------------------------------------------------------

interface PostHogParsedRow {
  event: string;
  appSlug: string;
  appName: string | null;
  pageType: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmContent: string;
  eventCount: number;
}

function orUnassigned(value: unknown): string {
  if (value === null || value === undefined) return UNASSIGNED;
  const str = String(value);
  return str.trim().length > 0 ? str : UNASSIGNED;
}

/** Column order is AGGREGATE_COLUMNS: date, event, app_slug, app_name, page_type, utm_source, utm_medium, utm_campaign, utm_content, event_count, unique_users. */
function parsePostHogRows(snapshot: PostHogSnapshot): PostHogParsedRow[] {
  const eventIdx = AGGREGATE_COLUMNS.indexOf("event");
  const appSlugIdx = AGGREGATE_COLUMNS.indexOf("app_slug");
  const appNameIdx = AGGREGATE_COLUMNS.indexOf("app_name");
  const pageTypeIdx = AGGREGATE_COLUMNS.indexOf("page_type");
  const utmSourceIdx = AGGREGATE_COLUMNS.indexOf("utm_source");
  const utmMediumIdx = AGGREGATE_COLUMNS.indexOf("utm_medium");
  const utmCampaignIdx = AGGREGATE_COLUMNS.indexOf("utm_campaign");
  const utmContentIdx = AGGREGATE_COLUMNS.indexOf("utm_content");
  const eventCountIdx = AGGREGATE_COLUMNS.indexOf("event_count");

  return snapshot.rows.map((row) => {
    const rawAppName = row[appNameIdx];
    return {
      event: String(row[eventIdx] ?? ""),
      appSlug: orUnassigned(row[appSlugIdx]),
      appName: rawAppName === null || rawAppName === undefined || rawAppName === "" ? null : String(rawAppName),
      pageType: orUnassigned(row[pageTypeIdx]),
      utmSource: orUnassigned(row[utmSourceIdx]),
      utmMedium: orUnassigned(row[utmMediumIdx]),
      utmCampaign: orUnassigned(row[utmCampaignIdx]),
      utmContent: orUnassigned(row[utmContentIdx]),
      eventCount: Number(row[eventCountIdx] ?? 0),
    };
  });
}

interface EventAccumulator {
  pageViews: number;
  viewDemoClicks: number;
  remixClicks: number;
  buildClicks: number;
  copyPromptClicks: number;
}

function newEventAccumulator(): EventAccumulator {
  return { pageViews: 0, viewDemoClicks: 0, remixClicks: 0, buildClicks: 0, copyPromptClicks: 0 };
}

function addEventCount(acc: EventAccumulator, event: string, count: number): void {
  switch (event) {
    case "$pageview":
      acc.pageViews += count;
      break;
    case "view_demo_click":
      acc.viewDemoClicks += count;
      break;
    case "remix_click":
      acc.remixClicks += count;
      break;
    case "build_click":
      acc.buildClicks += count;
      break;
    case "copy_prompt_click":
      acc.copyPromptClicks += count;
      break;
    default:
      // The PostHog collector's query already restricts to the five Growth
      // Data Specification events; anything else is ignored defensively.
      break;
  }
}

function totalCta(acc: EventAccumulator): number {
  return acc.viewDemoClicks + acc.remixClicks + acc.buildClicks + acc.copyPromptClicks;
}

function computeEventTotals(rows: PostHogParsedRow[]): EventTotals {
  const acc = newEventAccumulator();
  for (const row of rows) addEventCount(acc, row.event, row.eventCount);
  return { ...acc, totalCtaClicks: totalCta(acc) };
}

function groupByApp(rows: PostHogParsedRow[]): ByAppRow[] {
  const groups = new Map<string, EventAccumulator & { appName: string | null }>();

  for (const row of rows) {
    const existing = groups.get(row.appSlug);
    const acc = existing ?? { appName: null, ...newEventAccumulator() };
    if (!acc.appName && row.appName) acc.appName = row.appName;
    addEventCount(acc, row.event, row.eventCount);
    groups.set(row.appSlug, acc);
  }

  return [...groups.entries()].map(([appSlug, acc]) => {
    const totalCtaClicks = totalCta(acc);
    return {
      appSlug,
      appName: acc.appName,
      pageViews: acc.pageViews,
      viewDemoClicks: acc.viewDemoClicks,
      remixClicks: acc.remixClicks,
      buildClicks: acc.buildClicks,
      copyPromptClicks: acc.copyPromptClicks,
      totalCtaClicks,
      eventBasedCtaRate: acc.pageViews > 0 ? totalCtaClicks / acc.pageViews : null,
    };
  });
}

function groupByDimension(rows: PostHogParsedRow[], keyFn: (row: PostHogParsedRow) => string): ByDimensionRow[] {
  const groups = new Map<string, EventAccumulator>();

  for (const row of rows) {
    const key = keyFn(row);
    const acc = groups.get(key) ?? newEventAccumulator();
    addEventCount(acc, row.event, row.eventCount);
    groups.set(key, acc);
  }

  return [...groups.entries()].map(([key, acc]) => ({ key, ...acc, totalCtaClicks: totalCta(acc) }));
}

function normalizePostHogBehavior(snapshot: PostHogSnapshot): Behavior {
  const rows = parsePostHogRows(snapshot);

  return {
    eventTotals: computeEventTotals(rows),
    uniqueUsers: null,
    uniqueUsersMeasurementNote: UNIQUE_USERS_NOTE,
    byApp: groupByApp(rows),
    byPageType: groupByDimension(rows, (r) => r.pageType),
    byUtmSource: groupByDimension(rows, (r) => r.utmSource),
    byUtmMedium: groupByDimension(rows, (r) => r.utmMedium),
    byUtmCampaign: groupByDimension(rows, (r) => r.utmCampaign),
    byUtmContent: groupByDimension(rows, (r) => r.utmContent),
  };
}

// ---------------------------------------------------------------------------
// GA4 traffic normalization
// ---------------------------------------------------------------------------

interface GA4RawRow {
  dimensionValues?: ({ value?: string | null } | null)[] | null;
  metricValues?: ({ value?: string | null } | null)[] | null;
}

interface GA4ParsedRow {
  dimensions: string[];
  metrics: number[];
}

function parseGA4Rows(report: GA4ReportSnapshot): GA4ParsedRow[] {
  const dimensionCount = report.headers.dimensionHeaders.length;
  const metricCount = report.headers.metricHeaders.length;

  return report.rows.map((rawRow) => {
    const row = rawRow as GA4RawRow;
    const dimensions = Array.from({ length: dimensionCount }, (_, i) => row.dimensionValues?.[i]?.value ?? "");
    const metrics = Array.from({ length: metricCount }, (_, i) => {
      const raw = row.metricValues?.[i]?.value;
      const parsed = raw === undefined || raw === null ? NaN : Number(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    });
    return { dimensions, metrics };
  });
}

function ga4MetricIndex(report: GA4ReportSnapshot, name: string): number {
  return report.headers.metricHeaders.indexOf(name);
}

/** GA4's `date` dimension returns "YYYYMMDD"; converts it to "YYYY-MM-DD". Passes non-conforming values through unchanged. */
function formatGA4Date(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
}

/**
 * Looks for a reliable period-level activeUsers total in the report's
 * responseMeta.totals (populated only when the GA4 request asks for TOTAL
 * metric aggregation — the current collector doesn't, so this is normally
 * unavailable and callers should treat a null result as expected, not a bug).
 */
function extractReliableActiveUsersTotal(report: GA4ReportSnapshot): number | null {
  const totals = report.responseMeta?.totals;
  if (!Array.isArray(totals) || totals.length === 0) return null;

  const idx = ga4MetricIndex(report, "activeUsers");
  if (idx < 0) return null;

  const totalRow = totals[0] as GA4RawRow | undefined;
  const raw = totalRow?.metricValues?.[idx]?.value;
  if (raw === undefined || raw === null) return null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function sumMetric(rows: GA4ParsedRow[], index: number): number {
  if (index < 0) return 0;
  return rows.reduce((sum, row) => sum + (row.metrics[index] ?? 0), 0);
}

function engagementRateOf(sessions: number, engagedSessions: number): number | null {
  return sessions > 0 ? engagedSessions / sessions : null;
}

function normalizeGA4TrafficOverview(report: GA4ReportSnapshot): { overview: TrafficOverview; warnings: string[] } {
  const rows = parseGA4Rows(report);
  const sessions = sumMetric(rows, ga4MetricIndex(report, "sessions"));
  const screenPageViews = sumMetric(rows, ga4MetricIndex(report, "screenPageViews"));
  const engagedSessions = sumMetric(rows, ga4MetricIndex(report, "engagedSessions"));

  const activeUsers = extractReliableActiveUsersTotal(report);
  const warnings = activeUsers === null ? [WARNINGS.ga4ActiveUsersNotSummed] : [];

  return {
    overview: {
      sessions,
      screenPageViews,
      engagedSessions,
      engagementRate: engagementRateOf(sessions, engagedSessions),
      activeUsers,
      activeUsersMeasurementNote: activeUsers === null ? ACTIVE_USERS_NOTE : null,
    },
    warnings,
  };
}

function normalizeGA4Acquisition(report: GA4ReportSnapshot): TrafficAcquisitionRow[] {
  const rows = parseGA4Rows(report);
  const sessionsIdx = ga4MetricIndex(report, "sessions");
  const engagedIdx = ga4MetricIndex(report, "engagedSessions");

  return rows.map((row) => {
    const sessions = row.metrics[sessionsIdx] ?? 0;
    const engagedSessions = row.metrics[engagedIdx] ?? 0;
    return {
      date: formatGA4Date(row.dimensions[0] ?? ""),
      source: row.dimensions[1] ?? "",
      medium: row.dimensions[2] ?? "",
      campaign: row.dimensions[3] ?? "",
      sessions,
      engagedSessions,
      engagementRate: engagementRateOf(sessions, engagedSessions),
    };
  });
}

function normalizeGA4LandingPages(report: GA4ReportSnapshot): LandingPageRow[] {
  const rows = parseGA4Rows(report);
  const sessionsIdx = ga4MetricIndex(report, "sessions");
  const pageViewsIdx = ga4MetricIndex(report, "screenPageViews");
  const engagedIdx = ga4MetricIndex(report, "engagedSessions");

  return rows.map((row) => {
    const sessions = row.metrics[sessionsIdx] ?? 0;
    const screenPageViews = row.metrics[pageViewsIdx] ?? 0;
    const engagedSessions = row.metrics[engagedIdx] ?? 0;
    return {
      date: formatGA4Date(row.dimensions[0] ?? ""),
      landingPage: row.dimensions[1] ?? "",
      sessions,
      screenPageViews,
      engagedSessions,
      engagementRate: engagementRateOf(sessions, engagedSessions),
    };
  });
}

function aggregateTopSources(acquisition: TrafficAcquisitionRow[]): TopSourceAggregate[] {
  const groups = new Map<string, { source: string; medium: string; campaign: string; sessions: number; engagedSessions: number }>();

  for (const row of acquisition) {
    const key = `${row.source} ${row.medium} ${row.campaign}`;
    const existing = groups.get(key);
    if (existing) {
      existing.sessions += row.sessions;
      existing.engagedSessions += row.engagedSessions;
    } else {
      groups.set(key, { source: row.source, medium: row.medium, campaign: row.campaign, sessions: row.sessions, engagedSessions: row.engagedSessions });
    }
  }

  return [...groups.values()]
    .map((g) => ({ ...g, engagementRate: engagementRateOf(g.sessions, g.engagedSessions) }))
    .sort((a, b) => b.sessions - a.sessions);
}

function aggregateTopLandingPages(landingPages: LandingPageRow[]): TopLandingPageAggregate[] {
  const groups = new Map<string, { landingPage: string; sessions: number; screenPageViews: number; engagedSessions: number }>();

  for (const row of landingPages) {
    const existing = groups.get(row.landingPage);
    if (existing) {
      existing.sessions += row.sessions;
      existing.screenPageViews += row.screenPageViews;
      existing.engagedSessions += row.engagedSessions;
    } else {
      groups.set(row.landingPage, {
        landingPage: row.landingPage,
        sessions: row.sessions,
        screenPageViews: row.screenPageViews,
        engagedSessions: row.engagedSessions,
      });
    }
  }

  return [...groups.values()]
    .map((g) => ({ ...g, engagementRate: engagementRateOf(g.sessions, g.engagedSessions) }))
    .sort((a, b) => b.sessions - a.sessions);
}

function normalizeGA4Traffic(snapshot: GA4Snapshot): { traffic: Traffic; warnings: string[] } {
  const overviewResult = normalizeGA4TrafficOverview(snapshot.trafficOverview);
  const acquisition = normalizeGA4Acquisition(snapshot.trafficAcquisition);
  const landingPages = normalizeGA4LandingPages(snapshot.landingPages);

  return {
    traffic: {
      overview: overviewResult.overview,
      acquisition,
      landingPages,
      topSources: aggregateTopSources(acquisition),
      topLandingPages: aggregateTopLandingPages(landingPages),
    },
    warnings: overviewResult.warnings,
  };
}

// ---------------------------------------------------------------------------
// Search Console normalization
// ---------------------------------------------------------------------------

interface GSCParsedRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

function parseGSCRows(report: GSCReportSnapshot): GSCParsedRow[] {
  return report.rows.map((row: GSCDataRow) => ({
    keys: (row.keys ?? []).map((k) => k ?? ""),
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? null,
    position: row.position ?? null,
  }));
}

function weightedAveragePosition(rows: GSCParsedRow[]): number | null {
  let totalImpressions = 0;
  let weightedSum = 0;

  for (const row of rows) {
    if (row.impressions > 0 && typeof row.position === "number") {
      weightedSum += row.position * row.impressions;
      totalImpressions += row.impressions;
    }
  }

  return totalImpressions > 0 ? weightedSum / totalImpressions : null;
}

function sortByClicksThenImpressions<T extends { clicks: number; impressions: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

function isGSCReportsEmpty(snapshot: GSCSnapshot): boolean {
  const { reports } = snapshot;
  return (
    reports.dailyOverview.rowCount === 0 &&
    reports.queries.rowCount === 0 &&
    reports.queryPages.rowCount === 0 &&
    reports.pages.rowCount === 0
  );
}

function emptySearchTotals(): SearchTotals {
  return { clicks: 0, impressions: 0, ctr: null, averagePosition: null };
}

export type SearchConsoleInput = { found: true; snapshot: GSCSnapshot } | { found: false };

function normalizeSearchConsole(input: SearchConsoleInput): { search: Search; warnings: string[] } {
  if (!input.found) {
    return {
      search: { status: "missing", totals: emptySearchTotals(), daily: [], topQueries: [], topPages: [], queryPages: [] },
      warnings: [WARNINGS.searchConsoleMissing],
    };
  }

  const { reports } = input.snapshot;
  const allEmpty = isGSCReportsEmpty(input.snapshot);

  const dailyRows = parseGSCRows(reports.dailyOverview);
  const totalClicks = dailyRows.reduce((sum, r) => sum + r.clicks, 0);
  const totalImpressions = dailyRows.reduce((sum, r) => sum + r.impressions, 0);

  const totals: SearchTotals = {
    clicks: totalClicks,
    impressions: totalImpressions,
    ctr: totalImpressions > 0 ? totalClicks / totalImpressions : null,
    averagePosition: weightedAveragePosition(dailyRows),
  };

  const daily: SearchDailyRow[] = dailyRows.map((r) => ({
    date: r.keys[0] ?? "",
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));

  const queryRows: SearchQueryRow[] = parseGSCRows(reports.queries).map((r) => ({
    query: r.keys[0] ?? "",
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
  const topQueries = sortByClicksThenImpressions(queryRows).slice(0, TOP_LIMIT);

  const pageRows: SearchPageRow[] = parseGSCRows(reports.pages).map((r) => ({
    page: r.keys[0] ?? "",
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
  const topPages = sortByClicksThenImpressions(pageRows).slice(0, TOP_LIMIT);

  const queryPages: SearchQueryPageRow[] = sortByClicksThenImpressions(
    parseGSCRows(reports.queryPages).map((r) => ({
      query: r.keys[0] ?? "",
      page: r.keys[1] ?? "",
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }))
  );

  return {
    search: { status: allEmpty ? "empty" : "ok", totals, daily, topQueries, topPages, queryPages },
    warnings: allEmpty ? [WARNINGS.searchConsoleAllEmpty] : [],
  };
}

// ---------------------------------------------------------------------------
// Funnel / product conversions
// ---------------------------------------------------------------------------

function buildFunnel(eventTotals: EventTotals): Funnel {
  const growthSite: GrowthSiteFunnel = {
    pageViews: eventTotals.pageViews,
    totalCtaClicks: eventTotals.totalCtaClicks,
    eventBasedCtaRate: eventTotals.pageViews > 0 ? eventTotals.totalCtaClicks / eventTotals.pageViews : null,
    viewDemoClicks: eventTotals.viewDemoClicks,
    remixClicks: eventTotals.remixClicks,
    buildClicks: eventTotals.buildClicks,
    copyPromptClicks: eventTotals.copyPromptClicks,
    measurementBasis: "PostHog event counts",
  };
  return { growthSite };
}

function buildProductConversions(): ProductConversions {
  return {
    signups: null,
    firstAppCreated: null,
    appPublished: null,
    status: "not_connected",
    note: "Whacka product-side attribution has not been connected yet.",
  };
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

function periodsEqual(a: DateRange, b: DateRange): boolean {
  return a.start === b.start && a.end === b.end;
}

export interface BuildGrowthSummaryParams {
  period: DateRange;
  campaign: CampaignInfo;
  posthog: { filename: string; snapshot: PostHogSnapshot };
  ga4: { filename: string; snapshot: GA4Snapshot };
  searchConsole: { found: true; filename: string; snapshot: GSCSnapshot } | { found: false };
  /** Injectable for deterministic tests; defaults to the current time. */
  generatedAt?: string;
}

export function buildGrowthSummary(params: BuildGrowthSummaryParams): GrowthSummary {
  const { period, campaign, posthog, ga4, searchConsole } = params;

  const dateRangeMatch =
    periodsEqual(posthog.snapshot.period, period) &&
    periodsEqual(ga4.snapshot.period, period) &&
    (!searchConsole.found || periodsEqual(searchConsole.snapshot.period, period));

  const behavior = normalizePostHogBehavior(posthog.snapshot);
  const { traffic, warnings: ga4Warnings } = normalizeGA4Traffic(ga4.snapshot);
  const { search, warnings: searchWarnings } = normalizeSearchConsole(
    searchConsole.found ? { found: true, snapshot: searchConsole.snapshot } : { found: false }
  );

  const funnel = buildFunnel(behavior.eventTotals);
  const productConversions = buildProductConversions();

  const inputs: GrowthSummaryInputs = {
    posthog: {
      status: "ok",
      filename: posthog.filename,
      collectedAt: posthog.snapshot.collectedAt,
      rowCount: posthog.snapshot.rows.length,
    },
    ga4: {
      status: "ok",
      filename: ga4.filename,
      collectedAt: ga4.snapshot.collectedAt,
      reportRowCounts: {
        trafficOverview: ga4.snapshot.trafficOverview.rowCount,
        trafficAcquisition: ga4.snapshot.trafficAcquisition.rowCount,
        landingPages: ga4.snapshot.landingPages.rowCount,
      },
    },
    searchConsole: searchConsole.found
      ? {
          status: search.status === "empty" ? "empty" : "ok",
          filename: searchConsole.filename,
          collectedAt: searchConsole.snapshot.collectedAt,
          reportRowCounts: {
            dailyOverview: searchConsole.snapshot.reports.dailyOverview.rowCount,
            queries: searchConsole.snapshot.reports.queries.rowCount,
            queryPages: searchConsole.snapshot.reports.queryPages.rowCount,
            pages: searchConsole.snapshot.reports.pages.rowCount,
          },
        }
      : { status: "missing" },
  };

  const warnings = [...ga4Warnings, WARNINGS.posthogUniqueUsersNotSummed, ...searchWarnings, WARNINGS.productConversionsNotConnected];
  if (!dateRangeMatch) warnings.unshift(WARNINGS.dateRangeMismatch);

  const measurementNotes = [ACTIVE_USERS_NOTE, UNIQUE_USERS_NOTE].filter(
    (note, index, all) => all.indexOf(note) === index
  );

  const missingSources: string[] = [];
  const emptySources: string[] = [];
  if (!searchConsole.found) missingSources.push("search_console");
  else if (search.status === "empty") emptySources.push("search_console");

  const overallStatus: DataQuality["overallStatus"] = !dateRangeMatch
    ? "invalid"
    : missingSources.length === 0 && emptySources.length === 0 && warnings.length === 0
      ? "complete"
      : "partial";

  const dataQuality: DataQuality = {
    overallStatus,
    dateRangeMatch,
    missingSources,
    emptySources,
    warnings,
    measurementNotes,
  };

  return {
    schemaVersion: "1.0.0",
    source: "normalized_growth_summary",
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    period,
    campaign,
    inputs,
    traffic,
    behavior,
    search,
    funnel,
    productConversions,
    dataQuality,
  };
}
