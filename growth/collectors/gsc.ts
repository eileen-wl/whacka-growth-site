import {
  GSC_REPORTS,
  type GSCDataRow,
  type GSCEnv,
  type GSCQueryResponse,
  type GSCReportClient,
  type GSCReports,
  type GSCReportSnapshot,
  type GSCReportSpec,
} from "../types/gsc";

const WEBMASTERS_READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Max rows per page, per the Search Console API's documented rowLimit ceiling. */
const ROW_LIMIT = 25000;

/** Safety cap on pagination pages (25M rows) so a misbehaving API can't loop forever. */
const MAX_PAGES = 1000;

export class GSCConfigError extends Error {}
export class GSCDateRangeError extends Error {}
export class GSCApiError extends Error {}
export class GSCResponseShapeError extends Error {}

/**
 * Validates a GSC_SITE_URL value against the two property formats Search
 * Console supports. Deliberately does not touch trailing slashes or casing
 * — the value must match the property registered in Search Console
 * exactly, so we only validate shape, never normalize it.
 */
export function isValidGSCSiteUrl(value: string): boolean {
  if (!value || /\s/.test(value)) return false;

  if (value.startsWith("sc-domain:")) {
    const domain = value.slice("sc-domain:".length);
    return domain.length > 0 && !domain.includes("://");
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/** Reads and validates the GSC_SITE_URL env var. */
export function readGSCEnv(source: NodeJS.ProcessEnv = process.env): GSCEnv {
  const siteUrl = source.GSC_SITE_URL;

  if (!siteUrl) {
    throw new GSCConfigError(
      "Missing required environment variable: GSC_SITE_URL. " +
        "Copy .env.example to .env and set it to your Search Console property first."
    );
  }

  if (!isValidGSCSiteUrl(siteUrl)) {
    throw new GSCConfigError(
      `GSC_SITE_URL "${siteUrl}" is not a valid Search Console property. ` +
        'Use a URL-prefix property (e.g. "https://example.com/") or a Domain property (e.g. "sc-domain:example.com").'
    );
  }

  return { siteUrl };
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Throws GSCDateRangeError if either date isn't ISO YYYY-MM-DD, or start is after end. */
export function assertValidDateRange(start: string, end: string): void {
  if (!isValidIsoDate(start)) {
    throw new GSCDateRangeError(`Invalid --start date "${start}". Use ISO format YYYY-MM-DD.`);
  }
  if (!isValidIsoDate(end)) {
    throw new GSCDateRangeError(`Invalid --end date "${end}". Use ISO format YYYY-MM-DD.`);
  }
  if (start > end) {
    throw new GSCDateRangeError(`--start (${start}) must not be after --end (${end}).`);
  }
}

function isGSCQueryResponse(value: unknown): value is GSCQueryResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.rows !== undefined && candidate.rows !== null && !Array.isArray(candidate.rows)) return false;
  return true;
}

let cachedClient: GSCReportClient | undefined;

/**
 * Lazily constructs the real Search Console API client, authenticated via
 * Application Default Credentials (no service-account JSON, no manual
 * OAuth client loading). Only called when no client is injected — tests
 * always inject a mock and never reach this function.
 */
async function getDefaultClient(): Promise<GSCReportClient> {
  if (!cachedClient) {
    const { google } = await import("googleapis");
    const auth = new google.auth.GoogleAuth({ scopes: [WEBMASTERS_READONLY_SCOPE] });
    const authClient = await auth.getClient();
    const searchconsole = google.searchconsole({ version: "v1", auth: authClient as never });

    cachedClient = {
      query: async (request) => {
        const response = await searchconsole.searchanalytics.query({
          siteUrl: request.siteUrl,
          requestBody: request.requestBody,
        });
        return response.data as GSCQueryResponse;
      },
    };
  }
  return cachedClient;
}

/**
 * Runs one Search Console report to completion, paginating with rowLimit/
 * startRow until a page returns fewer than rowLimit rows (which includes
 * an empty final page). `client` is injectable so tests can mock the
 * Google API instead of hitting it for real. Search Console returns its
 * top rows by relevance/volume within a page, not a guaranteed-complete
 * enumeration of every internal row — this pages through everything the
 * API is willing to return, not necessarily every row that exists.
 */
export async function runGSCReport(
  client: GSCReportClient,
  siteUrl: string,
  spec: GSCReportSpec,
  start: string,
  end: string,
  maxPages: number = MAX_PAGES
): Promise<GSCReportSnapshot> {
  const rows: GSCDataRow[] = [];
  let responseAggregationType: string | null | undefined;
  let metadata: Record<string, unknown> | undefined;
  let startRow = 0;

  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      throw new GSCApiError(
        `Report "${spec.name}" exceeded the pagination safety limit of ${maxPages} pages (${maxPages * ROW_LIMIT} rows).`
      );
    }

    let response: GSCQueryResponse;
    try {
      response = await client.query({
        siteUrl,
        requestBody: {
          startDate: start,
          endDate: end,
          dimensions: spec.dimensions,
          searchType: "web",
          dataState: "all",
          rowLimit: ROW_LIMIT,
          startRow,
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new GSCApiError(`Search Console query ("${spec.name}") failed: ${reason}`);
    }

    if (!isGSCQueryResponse(response)) {
      throw new GSCResponseShapeError(
        `Unexpected Search Console response shape for report "${spec.name}": expected a \`rows\` array.`
      );
    }

    const pageRows = response.rows ?? [];
    rows.push(...pageRows);

    if (responseAggregationType === undefined) {
      responseAggregationType = response.responseAggregationType;
    }
    if (response.metadata) {
      metadata = { ...metadata, ...response.metadata };
    }

    if (pageRows.length < ROW_LIMIT) break;
    startRow += pageRows.length;
  }

  return {
    dimensions: spec.dimensions,
    rows,
    rowCount: rows.length,
    responseAggregationType: responseAggregationType ?? null,
    metadata,
  };
}

/**
 * Runs all four growth reports (daily_overview, queries, query_pages,
 * pages) for the same date range. `client` is injectable for tests; in
 * production it's left undefined and a real client is lazily constructed,
 * authenticating via Application Default Credentials.
 */
export async function collectGSCReports(
  siteUrl: string,
  start: string,
  end: string,
  client?: GSCReportClient
): Promise<GSCReports> {
  assertValidDateRange(start, end);
  const resolvedClient = client ?? (await getDefaultClient());

  const [dailyOverview, queries, queryPages, pages] = await Promise.all([
    runGSCReport(resolvedClient, siteUrl, GSC_REPORTS.dailyOverview, start, end),
    runGSCReport(resolvedClient, siteUrl, GSC_REPORTS.queries, start, end),
    runGSCReport(resolvedClient, siteUrl, GSC_REPORTS.queryPages, start, end),
    runGSCReport(resolvedClient, siteUrl, GSC_REPORTS.pages, start, end),
  ]);

  return { dailyOverview, queries, queryPages, pages };
}
