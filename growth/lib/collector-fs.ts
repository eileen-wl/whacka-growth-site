import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface SnapshotPeriod {
  start: string;
  end: string;
}

/**
 * Resolves a collision-safe path for a dated snapshot: `{dir}/{prefix}-{start}_to_{end}.json`,
 * reused as-is unless it already exists, in which case a timestamp suffix is appended (or the
 * base name is reused in place if `overwrite` is true). Shared convention across every growth
 * collector script (PostHog, GA4, Search Console, ...).
 */
export function resolveSnapshotPath(
  dir: string,
  prefix: string,
  period: SnapshotPeriod,
  overwrite: boolean,
  exists: (path: string) => boolean = existsSync,
  now: Date = new Date()
): string {
  const baseName = `${prefix}-${period.start}_to_${period.end}.json`;
  const basePath = join(dir, baseName);

  if (overwrite || !exists(basePath)) {
    return basePath;
  }

  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return join(dir, `${prefix}-${period.start}_to_${period.end}.${timestamp}.json`);
}

/** Writes a snapshot as formatted JSON, creating the destination directory if needed. */
export function writeSnapshotFile(path: string, snapshot: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
}

/**
 * Writes `content` to `path` atomically: writes to a temp file in the same
 * directory, then renames it into place. `rename` is atomic on the same
 * filesystem, so a process crash or failed write mid-way never leaves a
 * truncated/corrupted file at `path` — readers only ever see the old
 * complete file or the new complete file, never a partial one.
 */
export function writeFileAtomic(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(dir, `.tmp-${randomUUID()}-${basename(path)}`);
  writeFileSync(tempPath, content, "utf-8");
  renameSync(tempPath, path);
}
