import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSnapshot,
  defaultDateRange,
  parseArgs,
  resolveOutputPath,
  writeSnapshot,
} from "../scripts/collect-posthog";
import type { PostHogHogQLResponse } from "../types/posthog";

describe("parseArgs", () => {
  it("defaults to no explicit range and overwrite disabled", () => {
    expect(parseArgs([])).toEqual({ overwrite: false });
  });

  it("parses --start, --end, and --overwrite", () => {
    expect(parseArgs(["--start", "2026-07-01", "--end", "2026-07-15", "--overwrite"])).toEqual({
      start: "2026-07-01",
      end: "2026-07-15",
      overwrite: true,
    });
  });

  it("rejects --start without a matching --end", () => {
    expect(() => parseArgs(["--start", "2026-07-01"])).toThrow(/--end/);
  });

  it("rejects --end without a matching --start", () => {
    expect(() => parseArgs(["--end", "2026-07-15"])).toThrow(/--start/);
  });

  it("rejects unrecognized arguments", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unrecognized argument/);
  });
});

describe("defaultDateRange", () => {
  it("returns the last 7 complete calendar days, ending yesterday (UTC)", () => {
    const now = new Date("2026-07-15T09:30:00.000Z");
    expect(defaultDateRange(now)).toEqual({ start: "2026-07-08", end: "2026-07-14" });
  });

  it("never includes today, even right after UTC midnight", () => {
    const now = new Date("2026-07-15T00:00:01.000Z");
    expect(defaultDateRange(now).end).toBe("2026-07-14");
  });
});

describe("resolveOutputPath", () => {
  const period = { start: "2026-07-01", end: "2026-07-15" };

  it("uses the base filename when no snapshot exists yet", () => {
    const path = resolveOutputPath(period, false, () => false);
    expect(path.replace(/\\/g, "/")).toMatch(/growth\/data\/raw\/posthog-2026-07-01_to_2026-07-15\.json$/);
  });

  it("appends a timestamp instead of silently overwriting an existing snapshot", () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const path = resolveOutputPath(period, false, () => true, now);
    expect(path).not.toMatch(/posthog-2026-07-01_to_2026-07-15\.json$/);
    expect(path).toContain("posthog-2026-07-01_to_2026-07-15.");
    expect(path.endsWith(".json")).toBe(true);
  });

  it("reuses the base filename when --overwrite is passed, even if it exists", () => {
    const path = resolveOutputPath(period, true, () => true);
    expect(path.replace(/\\/g, "/")).toMatch(/posthog-2026-07-01_to_2026-07-15\.json$/);
  });
});

describe("buildSnapshot", () => {
  it("wraps the raw PostHog response with collection metadata, untouched", () => {
    const response: PostHogHogQLResponse = {
      results: [["2026-07-01", "$pageview", "", "", "home", "", "", "", "", 10, 8]],
      columns: ["date", "event"],
      types: ["Date", "String"],
      hogql: "SELECT ...",
    };

    const snapshot = buildSnapshot({ start: "2026-07-01", end: "2026-07-15" }, response);

    expect(snapshot.source).toBe("posthog");
    expect(snapshot.period).toEqual({ start: "2026-07-01", end: "2026-07-15" });
    expect(snapshot.queryName).toBeTruthy();
    expect(snapshot.results).toEqual(response.results);
    expect(snapshot.rows).toEqual(response.results);
    expect(snapshot.columns).toEqual(response.columns);
    expect(snapshot.responseMeta).toEqual({ hogql: "SELECT ..." });
    expect(() => new Date(snapshot.collectedAt).toISOString()).not.toThrow();
  });

  it("omits responseMeta when the response has no extra fields", () => {
    const response: PostHogHogQLResponse = { results: [] };
    const snapshot = buildSnapshot({ start: "2026-07-01", end: "2026-07-15" }, response);
    expect(snapshot.responseMeta).toBeUndefined();
  });
});

describe("writeSnapshot", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes the snapshot as formatted JSON to the given path", () => {
    dir = mkdtempSync(join(tmpdir(), "growth-posthog-test-"));
    const path = join(dir, "posthog-2026-07-01_to_2026-07-15.json");
    const snapshot = buildSnapshot({ start: "2026-07-01", end: "2026-07-15" }, { results: [] });

    writeSnapshot(path, snapshot);

    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.source).toBe("posthog");
    expect(written.period).toEqual({ start: "2026-07-01", end: "2026-07-15" });
  });

  it("creates the destination directory if it doesn't exist yet", () => {
    dir = mkdtempSync(join(tmpdir(), "growth-posthog-test-"));
    const path = join(dir, "nested", "posthog-2026-07-01_to_2026-07-15.json");
    const snapshot = buildSnapshot({ start: "2026-07-01", end: "2026-07-15" }, { results: [] });

    writeSnapshot(path, snapshot);

    expect(existsSync(path)).toBe(true);
  });
});
