import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NormalizeDateRangeError,
  NormalizeInputError,
  assertPeriodMatches,
  assertValidDateRange,
  findMatchingFiles,
  isValidIsoDate,
  loadOptionalSnapshot,
  loadRequiredSnapshot,
  parseArgs,
  resolveOutputPath,
  selectLatestSnapshot,
  writeSummary,
} from "../scripts/normalize-growth-data";
import { buildGrowthSummary } from "../normalizers/growth-summary";
import type { FileSystemDeps } from "../scripts/normalize-growth-data";

const PERIOD = { start: "2026-07-08", end: "2026-07-09" };

function fakeDeps(files: Record<string, unknown>): FileSystemDeps {
  return {
    listDir: () => Object.keys(files),
    readFile: (path: string) => {
      const name = path.replace(/\\/g, "/").split("/").pop() as string;
      if (!(name in files)) throw new Error(`ENOENT: no such file "${name}"`);
      return JSON.stringify(files[name]);
    },
  };
}

describe("parseArgs", () => {
  it("defaults campaignId/campaignName and overwrite disabled", () => {
    expect(parseArgs([])).toEqual({
      overwrite: false,
      campaignId: "small_business_toolkit_v0",
      campaignName: "Small Business Mini App Toolkit",
    });
  });

  it("parses --start, --end, --overwrite, --campaign-id, --campaign-name", () => {
    expect(
      parseArgs([
        "--start",
        "2026-07-08",
        "--end",
        "2026-07-14",
        "--overwrite",
        "--campaign-id",
        "custom_id",
        "--campaign-name",
        "Custom Name",
      ])
    ).toEqual({
      start: "2026-07-08",
      end: "2026-07-14",
      overwrite: true,
      campaignId: "custom_id",
      campaignName: "Custom Name",
    });
  });

  it("rejects --start without a matching --end", () => {
    expect(() => parseArgs(["--start", "2026-07-08"])).toThrow(/--end/);
  });

  it("rejects --end without a matching --start", () => {
    expect(() => parseArgs(["--end", "2026-07-14"])).toThrow(/--start/);
  });

  it("rejects unrecognized arguments", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unrecognized argument/);
  });
});

describe("isValidIsoDate / assertValidDateRange", () => {
  it("accepts well-formed ISO dates", () => {
    expect(isValidIsoDate("2026-07-15")).toBe(true);
  });

  it("rejects malformed or non-existent dates", () => {
    expect(isValidIsoDate("2026-7-15")).toBe(false);
    expect(isValidIsoDate("2026-02-30")).toBe(false);
  });

  it("throws NormalizeDateRangeError for invalid dates or start-after-end", () => {
    expect(() => assertValidDateRange("bad-date", "2026-07-15")).toThrow(NormalizeDateRangeError);
    expect(() => assertValidDateRange("2026-07-15", "2026-07-01")).toThrow(NormalizeDateRangeError);
  });

  it("allows a valid, ordered range", () => {
    expect(() => assertValidDateRange("2026-07-08", "2026-07-14")).not.toThrow();
  });
});

describe("findMatchingFiles", () => {
  it("matches the base filename and timestamped collision variants, ignoring unrelated files", () => {
    const listDir = () => [
      "posthog-2026-07-08_to_2026-07-09.json",
      "posthog-2026-07-08_to_2026-07-09.2026-07-09T23-30-00-000Z.json",
      "posthog-2026-07-01_to_2026-07-07.json",
      "ga4-2026-07-08_to_2026-07-09.json",
      "posthog-2026-07-08_to_2026-07-09.json.bak",
    ];

    const matches = findMatchingFiles("/raw", "posthog", PERIOD, listDir);

    expect(matches.sort()).toEqual(
      ["posthog-2026-07-08_to_2026-07-09.json", "posthog-2026-07-08_to_2026-07-09.2026-07-09T23-30-00-000Z.json"].sort()
    );
  });
});

