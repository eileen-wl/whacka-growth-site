import { join } from "node:path";

export interface DateRange {
  start: string;
  end: string;
}

export interface SnapshotListDeps {
  listDir: (dir: string) => string[];
  readFile: (path: string) => string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches `{prefix}-{start}_to_{end}.json` and its timestamped collision
 * variants (see growth/lib/collector-fs.ts's `resolveSnapshotPath`). Shared
 * by every script that discovers a dated snapshot for a requested period
 * (normalize-growth-data.ts, generate-growth-report.ts, ...).
 */
export function findMatchingFiles(dir: string, prefix: string, period: DateRange, listDir: SnapshotListDeps["listDir"]): string[] {
  const base = `${prefix}-${period.start}_to_${period.end}`;
  const pattern = new RegExp(`^${escapeRegExp(base)}(\\.[^.]+)?\\.json$`);
  return listDir(dir).filter((name) => pattern.test(name));
}

/**
 * Picks the matching file whose `getTimestamp` value sorts latest (ISO 8601
 * timestamps sort correctly as plain strings). Callers supply the timestamp
 * field to compare on, since different snapshot types use different field
 * names (`collectedAt` for raw collector snapshots, `generatedAt` for
 * processed growth summaries).
 */
export function selectLatestSnapshot<T>(
  dir: string,
  filenames: string[],
  readFile: SnapshotListDeps["readFile"],
  getTimestamp: (snapshot: T) => string
): { filename: string; snapshot: T } | undefined {
  let best: { filename: string; snapshot: T } | undefined;

  for (const filename of filenames) {
    const snapshot = JSON.parse(readFile(join(dir, filename))) as T;
    if (!best || getTimestamp(snapshot) > getTimestamp(best.snapshot)) {
      best = { filename, snapshot };
    }
  }

  return best;
}

export class PeriodMismatchError extends Error {}

/** Throws PeriodMismatchError if a loaded snapshot's own period doesn't match the requested period. */
export function assertPeriodMatches(sourceLabel: string, snapshotPeriod: DateRange, requestedPeriod: DateRange): void {
  if (snapshotPeriod.start !== requestedPeriod.start || snapshotPeriod.end !== requestedPeriod.end) {
    throw new PeriodMismatchError(
      `${sourceLabel} snapshot's period (${snapshotPeriod.start} to ${snapshotPeriod.end}) does not match ` +
        `the requested period (${requestedPeriod.start} to ${requestedPeriod.end}).`
    );
  }
}

export function multipleMatchesNotice(sourceLabel: string, filename: string): string {
  return `Multiple ${sourceLabel} snapshots found for this range; selected "${filename}" (latest timestamp).`;
}
