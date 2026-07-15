import {
  GA4_REPORTS,
  type GA4Env,
  type GA4ReportClient,
  type GA4Reports,
  type GA4ReportSnapshot,
  type GA4ReportSpec,
  type GA4RunReportRequest,
  type GA4RunReportResponse,
} from "../types/ga4";

const GA4_PROPERTY_ID_PATTERN = /^\d+$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class GA4ConfigError extends Error {}
export class GA4DateRangeError extends Error {}
export class GA4ApiError extends Error {}
export class GA4ResponseShapeError extends Error {}

/**
 * Reads and validates the GA4_PROPERTY_ID env var. GA4 property IDs are
 * numeric-only (e.g. "123456789") — never the "G-XXXXXXX" measurement ID
 * used client-side, so we reject anything containing non-digit characters.
 */
export function readGA4Env(source: NodeJS.ProcessEnv = process.env): GA4Env {
  const propertyId = source.GA4_PROPERTY_ID;

  if (!propertyId) {
    throw new GA4ConfigError(
      "Missing required environment variable: GA4_PROPERTY_ID. " +
        "Copy .env.example to .env and fill in your GA4 property ID first."
    );
  }

  if (!GA4_PROPERTY_ID_PATTERN.test(propertyId)) {
    throw new GA4ConfigError(
      `GA4_PROPERTY_ID must contain digits only (got "${propertyId}"). ` +
        "Use the numeric GA4 property ID from Admin -> Property details, not the G-XXXXXXX measurement ID."
    );
  }

  return { propertyId };
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Throws GA4DateRangeError if either date isn't ISO YYYY-MM-DD, or start is after end. */
export function assertValidDateRange(start: string, end: string): void {
  if (!isValidIsoDate(start)) {
    throw new GA4DateRangeError(`Invalid --start date "${start}". Use ISO format YYYY-MM-DD.`);
  }
  if (!isValidIsoDate(end)) {
    throw new GA4DateRangeError(`Invalid --end date "${end}". Use ISO format YYYY-MM-DD.`);
  }
  if (start > end) {
    throw new GA4DateRangeError(`--start (${start}) must not be after --end (${end}).`);
  }
}

/** Builds the `properties/{id}` resource name GA4's Data API expects. */
export function toPropertyResource(propertyId: string): string {
  return `properties/${propertyId}`;
}

function buildReportRequest(propertyId: string, spec: GA4ReportSpec, start: string, end: string): GA4RunReportRequest {
  return {
    property: toPropertyResource(propertyId),
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: spec.dimensions.map((name) => ({ name })),
    metrics: spec.metrics.map((name) => ({ name })),
  };
}

function isGA4RunReportResponse(value: unknown): value is GA4RunReportResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.rows !== undefined && candidate.rows !== null && !Array.isArray(candidate.rows)) return false;
  if (candidate.dimensionHeaders !== undefined && candidate.dimensionHeaders !== null && !Array.isArray(candidate.dimensionHeaders))
    return false;
  if (candidate.metricHeaders !== undefined && candidate.metricHeaders !== null && !Array.isArray(candidate.metricHeaders))
    return false;
  return true;
}

function toReportSnapshot(response: GA4RunReportResponse): GA4ReportSnapshot {
  const { dimensionHeaders, metricHeaders, rows, rowCount, ...responseMeta } = response;

  const resolvedRows = rows ?? [];

  return {
    headers: {
      dimensionHeaders: (dimensionHeaders ?? []).map((header) => header?.name ?? ""),
      metricHeaders: (metricHeaders ?? []).map((header) => header?.name ?? ""),
    },
    rows: resolvedRows,
    rowCount: rowCount ?? resolvedRows.length,
    responseMeta: Object.keys(responseMeta).length > 0 ? responseMeta : undefined,
  };
}

let cachedClient: GA4ReportClient | undefined;

/**
 * Lazily constructs the real BetaAnalyticsDataClient. Only called when no
 * client is injected (i.e. never during tests, which always inject a mock).
 * The Google client library discovers Application Default Credentials
 * automatically — no service-account JSON or manual OAuth loading here.
 */
async function getDefaultClient(): Promise<GA4ReportClient> {
  if (!cachedClient) {
    const { BetaAnalyticsDataClient } = await import("@google-analytics/data");
    cachedClient = new BetaAnalyticsDataClient() as unknown as GA4ReportClient;
  }
  return cachedClient;
}

/**
 * Runs one GA4 runReport call. `client` is injectable so tests can mock the
 * Google API instead of hitting it for real.
 */
export async function runGA4Report(
  client: GA4ReportClient,
  propertyId: string,
  spec: GA4ReportSpec,
  start: string,
  end: string
): Promise<GA4ReportSnapshot> {
  const request = buildReportRequest(propertyId, spec, start, end);

  let response: GA4RunReportResponse;
  try {
    [response] = await client.runReport(request);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new GA4ApiError(`GA4 runReport ("${spec.name}") failed: ${reason}`);
  }

  if (!isGA4RunReportResponse(response)) {
    throw new GA4ResponseShapeError(
      `Unexpected GA4 response shape for report "${spec.name}": expected dimensionHeaders/metricHeaders/rows arrays.`
    );
  }

  return toReportSnapshot(response);
}

/**
 * Runs all three growth reports (traffic_overview, traffic_acquisition,
 * landing_pages) for the same date range. `client` is injectable for tests;
 * in production it's left undefined and a real BetaAnalyticsDataClient is
 * lazily constructed, authenticating via Application Default Credentials.
 */
export async function collectGA4Reports(
  propertyId: string,
  start: string,
  end: string,
  client?: GA4ReportClient
): Promise<GA4Reports> {
  assertValidDateRange(start, end);
  const resolvedClient = client ?? (await getDefaultClient());

  const [trafficOverview, trafficAcquisition, landingPages] = await Promise.all([
    runGA4Report(resolvedClient, propertyId, GA4_REPORTS.trafficOverview, start, end),
    runGA4Report(resolvedClient, propertyId, GA4_REPORTS.trafficAcquisition, start, end),
    runGA4Report(resolvedClient, propertyId, GA4_REPORTS.landingPages, start, end),
  ]);

  return { trafficOverview, trafficAcquisition, landingPages };
}