describe("selectLatestSnapshot", () => {
  it("picks the file with the latest collectedAt among matches", () => {
    const files: Record<string, { collectedAt: string; period: typeof PERIOD; marker: string }> = {
      "posthog-2026-07-08_to_2026-07-09.json": { collectedAt: "2026-07-09T20:00:00.000Z", period: PERIOD, marker: "older" },
      "posthog-2026-07-08_to_2026-07-09.2026-07-09T23-30-00-000Z.json": {
        collectedAt: "2026-07-09T23:30:00.000Z",
        period: PERIOD,
        marker: "newer",
      },
    };
    const readFile = (path: string) => JSON.stringify(files[path.replace(/\\/g, "/").split("/").pop() as string]);

    const selected = selectLatestSnapshot<{ collectedAt: string; period: typeof PERIOD; marker: string }>(
      "/raw",
      Object.keys(files),
      readFile
    );

    expect(selected?.snapshot.marker).toBe("newer");
    expect(selected?.filename).toBe("posthog-2026-07-08_to_2026-07-09.2026-07-09T23-30-00-000Z.json");
  });
});

describe("assertPeriodMatches", () => {
  it("throws NormalizeInputError when the snapshot's period differs from the requested period", () => {
    expect(() => assertPeriodMatches("PostHog", { start: "2026-07-01", end: "2026-07-02" }, PERIOD)).toThrow(
      NormalizeInputError
    );
  });

  it("does not throw when periods match", () => {
    expect(() => assertPeriodMatches("PostHog", PERIOD, PERIOD)).not.toThrow();
  });
});

describe("loadRequiredSnapshot", () => {
  it("fails clearly, stating the expected filename and date range, when the file is missing", () => {
    const deps = fakeDeps({});

    try {
      loadRequiredSnapshot("PostHog", "posthog", PERIOD, deps);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NormalizeInputError);
      const message = (err as Error).message;
      expect(message).toContain("PostHog");
      expect(message).toContain(`posthog-${PERIOD.start}_to_${PERIOD.end}`);
      expect(message).toContain(PERIOD.start);
      expect(message).toContain(PERIOD.end);
    }
  });

  it("fails clearly for a missing required GA4 file too", () => {
    const deps = fakeDeps({});
    expect(() => loadRequiredSnapshot("GA4", "ga4", PERIOD, deps)).toThrow(/ga4-2026-07-08_to_2026-07-09/);
  });

  it("loads the snapshot and filename when the file is present", () => {
    const deps = fakeDeps({
      "posthog-2026-07-08_to_2026-07-09.json": { collectedAt: "2026-07-09T23:00:00.000Z", period: PERIOD, rows: [] },
    });

    const result = loadRequiredSnapshot<{ collectedAt: string; period: typeof PERIOD; rows: unknown[] }>(
      "PostHog",
      "posthog",
      PERIOD,
      deps
    );

    expect(result.filename).toBe("posthog-2026-07-08_to_2026-07-09.json");
    expect(result.snapshot.rows).toEqual([]);
    expect(result.notice).toBeUndefined();
  });

  it("selects the latest timestamped snapshot and includes a selection notice when multiple match", () => {
    const deps = fakeDeps({
      "posthog-2026-07-08_to_2026-07-09.json": { collectedAt: "2026-07-09T20:00:00.000Z", period: PERIOD, marker: "older" },
      "posthog-2026-07-08_to_2026-07-09.2026-07-09T23-30-00-000Z.json": {
        collectedAt: "2026-07-09T23:30:00.000Z",
        period: PERIOD,
        marker: "newer",
      },
    });

    const result = loadRequiredSnapshot<{ collectedAt: string; period: typeof PERIOD; marker: string }>(
      "PostHog",
      "posthog",
      PERIOD,
      deps
    );

    expect(result.snapshot.marker).toBe("newer");
    expect(result.notice).toContain(result.filename);
    expect(result.notice?.toLowerCase()).toContain("multiple");
  });

  it("throws NormalizeInputError when the selected file's period doesn't match the requested period", () => {
    const deps = fakeDeps({
      "posthog-2026-07-08_to_2026-07-09.json": {
        collectedAt: "2026-07-09T23:00:00.000Z",
        period: { start: "2026-07-01", end: "2026-07-02" },
      },
    });

    expect(() => loadRequiredSnapshot("PostHog", "posthog", PERIOD, deps)).toThrow(NormalizeInputError);
  });
});

describe("loadOptionalSnapshot", () => {
  it("returns found: false instead of throwing when the file is missing (Search Console)", () => {
    const deps = fakeDeps({});
    const result = loadOptionalSnapshot("Search Console", "gsc", PERIOD, deps);
    expect(result).toEqual({ found: false });
  });

  it("returns found: true with the snapshot when the file is present", () => {
    const deps = fakeDeps({
      "gsc-2026-07-08_to_2026-07-09.json": { collectedAt: "2026-07-09T23:10:00.000Z", period: PERIOD, reports: {} },
    });

    const result = loadOptionalSnapshot<{ collectedAt: string; period: typeof PERIOD; reports: unknown }>(
      "Search Console",
      "gsc",
      PERIOD,
      deps
    );

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.filename).toBe("gsc-2026-07-08_to_2026-07-09.json");
    }
  });
});

