import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSnapshotPath, writeSnapshotFile } from "../lib/collector-fs";
import { buildGrowthSummary } from "../normalizers/growth-summary";
import type { GA4Snapshot } from "../types/ga4";
import type { GSCSnapshot } from "../types/gsc";
import type { PostHogSnapshot } from "../types/posthog";
import type { CampaignInfo, DateRange, GrowthSummary } from "../types/growth-summary";

const GROWTH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_DATA_DIR = join(GROWTH_DIR, "data", "raw");
const PROCESSED_DATA_DIR = join(GROWTH_DIR, "data", "processed");

const DEFAULT_CAMPAIGN_ID = "small_business_toolkit_v0";
const DEFAULT_CAMPAIGN_NAME = "Small Business Mini App Toolkit";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class NormalizeDateRangeError extends Error {}
export class NormalizeInputError extends Error {}

export interface CollectArgs {
  start?: string;
  end?: string;
  overwrite: boolean;
  campaignId: string;
  campaignName: string;
}

export function parseArgs(argv: string[]): CollectArgs {
  const args: CollectArgs = { overwrite: false, campaignId: DEFAULT_CAMPAIGN_ID, campaignName: DEFAULT_CAMPAIGN_NAME };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--start") {
      args.start = argv[++i];
    } else if (arg === "--end") {
      args.end = argv[++i];
    } else if (arg === "--overwrite") {
      args.overwrite = true;
    } else if (arg === "--campaign-id") {
      args.campaignId = argv[++i];
    } else if (arg === "--campaign-name") {
      args.campaignName = argv[++i];
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

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Throws NormalizeDateRangeError if either date isn't ISO YYYY-MM-DD, or start is after end. */
export function assertValidDateRange(start: string, end: string): void {
  if (!isValidIsoDate(start)) {
    throw new NormalizeDateRangeError(`Invalid --start date "${start}". Use ISO format YYYY-MM-DD.`);
  }
  if (!isValidIsoDate(end)) {
    throw new NormalizeDateRangeError(`Invalid --end date "${end}". Use ISO format YYYY-MM-DD.`);
  }
  if (start > end) {
    throw new NormalizeDateRangeError(`--start (${start}) must not be after --end (${end}).`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface FileSystemDeps {
  listDir: (dir: string) => string[];
  readFile: (path: string) => string;
}

const defaultDeps: FileSystemDeps = {
  listDir: (dir) => readdirSync(dir),
  readFile: (path) => readFileSync(path, "utf-8"),
};

/** Matches `{prefix}-{start}_to_{end}.json` and its timestamped collision variants. */
export function findMatchingFiles(dir: string, prefix: string, period: DateRange, listDir: FileSystemDeps["listDir"]): string[] {
  const base = `${prefix}-${period.start}_to_${period.end}`;
  const pattern = new RegExp(`^${escapeRegExp(base)}(\\.[^.]+)?\\.json$`);
  return listDir(dir).filter((name) => pattern.test(name));
}

interface Dated {
  collectedAt: string;
  period: DateRange;
}

/** Picks the matching file with the latest `collectedAt`, per the "select the most recent snapshot" rule. */
export function selectLatestSnapshot<T extends Dated>(
  dir: string,
  filenames: string[],
  readFile: FileSystemDeps["readFile"]
): { filename: string; snapshot: T } | undefined {
  let best: { filename: string; snapshot: T } | undefined;

  for (const filename of filenames) {
    const snapshot = JSON.parse(readFile(join(dir, filename))) as T;
    if (!best || snapshot.collectedAt > best.snapshot.collectedAt) {
      best = { filename, snapshot };
    }
  }

  return best;
}

export function assertPeriodMatches(sourceLabel: string, snapshotPeriod: DateRange, requestedPeriod: DateRange): void {
  if (snapshotPeriod.start !== requestedPeriod.start || snapshotPeriod.end !== requestedPeriod.end) {
    throw new NormalizeInputError(
      `${sourceLabel} snapshot's period (${snapshotPeriod.start} to ${snapshotPeriod.end}) does not match ` +
        `the requested period (${requestedPeriod.start} to ${requestedPeriod.end}).`
    );
  }
}

interface LoadedSnapshot<T> {
  filename: string;
  snapshot: T;
  /** Set when multiple timestamped snapshots matched and one was picked by latest collectedAt. */
  notice?: string;
}

function multipleMatchesNotice(sourceLabel: string, filename: string): string {
  return `Multiple ${sourceLabel} snapshots found for this range; selected "${filename}" (latest collectedAt).`;
}

/** Loads a required raw snapshot (PostHog/GA4). Throws NormalizeInputError with the expected filename/range if missing. */
export function loadRequiredSnapshot<T extends Dated>(
  sourceLabel: string,
  prefix: string,
  period: DateRange,
  deps: FileSystemDeps = defaultDeps
): LoadedSnapshot<T> {
  const matches = findMatchingFiles(RAW_DATA_DIR, prefix, period, deps.listDir);

  if (matches.length === 0) {
    throw new NormalizeInputError(
      `Missing required ${sourceLabel} raw snapshot for ${period.start} to ${period.end}. Expected a file matching ` +
        `growth/data/raw/${prefix}-${period.start}_to_${period.end}*.json — run the ${sourceLabel} collector for this date range first.`
    );
  }

  const selected = selectLatestSnapshot<T>(RAW_DATA_DIR, matches, deps.readFile);
  if (!selected) {
    throw new NormalizeInputError(`Failed to read any matching ${sourceLabel} snapshot for ${period.start} to ${period.end}.`);
  }

  assertPeriodMatches(sourceLabel, selected.snapshot.period, period);

  return matches.length > 1 ? { ...selected, notice: multipleMatchesNotice(sourceLabel, selected.filename) } : selected;
}

/** Loads an optional raw snapshot (Search Console): returns `{ found: false }` instead of throwing when absent. */
export function loadOptionalSnapshot<T extends Dated>(
  sourceLabel: string,
  prefix: string,
  period: DateRange,
  deps: FileSystemDeps = defaultDeps
): ({ found: true } & LoadedSnapshot<T>) | { found: false } {
  const matches = findMatchingFiles(RAW_DATA_DIR, prefix, period, deps.listDir);
  if (matches.length === 0) return { found: false };

  const selected = selectLatestSnapshot<T>(RAW_DATA_DIR, matches, deps.readFile);
  if (!selected) return { found: false };

  assertPeriodMatches(sourceLabel, selected.snapshot.period, period);

  return matches.length > 1
    ? { found: true, ...selected, notice: multipleMatchesNotice(sourceLabel, selected.filename) }
    : { found: true, ...selected };
}

/** Same collision convention as every collector script; see growth/lib/collector-fs.ts. */
export function resolveOutputPath(
  period: DateRange,
  overwrite: boolean,
  exists?: (path: string) => boolean,
  now?: Date
): string {
  return resolveSnapshotPath(PROCESSED_DATA_DIR, "growth-summary", period, overwrite, exists, now);
}

export function writeSummary(path: string, summary: GrowthSummary): void {
  writeSnapshotFile(path, summary);
}

export interface NormalizeResult {
  outputPath: string;
  summary: GrowthSummary;
  notices: string[];
}

export function run(argv: string[], deps: FileSystemDeps = defaultDeps): NormalizeResult {
  const args = parseArgs(argv);

  if (!args.start || !args.end) {
    throw new Error("growth:normalize requires --start and --end (ISO YYYY-MM-DD) to know which raw snapshots to normalize.");
  }

  const period: DateRange = { start: args.start, end: args.end };
  assertValidDateRange(period.start, period.end);

  const notices: string[] = [];

  const posthog = loadRequiredSnapshot<PostHogSnapshot>("PostHog", "posthog", period, deps);
  if (posthog.notice) notices.push(posthog.notice);

  const ga4 = loadRequiredSnapshot<GA4Snapshot>("GA4", "ga4", period, deps);
  if (ga4.notice) notices.push(ga4.notice);

  const gsc = loadOptionalSnapshot<GSCSnapshot>("Search Console", "gsc", period, deps);
  if (gsc.found && gsc.notice) notices.push(gsc.notice);

  const campaign: CampaignInfo = { id: args.campaignId, name: args.campaignName };

  const summary = buildGrowthSummary({
    period,
    campaign,
    posthog,
    ga4,
    searchConsole: gsc.found ? { found: true, filename: gsc.filename, snapshot: gsc.snapshot } : { found: false },
  });

  const outputPath = resolveOutputPath(period, args.overwrite);
  writeSummary(outputPath, summary);

  return { outputPath, summary, notices };
}

function main(): void {
  try {
    const { outputPath, summary, notices } = run(process.argv.slice(2));

    for (const notice of notices) {
      console.log(`[growth:normalize] ${notice}`);
    }

    console.log(`[growth:normalize] Period: ${summary.period.start} to ${summary.period.end}`);
    console.log(
      `[growth:normalize] Inputs: posthog=${summary.inputs.posthog.filename}, ga4=${summary.inputs.ga4.filename}, ` +
        `searchConsole=${summary.inputs.searchConsole.filename ?? "(none)"}`
    );
    console.log(`[growth:normalize] GA4 sessions: ${summary.traffic.overview.sessions}, GA4 pageviews: ${summary.traffic.overview.screenPageViews}`);
    console.log(
      `[growth:normalize] PostHog pageviews: ${summary.behavior.eventTotals.pageViews}, total CTA clicks: ${summary.behavior.eventTotals.totalCtaClicks}`
    );
    console.log(`[growth:normalize] Search Console clicks: ${summary.search.totals.clicks}, impressions: ${summary.search.totals.impressions}`);
    console.log(`[growth:normalize] Output: ${outputPath}`);
    console.log(
      `[growth:normalize] Data quality: ${summary.dataQuality.overallStatus} (${summary.dataQuality.warnings.length} warning(s))`
    );
  } catch (err) {
    if (err instanceof NormalizeInputError || err instanceof NormalizeDateRangeError) {
      console.error(`[growth:normalize] ${err.message}`);
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[growth:normalize] Unexpected error: ${reason}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}
