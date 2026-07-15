import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSnapshot,
  defaultDateRange,
  parseArgs,
  resolveOutputPath,
  warnOnEmptyReports,
  writeSnapshot,
} from "../scripts/collect-gsc";
import type { GSCReports, GSCReportSnapshot } from "../types/gsc";

function fakeReportSnapshot(overrides: Partial<GSCReportSnapshot> = {}): GSCReportSnapshot {
  return {
    dimensions: ["date"],
    rows: [{ keys: ["2026-07-01"], clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 }],
    rowCount: 1,
    responseAggregationType: "auto",
    ...overrides,
  };
}

function fakeReports(overrides: Partial<GSCReports> = {}): GSCReports {
  return {
    dailyOverview: fakeReportSnapshot(),
    queries: fakeReportSnapshot({ dimensions: ["query"] }),
    queryPages: fakeReportSnapshot({ dimensions: ["query", "page"] }),
    pages: fakeReportSnapshot({ dimensions: ["page"] }),
    ...overrides,
  };
}

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
  it("returns the last 7 complete calendar days ending yesterday, on the America/Los_Angeles calendar", () => {
    // 2026-07-15T09:30:00Z is still 2026-07-15 in LA (PDT, UTC-7) -> today=07-15, end=07-14.
    const now = new Date("2026-07-15T09:30:00.000Z");
    expect(defaultDateRange(now)).toEqual({ start: "2026-07-08", end: "2026-07-14" });
  });

  it("uses the LA calendar date, not the UTC calendar date, near UTC midnight", () => {
    // 2026-07-15T03:00:00Z is 2026-07-14T20:00 in LA (PDT, UTC-7) -> LA "today" is still 07-14,
    // so end (yesterday in LA) is 07-13 — a UTC-based calculation would wrongly give 07-14.
    const now = new Date("2026-07-15T03:00:00.000Z");
    expect(defaultDateRange(now)).toEqual({ start: "2026-07-07", end: "2026-07-13" });
  });
});

describe("resolveOutputPath", () => {
  const period = { start: "2026-07-01", end: "2026-07-15" };

  it("uses the base filename when no snapshot exists yet", () => {
    const path = resolveOutputPath(period, false, () => false);
    expect(path.replace(/\\/g, "/")).toMatch(/growth\/data\/raw\/gsc-2026-07-01_to_2026-07-15\.json$/);
  });

  it("appends a timestamp instead of silently overwriting an existing snapshot", () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const path = resolveOutputPath(period, false, () => true, now);
    expect(path).not.toMatch(/gsc-2026-07-01_to_2026-07-15\.json$/);
    expect(path).toContain("gsc-2026-07-01_to_2026-07-15.");
    expect(path.endsWith(".json")).toBe(true);
  });

  it("reuses the base filename when --overwrite is passed, even if it exists", () => {
    const path = resolveOutputPath(period, true, () => true);
    expect(path.replace(/\\/g, "/")).toMatch(/gsc-2026-07-01_to_2026-07-15\.json$/);
  });
});

describe("buildSnapshot", () => {
  it("wraps the four reports with collection metadata", () => {
    const reports = fakeReports();
    const snapshot = buildSnapshot({ start: "2026-07-01", end: "2026-07-15" }, "sc-domain:example.com", reports);

    expect(snapshot.source).toBe("search_console");
    expect(snapshot.siteUrl).toBe("sc-domain:example.com");
    expect(snapshot.period).toEqual({ start: "2026-07-01", end: "2026-07-15" });
    expect(snapshot.reports.dailyOverview).toEqual(reports.dailyOverview);
    expect(snapshot.reports.queries).toEqual(reports.queries);
    expect(snapshot.reports.queryPages).toEqual(reports.queryPages);
    expect(snapshot.reports.pages).toEqual(reports.pages);
    expect(() => new Date(snapshot.collectedAt).toISOString()).not.toThrow();
  });

  it("never includes OAuth tokens or credentials (there are none to leak)", () => {
    const snapshot = buildSnapshot({ start: "2026-07-01", end: "2026-07-15" }, "sc-domain:example.com", fakeReports());
    const serialized = JSON.stringify(snapshot).toLowerCase();
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("refresh_token");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("bearer");
  });
});

describe("warnOnEmptyReports", () => {
  it("returns no warnings when every report has rows", () => {
    expect(warnOnEmptyReports(fakeReports())).toEqual([]);
  });

  it("accepts and warns about empty reports instead of treating them as errors", () => {
    const reports = fakeReports({ queries: fakeReportSnapshot({ rows: [], rowCount: 0 }) });

    const warnings = warnOnEmptyReports(reports);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("queries");
    expect(warnings[0]).toContain("0 rows");
  });

  it("warns once per empty report when multiple are empty", () => {
    const reports = fakeReports({
      queries: fakeReportSnapshot({ rows: [], rowCount: 0 }),
      pages: fakeReportSnapshot({ rows: [], rowCount: 0 }),
    });

    expect(warnOnEmptyReports(reports)).toHaveLength(2);
  });
});

describe("writeSnapshot", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes the snapshot as formatted JSON to the given path", () => {
    dir = mkdtempSync(join(tmpdir(), "growth-gsc-test-"));
    const path = join(dir, "gsc-2026-07-01_to_2026-07-15.json");
    const snapshot = buildSnapshot({ start: "2026-07-01", end: "2026-07-15" }, "sc-domain:example.com", fakeReports());

    writeSnapshot(path, snapshot);

    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.source).toBe("search_console");
    expect(written.siteUrl).toBe("sc-domain:example.com");
    expect(written.reports.dailyOverview.rowCount).toBe(1);
  });

  it("creates the destination directory if it doesn't exist yet", () => {
    dir = mkdtempSync(join(tmpdir(), "growth-gsc-test-"));
    const path = join(dir, "nested", "gsc-2026-07-01_to_2026-07-15.json");
    const snapshot = buildSnapshot({ start: "2026-07-01", end: "2026-07-15" }, "sc-domain:example.com", fakeReports());

    writeSnapshot(path, snapshot);

    expect(existsSync(path)).toBe(true);
  });
});