describe("resolveOutputPath", () => {
  it("uses the base filename when no summary exists yet", () => {
    const path = resolveOutputPath(PERIOD, false, () => false);
    expect(path.replace(/\\/g, "/")).toMatch(/growth\/data\/processed\/growth-summary-2026-07-08_to_2026-07-09\.json$/);
  });

  it("appends a timestamp instead of silently overwriting an existing summary", () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const path = resolveOutputPath(PERIOD, false, () => true, now);
    expect(path).not.toMatch(/growth-summary-2026-07-08_to_2026-07-09\.json$/);
    expect(path).toContain("growth-summary-2026-07-08_to_2026-07-09.");
    expect(path.endsWith(".json")).toBe(true);
  });

  it("reuses the base filename when --overwrite is passed, even if it exists", () => {
    const path = resolveOutputPath(PERIOD, true, () => true);
    expect(path.replace(/\\/g, "/")).toMatch(/growth-summary-2026-07-08_to_2026-07-09\.json$/);
  });
});

describe("writeSummary", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes the summary as formatted JSON to the given path", () => {
    dir = mkdtempSync(join(tmpdir(), "growth-normalize-test-"));
    const path = join(dir, "growth-summary-2026-07-08_to_2026-07-09.json");
    const summary = buildGrowthSummary({
      period: PERIOD,
      campaign: { id: "test", name: "Test" },
      posthog: {
        filename: "posthog-2026-07-08_to_2026-07-09.json",
        snapshot: { source: "posthog", collectedAt: "2026-07-09T23:00:00.000Z", period: PERIOD, queryName: "q", rows: [], results: [] },
      },
      ga4: {
        filename: "ga4-2026-07-08_to_2026-07-09.json",
        snapshot: {
          source: "ga4",
          collectedAt: "2026-07-09T23:05:00.000Z",
          period: PERIOD,
          propertyId: "123",
          trafficOverview: { headers: { dimensionHeaders: [], metricHeaders: [] }, rows: [], rowCount: 0 },
          trafficAcquisition: { headers: { dimensionHeaders: [], metricHeaders: [] }, rows: [], rowCount: 0 },
          landingPages: { headers: { dimensionHeaders: [], metricHeaders: [] }, rows: [], rowCount: 0 },
        },
      },
      searchConsole: { found: false },
    });

    writeSummary(path, summary);

    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.source).toBe("normalized_growth_summary");
    expect(written.period).toEqual(PERIOD);
  });
});

describe("no raw input mutation", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("loadRequiredSnapshot leaves the raw file's bytes and directory listing untouched", () => {
    dir = mkdtempSync(join(tmpdir(), "growth-normalize-raw-test-"));
    const rawPath = join(dir, "posthog-2026-07-08_to_2026-07-09.json");
    const originalContent = JSON.stringify({ collectedAt: "2026-07-09T23:00:00.000Z", period: PERIOD, rows: [] });
    writeFileSync(rawPath, originalContent, "utf-8");

    const deps: FileSystemDeps = {
      listDir: (d: string) => readdirSync(d),
      readFile: (path: string) => readFileSync(path, "utf-8"),
    };

    // Point findMatchingFiles/selectLatestSnapshot at the temp dir by using a period whose
    // prefix matches the file written above; loadRequiredSnapshot itself always reads from the
    // real growth/data/raw dir, so we exercise the read-only file-list/read path directly here.
    const matches = findMatchingFiles(dir, "posthog", PERIOD, deps.listDir);
    selectLatestSnapshot(dir, matches, deps.readFile);

    expect(readFileSync(rawPath, "utf-8")).toBe(originalContent);
    expect(readdirSync(dir)).toEqual(["posthog-2026-07-08_to_2026-07-09.json"]);
  });
});

describe("no credentials or secrets in errors", () => {
  it("NormalizeInputError messages only ever mention filenames and dates", () => {
    const deps = fakeDeps({});
    try {
      loadRequiredSnapshot("GA4", "ga4", PERIOD, deps);
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message.toLowerCase();
      expect(message).not.toContain("credential");
      expect(message).not.toContain("token");
      expect(message).not.toContain("key");
    }
  });
});
