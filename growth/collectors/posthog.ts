import {
  AGGREGATE_DIMENSIONS,
  GROWTH_EVENTS,
  type HogQLQueryRequestBody,
  type PostHogEnv,
  type PostHogHogQLResponse,
} from "../types/posthog";

const REQUIRED_ENV_VARS = ["POSTHOG_PERSONAL_API_KEY", "POSTHOG_PROJECT_ID", "POSTHOG_API_HOST"] as const;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class PostHogConfigError extends Error {}
export class PostHogDateRangeError extends Error {}
export class PostHogApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}
export class PostHogResponseShapeError extends Error {}

/**
 * Reads and validates the server-side PostHog env vars. Never returns
 * partial results — throws listing only the missing variable *names*, so
 * callers can't accidentally log a name/value pair that includes the key.
 */
export function readPostHogEnv(source: NodeJS.ProcessEnv = process.env): PostHogEnv {
  const missing = REQUIRED_ENV_VARS.filter((name) => !source[name]);

  if (missing.length > 0) {
    throw new PostHogConfigError(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "Copy .env.example to .env and fill in your PostHog project details first."
    );
  }

  return {
    apiKey: source.POSTHOG_PERSONAL_API_KEY as string,
    projectId: source.POSTHOG_PROJECT_ID as string,
    apiHost: source.POSTHOG_API_HOST as string,
  };
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Throws PostHogDateRangeError if either date isn't ISO YYYY-MM-DD, or start is after end. */
export function assertValidDateRange(start: string, end: string): void {
  if (!isValidIsoDate(start)) {
    throw new PostHogDateRangeError(`Invalid --start date "${start}". Use ISO format YYYY-MM-DD.`);
  }
  if (!isValidIsoDate(end)) {
    throw new PostHogDateRangeError(`Invalid --end date "${end}". Use ISO format YYYY-MM-DD.`);
  }
  if (start > end) {
    throw new PostHogDateRangeError(`--start (${start}) must not be after --end (${end}).`);
  }
}

/**
 * Quotes a string as a HogQL/SQL string literal: wraps it in single quotes
 * and doubles any internal single quote, per standard SQL string escaping.
 * Never use JSON.stringify() for this — JSON's double-quoted strings are
 * parsed by HogQL as field/identifier references, not string literals.
 */
export function quoteHogQLString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Builds the aggregate HogQL query: growth events only, grouped by date and
 * the Growth Data Specification v1 dimensions, counting events and distinct
 * users per group. Date bounds are passed as bound `values` (not interpolated
 * into the query string) so HogQL parameterizes them safely.
 */
export function buildGrowthEventsQuery(start: string, end: string): HogQLQueryRequestBody {
  const dimensions = AGGREGATE_DIMENSIONS.map((dimension) =>
    dimension === "date" || dimension === "event" ? dimension : `properties.${dimension}`
  );

  const eventList = GROWTH_EVENTS.map(quoteHogQLString).join(", ");

  const query = `
SELECT
    toDate(timestamp) AS date,
    event AS event,
    properties.app_slug AS app_slug,
    properties.app_name AS app_name,
    properties.page_type AS page_type,
    properties.utm_source AS utm_source,
    properties.utm_medium AS utm_medium,
    properties.utm_campaign AS utm_campaign,
    properties.utm_content AS utm_content,
    count() AS event_count,
    count(DISTINCT distinct_id) AS unique_users
FROM events
WHERE event IN (${eventList})
    AND toDate(timestamp) >= {start_date}
    AND toDate(timestamp) <= {end_date}
GROUP BY ${dimensions.join(", ")}
ORDER BY date, event
`.trim();

  return {
    query: {
      kind: "HogQLQuery",
      query,
      values: { start_date: start, end_date: end },
    },
  };
}

function isPostHogHogQLResponse(value: unknown): value is PostHogHogQLResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { results?: unknown }).results)
  );
}

/**
 * Runs the aggregate growth-events HogQL query against the PostHog Query
 * API. `fetchImpl` is injectable so tests can mock the network call instead
 * of hitting the real API.
 */
export async function queryPostHog(
  env: PostHogEnv,
  start: string,
  end: string,
  fetchImpl: typeof fetch = fetch
): Promise<PostHogHogQLResponse> {
  assertValidDateRange(start, end);

  const url = `${env.apiHost.replace(/\/+$/, "")}/api/projects/${env.projectId}/query/`;
  const body = buildGrowthEventsQuery(start, end);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PostHogApiError(`Request to PostHog failed: ${reason}`, 0);
  }

  if (!response.ok) {
    // Read the body for diagnostics, but the PostHog API never echoes back
    // the Authorization header/API key in a response, so this is safe to surface.
    const detail = await response.text().catch(() => "");
    throw new PostHogApiError(
      `PostHog API responded with ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
      response.status
    );
  }

  const json: unknown = await response.json();

  if (!isPostHogHogQLResponse(json)) {
    throw new PostHogResponseShapeError(
      "Unexpected PostHog response shape: expected an object with a `results` array."
    );
  }

  return json;
}
