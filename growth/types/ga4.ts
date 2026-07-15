/** Server-side GA4 connection settings, read from process.env. */
export interface GA4Env {
  propertyId: string;
}

export interface DateRange {
  start: string;
  end: string;
}

/** One of the three fixed GA4 report definitions this collector runs. */
export interface GA4ReportSpec {
  name: string;
  dimensions: string[];
  metrics: string[];
}

/** The three GA4 reports collected for every run, same date range for all three. */
export const GA4_REPORTS = {
  trafficOverview: {
    name: "traffic_overview",
    dimensions: ["date"],
    metrics: ["sessions", "activeUsers", "screenPageViews", "engagedSessions", "engagementRate"],
  },
  trafficAcquisition: {
    name: "traffic_acquisition",
    dimensions: ["date", "sessionSource", "sessionMedium", "sessionCampaignName"],
    metrics: ["sessions", "activeUsers", "engagedSessions", "engagementRate"],
  },
  landingPages: {
    name: "landing_pages",
    dimensions: ["date", "landingPagePlusQueryString"],
    metrics: ["sessions", "activeUsers", "screenPageViews", "engagedSessions", "engagementRate"],
  },
} as const satisfies Record<string, GA4ReportSpec>;

export type GA4ReportKey = keyof typeof GA4_REPORTS;

/** Request shape passed to BetaAnalyticsDataClient#runReport. */
export interface GA4RunReportRequest {
  property: string;
  dateRanges: { startDate: string; endDate: string }[];
  dimensions: { name: string }[];
  metrics: { name: string }[];
}

/**
 * Minimal shape of a `@google-analytics/data` runReport response that this
 * collector depends on. The real response carries more fields (totals,
 * maximums, minimums, metadata, propertyQuota, ...); `[key: string]: unknown`
 * preserves them untouched for the raw snapshot's `responseMeta`.
 */
export interface GA4RunReportResponse {
  dimensionHeaders?: ({ name?: string | null } | null)[] | null;
  metricHeaders?: ({ name?: string | null; type?: unknown } | null)[] | null;
  rows?: unknown[] | null;
  rowCount?: number | null;
  [key: string]: unknown;
}

/** The client surface this collector needs from BetaAnalyticsDataClient. Lets tests inject a mock. */
export interface GA4ReportClient {
  runReport(request: GA4RunReportRequest): Promise<[GA4RunReportResponse, unknown?, unknown?]>;
}

/** A single report's data as saved in the raw snapshot. */
export interface GA4ReportSnapshot {
  headers: { dimensionHeaders: string[]; metricHeaders: string[] };
  rows: unknown[];
  rowCount: number;
  responseMeta?: Record<string, unknown>;
}

export interface GA4Reports {
  trafficOverview: GA4ReportSnapshot;
  trafficAcquisition: GA4ReportSnapshot;
  landingPages: GA4ReportSnapshot;
}

/** The on-disk shape written to growth/data/raw/ga4-{start}_to_{end}.json. */
export interface GA4Snapshot {
  source: "ga4";
  collectedAt: string;
  period: DateRange;
  propertyId: string;
  trafficOverview: GA4ReportSnapshot;
  trafficAcquisition: GA4ReportSnapshot;
  landingPages: GA4ReportSnapshot;
}
