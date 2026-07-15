/** Server-side Search Console connection settings, read from process.env. */
export interface GSCEnv {
  siteUrl: string;
}

export interface DateRange {
  start: string;
  end: string;
}

/** One of the four fixed Search Console report definitions this collector runs. */
export interface GSCReportSpec {
  name: string;
  dimensions: string[];
}

/** The four Search Console reports collected for every run, same date range for all four. */
export const GSC_REPORTS = {
  dailyOverview: { name: "daily_overview", dimensions: ["date"] },
  queries: { name: "queries", dimensions: ["query"] },
  queryPages: { name: "query_pages", dimensions: ["query", "page"] },
  pages: { name: "pages", dimensions: ["page"] },
} as const satisfies Record<string, GSCReportSpec>;

export type GSCReportKey = keyof typeof GSC_REPORTS;

/** Request shape passed to the Search Console searchanalytics.query client method. */
export interface GSCQueryRequest {
  siteUrl: string;
  requestBody: {
    startDate: string;
    endDate: string;
    dimensions: string[];
    searchType: "web";
    dataState: "all";
    rowLimit: number;
    startRow: number;
  };
}

export interface GSCDataRow {
  keys?: (string | null)[] | null;
  clicks?: number | null;
  impressions?: number | null;
  ctr?: number | null;
  position?: number | null;
}

/**
 * Minimal shape of a Search Console searchanalytics.query response this
 * collector depends on. `metadata.firstIncompleteDate` (when dataState is
 * "all" and grouped by date) flags that recent rows aren't finalized yet —
 * preserved untouched so a future normalizer can warn on it.
 */
export interface GSCQueryResponse {
  rows?: GSCDataRow[] | null;
  responseAggregationType?: string | null;
  metadata?: { firstIncompleteDate?: string | null; firstIncompleteHour?: string | null } | null;
  [key: string]: unknown;
}

/** The client surface this collector needs from the Search Console API. Lets tests inject a mock. */
export interface GSCReportClient {
  query(request: GSCQueryRequest): Promise<GSCQueryResponse>;
}

/** A single report's data as saved in the raw snapshot. */
export interface GSCReportSnapshot {
  dimensions: string[];
  rows: GSCDataRow[];
  rowCount: number;
  responseAggregationType?: string | null;
  metadata?: Record<string, unknown>;
}

export interface GSCReports {
  dailyOverview: GSCReportSnapshot;
  queries: GSCReportSnapshot;
  queryPages: GSCReportSnapshot;
  pages: GSCReportSnapshot;
}

/** The on-disk shape written to growth/data/raw/gsc-{start}_to_{end}.json. */
export interface GSCSnapshot {
  source: "search_console";
  collectedAt: string;
  period: DateRange;
  siteUrl: string;
  reports: GSCReports;
}
