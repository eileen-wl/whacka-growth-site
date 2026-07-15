/** Server-side PostHog connection settings, read from process.env. Never log/serialize `apiKey`. */
export interface PostHogEnv {
  apiKey: string;
  projectId: string;
  apiHost: string;
}

/** Growth Data Specification v1 events this collector aggregates. See src/lib/tracking.ts. */
export const GROWTH_EVENTS = [
  "$pageview",
  "view_demo_click",
  "remix_click",
  "build_click",
  "copy_prompt_click",
] as const;

export type GrowthEventName = (typeof GROWTH_EVENTS)[number];

/** The dimensions the HogQL query groups aggregate rows by, in column order. */
export const AGGREGATE_DIMENSIONS = [
  "date",
  "event",
  "app_slug",
  "app_name",
  "page_type",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
] as const;

/** The measures the HogQL query computes per aggregate row, in column order. */
export const AGGREGATE_MEASURES = ["event_count", "unique_users"] as const;

/** Full column list of the aggregate query result, in the order HogQL returns them. */
export const AGGREGATE_COLUMNS = [...AGGREGATE_DIMENSIONS, ...AGGREGATE_MEASURES] as const;

export interface HogQLQueryRequestBody {
  query: {
    kind: "HogQLQuery";
    query: string;
    values?: Record<string, string>;
  };
}

/**
 * Shape of a PostHog `/api/projects/:id/query/` response for a HogQLQuery.
 * PostHog returns additional fields beyond these (timings, modifiers, etc.);
 * `[key: string]: unknown` preserves them untouched for the raw snapshot.
 */
export interface PostHogHogQLResponse {
  columns?: unknown[];
  types?: unknown[];
  results: unknown[][];
  hogql?: string;
  hasMore?: boolean;
  [key: string]: unknown;
}

export interface DateRange {
  start: string;
  end: string;
}

/** The on-disk shape written to growth/data/raw/posthog-{start}_to_{end}.json. */
export interface PostHogSnapshot {
  source: "posthog";
  collectedAt: string;
  period: DateRange;
  queryName: string;
  rows: unknown[][];
  results: unknown[][];
  columns?: unknown[];
  types?: unknown[];
  responseMeta?: Record<string, unknown>;
}
