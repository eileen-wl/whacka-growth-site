import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../lib/collector-fs";
import { AnthropicGrowthReportProvider } from "../llm/anthropic-provider";
import { MockGrowthReportProvider } from "../llm/mock-provider";
import {
  GrowthReportConfigError,
  GrowthReportDateRangeError,
  GrowthReportInputError,
  assertValidDateRange,
  buildDryRunPreview,
  isValidIsoDate,
  loadGrowthSummary,
  parseArgs,
  readProviderEnv,
  resolvePreviewPath,
  resolveProvider,
  resolveReportJsonPath,
} from "../scripts/generate-growth-report";
import type { FileSystemDeps } from "../scripts/generate-growth-report";
import type { GrowthSummary } from "../types/growth-summary";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureSummary(overrides: Partial<GrowthSummary> = {}): GrowthSummary {
  return {
    schemaVersion: "1.0.0",
    source: "normalized_growth_summary",
    generatedAt: "2026-07-15T00:00:00.000Z",
    period: PERIOD,
    campaign: CAMPAIGN,
    inputs: {
      posthog: { status: "ok", filename: "posthog-2026-07-08_to_2026-07-14.json", collectedAt: "2026-07-14T23:00:00.000Z", rowCount: 10 },
      ga4: { status: "ok", filename: "ga4-2026-07-08_to_2026-07-14.json", collectedAt: "2026-07-14T23:05:00.000Z", reportRowCounts: { trafficOverview: 7, trafficAcquisition: 5, landingPages: 4 } },
      searchConsole: { status: "ok", filename: "gsc-2026-07-08_to_2026-07-14.json", collectedAt: "2026-07-14T23:10:00.000Z", reportRowCounts: { dailyOverview: 7, queries: 10, queryPages: 10, pages: 5 } },
    },
    traffic: {
      overview: { sessions: 100, screenPageViews: 300, engagedSessions: 60, engagementRate: 0.6, activeUsers: null, activeUsersMeasurementNote: "note" },
      acquisition: [],
      landingPages: [],
      topSources: [],
      topLandingPages: [],
    },
    behavior: {
      eventTotals: { pageViews: 300, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, totalCtaClicks: 50 },
      uniqueUsers: null,
      uniqueUsersMeasurementNote: "note",
      byApp: [],
      byPageType: [],
      byUtmSource: [],
      byUtmMedium: [],
      byUtmCampaign: [],
      byUtmContent: [],
    },
    search: {
      status: "ok",
      totals: { clicks: 20, impressions: 500, ctr: 0.04, averagePosition: 8.5 },
      daily: [],
      topQueries: [],
      topPages: [],
      queryPages: [],
    },
    funnel: { growthSite: { pageViews: 300, totalCtaClicks: 50, eventBasedCtaRate: 50 / 300, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, measurementBasis: "PostHog event counts" } },
    productConversions: { signups: null, firstAppCreated: null, appPublished: null, status: "not_connected", note: "Whacka product-side attribution has not been connected yet." },
    dataQuality: { overallStatus: "partial", dateRangeMatch: true, missingSources: [], emptySources: [], warnings: ["warning A"], measurementNotes: ["note A"] },
    ...overrides,
  };
}

