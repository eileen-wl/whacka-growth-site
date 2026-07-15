import "dotenv/config";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSnapshotPath, writeSnapshotFile } from "../lib/collector-fs";
import {
  GSCApiError,
  GSCConfigError,
  GSCDateRangeError,
  GSCResponseShapeError,
  assertValidDateRange,
  collectGSCReports,
  readGSCEnv,
} from "../collectors/gsc";
import type { DateRange, GSCReports, GSCSnapshot } from "../types/gsc";

const RAW_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "raw");

/** Search Console's date semantics run on the America/Los_Angeles calendar, not UTC. */
const GSC_TIME_ZONE = "America/Los_Angeles";

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

function formatIsoDateInTimeZone(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, matching ISO date order without a locale library.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function addDaysToIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Last 7 complete Search Console calendar days, ending yesterday — both
 * evaluated on the America/Los_Angeles calendar Search Console itself uses,
 * not UTC (see growth/README.md).
 */
export function defaultDateRange(now: Date = new Date()): DateRange {
  const todayInLA = formatIsoDateInTimeZone(now, GSC_TIME_ZONE);
  const end = addDaysToIsoDate(todayInLA, -1);
  const start = addDaysToIsoDate(end, -6);
  return { start, end };
}

/** Same collision convention as every other growth collector script; see growth/lib/collector-fs.ts. */
export function resolveOutputPath(
  period: DateRange,
  overwrite: boolean,
  exists: (path: string) => boolean = existsSync,
  now: Date = new Date()
): string {
  return resolveSnapshotPath(RAW_DATA_DIR, "gsc", period, overwrite, exists, now);
}

export function buildSnapshot(period: DateRange, siteUrl: string, reports: GSCReports): GSCSnapshot {
  return {
    source: "search_console",
    collectedAt: new Date().toISOString(),
    period,
    siteUrl,
    reports,
  };
}

export function writeSnapshot(path: string, snapshot: GSCSnapshot): void {
  writeSnapshotFile(path, snapshot);
}

/** Reports with zero rows aren't an error — just worth a CLI heads-up. */
export function warnOnEmptyReports(reports: GSCReports): string[] {
  const warnings: string[] = [];
  for (const [key, report] of Object.entries(reports)) {
    if (report.rowCount === 0) {
      warnings.push(
        `Report "${key}" returned 0 rows. The property may have no search impressions yet, or recent dates aren't finalized.`
      );
    }
  }
  return warnings;
}

export async function run(argv: string[]): Promise<{ outputPath: string; warnings: string[] }> {
  const args = parseArgs(argv);
  const period = args.start && args.end ? { start: args.start, end: args.end } : defaultDateRange();

  assertValidDateRange(period.start, period.end);

  const env = readGSCEnv();
  const reports = await collectGSCReports(env.siteUrl, period.start, period.end);
  const snapshot = buildSnapshot(period, env.siteUrl, reports);
  const outputPath = resolveOutputPath(period, args.overwrite);

  writeSnapshot(outputPath, snapshot);

  return { outputPath, warnings: warnOnEmptyReports(reports) };
}

async function main(): Promise<void> {
  try {
    const { outputPath, warnings } = await run(process.argv.slice(2));
    for (const warning of warnings) {
      console.warn(`[growth:collect:gsc] ${warning}`);
    }
    console.log(`Saved Search Console growth-report snapshot to ${outputPath}`);
  } catch (err) {
    if (
      err instanceof GSCConfigError ||
      err instanceof GSCDateRangeError ||
      err instanceof GSCApiError ||
      err instanceof GSCResponseShapeError
    ) {
      console.error(`[growth:collect:gsc] ${err.message}`);
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[growth:collect:gsc] Unexpected error: ${reason}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
