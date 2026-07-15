import "dotenv/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PostHogApiError,
  PostHogConfigError,
  PostHogDateRangeError,
  PostHogResponseShapeError,
  assertValidDateRange,
  queryPostHog,
  readPostHogEnv,
} from "../collectors/posthog";
import type { DateRange, PostHogHogQLResponse, PostHogSnapshot } from "../types/posthog";

const QUERY_NAME = "growth_events_aggregate_v1";
const RAW_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "raw");

export interface CollectArgs {
  start?: string;
  end?: string;
  overwrite: boolean;
}

export function parseArgs(argv: string[]): CollectArgs {
  const args: CollectArgs = { overwrite: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--start") {
      args.start = argv[++i];
    } else if (arg === "--end") {
      args.end = argv[++i];
    } else if (arg === "--overwrite") {
      args.overwrite = true;
    } else {
      throw new Error(`Unrecognized argument "${arg}".`);
    }
  }

  if (args.start && !args.end) {
    throw new Error("--start was given without --end. Both are required together.");
  }
  if (args.end && !args.start) {
    throw new Error("--end was given without --start. Both are required together.");
  }

  return args;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Last 7 complete calendar days (UTC), ending yesterday — today is never "complete". */
export function defaultDateRange(now: Date = new Date()): DateRange {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { start: toIsoDate(start), end: toIsoDate(end) };
}

/**
 * Resolves the file the snapshot should be written to. Never overwrites an
 * existing snapshot silently: reuses the base name only if the file doesn't
 * exist yet or --overwrite was passed; otherwise appends a timestamp so the
 * prior snapshot is preserved.
 */
export function resolveOutputPath(
  period: DateRange,
  overwrite: boolean,
  exists: (path: string) => boolean = existsSync,
  now: Date = new Date()
): string {
  const baseName = `posthog-${period.start}_to_${period.end}.json`;
  const basePath = join(RAW_DATA_DIR, baseName);

  if (overwrite || !exists(basePath)) {
    return basePath;
  }

  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return join(RAW_DATA_DIR, `posthog-${period.start}_to_${period.end}.${timestamp}.json`);
}

export function buildSnapshot(period: DateRange, response: PostHogHogQLResponse): PostHogSnapshot {
  const { results, columns, types, ...responseMeta } = response;

  return {
    source: "posthog",
    collectedAt: new Date().toISOString(),
    period,
    queryName: QUERY_NAME,
    rows: results,
    results,
    columns,
    types,
    responseMeta: Object.keys(responseMeta).length > 0 ? responseMeta : undefined,
  };
}

export function writeSnapshot(path: string, snapshot: PostHogSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
}

export async function run(argv: string[]): Promise<string> {
  const args = parseArgs(argv);
  const period = args.start && args.end ? { start: args.start, end: args.end } : defaultDateRange();

  assertValidDateRange(period.start, period.end);

  const env = readPostHogEnv();
  const response = await queryPostHog(env, period.start, period.end);
  const snapshot = buildSnapshot(period, response);
  const outputPath = resolveOutputPath(period, args.overwrite);

  writeSnapshot(outputPath, snapshot);

  return outputPath;
}

async function main(): Promise<void> {
  try {
    const outputPath = await run(process.argv.slice(2));
    console.log(`Saved PostHog growth-events snapshot to ${outputPath}`);
  } catch (err) {
    if (
      err instanceof PostHogConfigError ||
      err instanceof PostHogDateRangeError ||
      err instanceof PostHogApiError ||
      err instanceof PostHogResponseShapeError
    ) {
      console.error(`[growth:collect:posthog] ${err.message}`);
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[growth:collect:posthog] Unexpected error: ${reason}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