function fakeDeps(files: Record<string, unknown>): FileSystemDeps {
  return {
    listDir: () => Object.keys(files),
    readFile: (path: string) => {
      const name = path.replace(/\\/g, "/").split("/").pop() as string;
      if (!(name in files)) throw new Error(`ENOENT: no such file "${name}"`);
      const value = files[name];
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    exists: (path: string) => {
      const name = path.replace(/\\/g, "/").split("/").pop() as string;
      return name in files;
    },
  };
}

describe("parseArgs", () => {
  it("defaults language to en and overwrite/dryRun to false", () => {
    expect(parseArgs(["--start", "2026-07-08", "--end", "2026-07-14"])).toEqual({
      start: "2026-07-08",
      end: "2026-07-14",
      language: "en",
      overwrite: false,
      dryRun: false,
    });
  });

  it("parses --input, --language, --provider, --overwrite, --dry-run", () => {
    const args = parseArgs([
      "--start",
      "2026-07-08",
      "--end",
      "2026-07-14",
      "--input",
      "custom-summary.json",
      "--language",
      "zh-CN",
      "--provider",
      "mock",
      "--overwrite",
      "--dry-run",
    ]);
    expect(args).toEqual({
      start: "2026-07-08",
      end: "2026-07-14",
      input: "custom-summary.json",
      language: "zh-CN",
      provider: "mock",
      overwrite: true,
      dryRun: true,
    });
  });

  it("rejects an unsupported --language value", () => {
    expect(() => parseArgs(["--start", "2026-07-08", "--end", "2026-07-14", "--language", "fr"])).toThrow(/Unsupported --language/);
  });

  it("requires --start and --end even when --input is given", () => {
    expect(() => parseArgs(["--input", "custom-summary.json"])).toThrow(/requires --start and --end/);
  });

  it("rejects --start without --end and vice versa", () => {
    expect(() => parseArgs(["--start", "2026-07-08"])).toThrow(/--end/);
    expect(() => parseArgs(["--end", "2026-07-14"])).toThrow(/--start/);
  });

  it("rejects unrecognized arguments", () => {
    expect(() => parseArgs(["--start", "2026-07-08", "--end", "2026-07-14", "--bogus"])).toThrow(/Unrecognized argument/);
  });
});

describe("isValidIsoDate / assertValidDateRange", () => {
  it("accepts well-formed ISO dates and rejects malformed ones", () => {
    expect(isValidIsoDate("2026-07-15")).toBe(true);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
  });

  it("throws GrowthReportDateRangeError for invalid dates or start-after-end", () => {
    expect(() => assertValidDateRange("bad", "2026-07-14")).toThrow(GrowthReportDateRangeError);
    expect(() => assertValidDateRange("2026-07-14", "2026-07-08")).toThrow(GrowthReportDateRangeError);
  });
});

describe("readProviderEnv", () => {
  it("defaults GROWTH_REPORT_MAX_TOKENS to 6000 when unset", () => {
    expect(readProviderEnv({} as NodeJS.ProcessEnv).maxTokens).toBe(6000);
  });

  it("reads all four environment variables", () => {
    const env = readProviderEnv({
      GROWTH_REPORT_LLM_PROVIDER: "anthropic",
      GROWTH_REPORT_MODEL: "claude-test",
      GROWTH_REPORT_MAX_TOKENS: "8000",
      ANTHROPIC_API_KEY: "sk-ant-test",
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({ provider: "anthropic", model: "claude-test", maxTokens: 8000, apiKey: "sk-ant-test" });
  });

  it("falls back to the default when GROWTH_REPORT_MAX_TOKENS is not a valid positive number", () => {
    expect(readProviderEnv({ GROWTH_REPORT_MAX_TOKENS: "not-a-number" } as NodeJS.ProcessEnv).maxTokens).toBe(6000);
    expect(readProviderEnv({ GROWTH_REPORT_MAX_TOKENS: "-5" } as NodeJS.ProcessEnv).maxTokens).toBe(6000);
  });
});

describe("resolveProvider", () => {
  it("throws GrowthReportConfigError when no provider is configured", () => {
    expect(() => resolveProvider({ language: "en", overwrite: false, dryRun: false }, { provider: undefined, model: undefined, maxTokens: 6000, apiKey: undefined })).toThrow(
      GrowthReportConfigError
    );
  });

  it("returns a MockGrowthReportProvider for 'mock'", () => {
    const provider = resolveProvider(
      { language: "en", overwrite: false, dryRun: false, provider: "mock" },
      { provider: undefined, model: undefined, maxTokens: 6000, apiKey: undefined }
    );
    expect(provider).toBeInstanceOf(MockGrowthReportProvider);
  });

  it("--provider overrides the environment provider", () => {
    const provider = resolveProvider(
      { language: "en", overwrite: false, dryRun: false, provider: "mock" },
      { provider: "anthropic", model: undefined, maxTokens: 6000, apiKey: undefined }
    );
    expect(provider).toBeInstanceOf(MockGrowthReportProvider);
  });

  it("throws GrowthReportConfigError for anthropic without an API key", () => {
    expect(() =>
      resolveProvider({ language: "en", overwrite: false, dryRun: false }, { provider: "anthropic", model: "claude-test", maxTokens: 6000, apiKey: undefined })
    ).toThrow(GrowthReportConfigError);
  });

  it("throws GrowthReportConfigError for anthropic without a model", () => {
    expect(() =>
      resolveProvider({ language: "en", overwrite: false, dryRun: false }, { provider: "anthropic", model: undefined, maxTokens: 6000, apiKey: "sk-ant-test" })
    ).toThrow(GrowthReportConfigError);
  });

  it("returns an AnthropicGrowthReportProvider when both API key and model are set", () => {
    const provider = resolveProvider(
      { language: "en", overwrite: false, dryRun: false },
      { provider: "anthropic", model: "claude-test", maxTokens: 6000, apiKey: "sk-ant-test" }
    );
    expect(provider).toBeInstanceOf(AnthropicGrowthReportProvider);
  });

  it("throws GrowthReportConfigError for an unknown provider name", () => {
    expect(() =>
      resolveProvider({ language: "en", overwrite: false, dryRun: false, provider: "openai" }, { provider: undefined, model: undefined, maxTokens: 6000, apiKey: undefined })
    ).toThrow(GrowthReportConfigError);
  });
});

describe("loadGrowthSummary", () => {
  it("loads a valid discovered growth summary", () => {
    const deps = fakeDeps({ "growth-summary-2026-07-08_to_2026-07-14.json": fixtureSummary() });
    const result = loadGrowthSummary({ language: "en", overwrite: false, dryRun: false }, PERIOD, deps);
    expect(result.filename).toBe("growth-summary-2026-07-08_to_2026-07-14.json");
    expect(result.summary.period).toEqual(PERIOD);
  });

  it("fails clearly, naming the expected filename and range, when no summary is found", () => {
    const deps = fakeDeps({});
    try {
      loadGrowthSummary({ language: "en", overwrite: false, dryRun: false }, PERIOD, deps);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GrowthReportInputError);
      const message = (err as Error).message;
      expect(message).toContain(`growth-summary-${PERIOD.start}_to_${PERIOD.end}`);
      expect(message).toContain("growth:normalize");
    }
  });

  it("rejects invalid JSON", () => {
    const deps = fakeDeps({ "growth-summary-2026-07-08_to_2026-07-14.json": "{not valid json" });
    expect(() => loadGrowthSummary({ language: "en", overwrite: false, dryRun: false }, PERIOD, deps)).toThrow(GrowthReportInputError);
  });

  it("rejects a file that doesn't match the growth-summary schema", () => {
    const deps = fakeDeps({ "growth-summary-2026-07-08_to_2026-07-14.json": { foo: "bar" } });
    expect(() => loadGrowthSummary({ language: "en", overwrite: false, dryRun: false }, PERIOD, deps)).toThrow(GrowthReportInputError);
  });

  it("rejects a summary whose period does not match the requested period", () => {
    const deps = fakeDeps({
      "growth-summary-2026-07-08_to_2026-07-14.json": fixtureSummary({ period: { start: "2026-07-01", end: "2026-07-02" } }),
    });
    expect(() => loadGrowthSummary({ language: "en", overwrite: false, dryRun: false }, PERIOD, deps)).toThrow(GrowthReportInputError);
  });

  it("accepts a 'partial' data-quality status", () => {
    const deps = fakeDeps({
      "growth-summary-2026-07-08_to_2026-07-14.json": fixtureSummary({
        dataQuality: { overallStatus: "partial", dateRangeMatch: true, missingSources: [], emptySources: [], warnings: [], measurementNotes: [] },
      }),
    });
    expect(() => loadGrowthSummary({ language: "en", overwrite: false, dryRun: false }, PERIOD, deps)).not.toThrow();
  });

  it("rejects an 'invalid' data-quality status", () => {
    const deps = fakeDeps({
      "growth-summary-2026-07-08_to_2026-07-14.json": fixtureSummary({
        dataQuality: { overallStatus: "invalid", dateRangeMatch: false, missingSources: [], emptySources: [], warnings: [], measurementNotes: [] },
      }),
    });
    expect(() => loadGrowthSummary({ language: "en", overwrite: false, dryRun: false }, PERIOD, deps)).toThrow(GrowthReportInputError);
  });

  it("selects the latest-generatedAt summary and reports a notice when multiple timestamped files match", () => {
    const deps = fakeDeps({
      "growth-summary-2026-07-08_to_2026-07-14.json": fixtureSummary({ generatedAt: "2026-07-15T00:00:00.000Z" }),
      "growth-summary-2026-07-08_to_2026-07-14.2026-07-15T10-00-00-000Z.json": fixtureSummary({ generatedAt: "2026-07-15T10:00:00.000Z" }),
    });
    const result = loadGrowthSummary({ language: "en", overwrite: false, dryRun: false }, PERIOD, deps);
    expect(result.filename).toBe("growth-summary-2026-07-08_to_2026-07-14.2026-07-15T10-00-00-000Z.json");
    expect(result.notice).toContain(result.filename);
  });

  it("uses exactly the --input file, bypassing discovery, but still validates its period and schema", () => {
    const deps = fakeDeps({ "custom-summary.json": fixtureSummary() });
    const result = loadGrowthSummary({ language: "en", overwrite: false, dryRun: false, input: "custom-summary.json" }, PERIOD, deps);
    expect(result.filename).toBe("custom-summary.json");
    expect(result.notice).toBeUndefined();
  });

  it("--input still rejects a period mismatch", () => {
    const deps = fakeDeps({ "custom-summary.json": fixtureSummary({ period: { start: "2026-07-01", end: "2026-07-02" } }) });
    expect(() => loadGrowthSummary({ language: "en", overwrite: false, dryRun: false, input: "custom-summary.json" }, PERIOD, deps)).toThrow(
      GrowthReportInputError
    );
  });
});

describe("resolvePreviewPath / resolveReportJsonPath — collision-safe filenames", () => {
  it("uses the base filename when absent", () => {
    const path = resolvePreviewPath(PERIOD, false, () => false);
    expect(path.replace(/\\/g, "/")).toMatch(/growth-report-request-2026-07-08_to_2026-07-14\.json$/);
  });

  it("appends a timestamp instead of overwriting an existing preview", () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const path = resolvePreviewPath(PERIOD, false, () => true, now);
    expect(path).not.toMatch(/growth-report-request-2026-07-08_to_2026-07-14\.json$/);
  });

  it("reuses the base filename with --overwrite", () => {
    const path = resolvePreviewPath(PERIOD, true, () => true);
    expect(path.replace(/\\/g, "/")).toMatch(/growth-report-request-2026-07-08_to_2026-07-14\.json$/);
  });

  it("resolveReportJsonPath follows the same convention under growth/reports/", () => {
    const path = resolveReportJsonPath(PERIOD, false, () => false);
    expect(path.replace(/\\/g, "/")).toMatch(/growth\/reports\/growth-report-2026-07-08_to_2026-07-14\.json$/);
  });
});

describe("buildDryRunPreview", () => {
  it("requires no key and no model (defaults intendedModel to not_configured)", () => {
    const preview = buildDryRunPreview({
      summary: fixtureSummary(),
      summaryFilename: "growth-summary-2026-07-08_to_2026-07-14.json",
      summaryContent: JSON.stringify(fixtureSummary()),
      language: "en",
      intendedProvider: "not_configured",
      intendedModel: undefined,
      maxTokens: 6000,
      createdAt: "2026-07-16T00:00:00.000Z",
    });

    expect(preview.intendedModel).toBe("not_configured");
    expect(preview.intendedProvider).toBe("not_configured");
    expect(preview.source).toBe("growth_report_dry_run");
    expect(preview.createdAt).toBe("2026-07-16T00:00:00.000Z");
    expect(preview.period).toEqual(PERIOD);
    expect(preview.evidenceCatalog.length).toBeGreaterThan(0);
    expect(preview.systemPrompt).toContain("evidence-grounded growth reporting analyst");
    expect(preview.userPrompt).toContain("Test Campaign");
  });

  it("computes a stable sha256 of the source summary content", () => {
    const content = JSON.stringify(fixtureSummary());
    const preview1 = buildDryRunPreview({
      summary: fixtureSummary(),
      summaryFilename: "f.json",
      summaryContent: content,
      language: "en",
      intendedProvider: "mock",
      intendedModel: undefined,
      maxTokens: 6000,
    });
    const preview2 = buildDryRunPreview({
      summary: fixtureSummary(),
      summaryFilename: "f.json",
      summaryContent: content,
      language: "en",
      intendedProvider: "mock",
      intendedModel: undefined,
      maxTokens: 6000,
    });
    expect(preview1.sourceSummarySha256).toBe(preview2.sourceSummarySha256);
    expect(preview1.sourceSummarySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never includes an API key, environment dump, or credential path", () => {
    const preview = buildDryRunPreview({
      summary: fixtureSummary(),
      summaryFilename: "growth-summary-2026-07-08_to_2026-07-14.json",
      summaryContent: JSON.stringify(fixtureSummary()),
      language: "en",
      intendedProvider: "anthropic",
      intendedModel: "claude-test-model",
      maxTokens: 6000,
    });
    const serialized = JSON.stringify(preview).toLowerCase();
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("anthropic_api_key");
    expect(serialized).not.toContain("sk-ant");
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain(":\\users\\");
  });
});

describe("writeFileAtomic — atomic write behavior", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes the file and leaves no temp file behind", () => {
    dir = mkdtempSync(join(tmpdir(), "growth-report-test-"));
    const path = join(dir, "output.json");

    writeFileAtomic(path, '{"a":1}\n');

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe('{"a":1}\n');
    const remaining = readdirSync(dir);
    expect(remaining).toEqual(["output.json"]);
  });

  it("creates the destination directory if needed", () => {
    dir = mkdtempSync(join(tmpdir(), "growth-report-test-"));
    const path = join(dir, "nested", "output.json");

    writeFileAtomic(path, "content");

    expect(existsSync(path)).toBe(true);
  });

  it("replaces existing content atomically on a second write", () => {
    dir = mkdtempSync(join(tmpdir(), "growth-report-test-"));
    const path = join(dir, "output.json");

    writeFileAtomic(path, "first");
    writeFileAtomic(path, "second");

    expect(readFileSync(path, "utf-8")).toBe("second");
    expect(readdirSync(dir)).toEqual(["output.json"]);
  });
});
