import "dotenv/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GA4ApiError,
  GA4ConfigError,
  GA4DateRangeError,
  GA4ResponseShapeError,
  assertValidDateRange,
  collectGA4Reports,
  readGA4Env,
} from "../collectors/ga4";
import type { DateRange, GA4Reports, GA4Snapshot } from "../types/ga4";

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
 * Resolves the file the snapshot should be written to. Same collision
 * convention as the PostHog collector: never overwrites an existing
 * snapshot silently — reuses the base name only if the file doesn't exist
 * yet or --overwrite was passed, otherwise appends a timestamp.
 */
export function resolveOutputPath(
  period: DateRange,
  overwrite: boolean,
  exists: (path: string) => boolean = existsSync,
  now: Date = new Date()
): string {
  const baseName = `ga4-${period.start}_to_${period.end}.json`;
  const basePath = join(RAW_DATA_DIR, baseName);

  if (overwrite || !exists(basePath)) {
    return basePath;
  }

  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return join(RAW_DATA_DIR, `ga4-${period.start}_to_${period.end}.${timestamp}.json`);
}

export function buildSnapshot(period: DateRange, propertyId: string, reports: GA4Reports): GA4Snapshot {
  return {
    source: "ga4",
    collectedAt: new Date().toISOString(),
    period,
    propertyId,
    trafficOverview: reports.trafficOverview,
    trafficAcquisition: reports.trafficAcquisition,
    landingPages: reports.landingPages,
  };
}

export function writeSnapshot(path: string, snapshot: GA4Snapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
}

export async function run(argv: string[]): Promise<string> {
  const args = parseArgs(argv);
  const period = args.start && args.end ? { start: args.start, end: args.end } : defaultDateRange();

  assertValidDateRange(period.start, period.end);

  const env = readGA4Env();
  const reports = await collectGA4Reports(env.propertyId, period.start, period.end);
  const snapshot = buildSnapshot(period, env.propertyId, reports);
  const outputPath = resolveOutputPath(period, args.overwrite);

  writeSnapshot(outputPath, snapshot);

  return outputPath;
}

async function main(): Promise<void> {
  try {
    const outputPath = await run(process.argv.slice(2));
    console.log(`Saved GA4 growth-report snapshot to ${outputPath}`);
  } catch (err) {
    if (
      err instanceof GA4ConfigError ||
      err instanceof GA4DateRangeError ||
      err instanceof GA4ApiError ||
      err instanceof GA4ResponseShapeError
    ) {
      console.error(`[growth:collect:ga4] ${err.message}`);
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[growth:collect:ga4] Unexpected error: ${reason}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
