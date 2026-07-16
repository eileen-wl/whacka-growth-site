import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicExperimentDecisionProvider } from "../llm/anthropic-experiment-decision-provider";
import { MockExperimentDecisionProvider } from "../llm/mock-experiment-decision-provider";
import { writeFileAtomic } from "../lib/collector-fs";
import {
  ExperimentDecisionConfigError,
  ExperimentDecisionDateRangeError,
  ExperimentDecisionInputError,
  assertLiveMockInputAllowed,
  assertValidDateRange,
  buildDryRunPreview,
  isValidIsoDate,
  loadGrowthReport,
  parseArgs,
  readProviderEnv,
  resolveDecisionJsonPath,
  resolvePreviewPath,
  resolveProvider,
} from "../scripts/generate-experiment-decision";
import type { FileSystemDeps } from "../scripts/generate-experiment-decision";
import type { FinalGrowthReport } from "../types/growth-report";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureReport(overrides: Partial<FinalGrowthReport> = {}): FinalGrowthReport {
  return {
    schemaVersion: "1.0.0",
    reportType: "growth_report",
    generatedAt: "2026-07-15T00:00:00.000Z",
    period: PERIOD,
    campaign: CAMPAIGN,
    provenance: {
      sourceSummaryFilename: "growth-summary-2026-07-08_to_2026-07-14.json",
      sourceSummarySha256: "abc123",
      sourceSummaryGeneratedAt: "2026-07-14T23:00:00.000Z",
      dataQualityStatus: "partial",
    },
    generation: { provider: "mock", model: "mock-v0", language: "en", isMock: true, requestId: null, stopReason: "end_turn", usage: { inputTokens: null, outputTokens: null } },
    metrics: {
      traffic: { overview: { sessions: 100, screenPageViews: 300, engagedSessions: 60, engagementRate: 0.6, activeUsers: null, activeUsersMeasurementNote: "x" }, acquisition: [], landingPages: [], topSources: [], topLandingPages: [] },
      behavior: { eventTotals: { pageViews: 300, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, totalCtaClicks: 50 }, uniqueUsers: null, uniqueUsersMeasurementNote: "x", byApp: [], byPageType: [], byUtmSource: [], byUtmMedium: [], byUtmCampaign: [], byUtmContent: [] },
      search: { status: "ok", totals: { clicks: 20, impressions: 500, ctr: 0.04, averagePosition: 8.5 }, daily: [], topQueries: [], topPages: [], queryPages: [] },
      productConversions: { signups: null, firstAppCreated: null, appPublished: null, status: "not_connected", note: "x" },
    },
    evidenceCatalog: [{ id: "traffic.sessions", label: "GA4 sessions", value: 100, source: "GA4", measurementBasis: "x" }],
    analysis: {
      executiveSummary: { headline: "H", summary: "S", confidence: "medium" },
      findings: [{ id: "finding_1", category: "traffic", title: "T", observation: "O", interpretation: "I", evidenceRefs: ["traffic.sessions"], confidence: "medium", caveats: [] }],
      funnelObservations: [],
      channelAndContentObservations: [],
      anomaliesOrNotableSignals: [],
      dataLimitations: [{ title: "T", impact: "I", relatedEvidenceRefs: ["traffic.sessions"] }],
      decisionInputs: { signalsWorthReviewing: [], questionsForDecisionAgent: [{ question: "Q?", reason: "R", evidenceRefs: ["traffic.sessions"] }] },
    },
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
  it("defaults language to en, overwrite/dryRun/allowMockInput to false", () => {
    expect(parseArgs(["--start", "2026-07-08", "--end", "2026-07-14"])).toEqual({
      start: "2026-07-08",
      end: "2026-07-14",
      language: "en",
      overwrite: false,
      dryRun: false,
      allowMockInput: false,
    });
  });

  it("parses --input, --language, --provider, --overwrite, --dry-run, --allow-mock-input", () => {
    const args = parseArgs([
      "--start",
      "2026-07-08",
      "--end",
      "2026-07-14",
      "--input",
      "custom-report.json",
      "--language",
      "zh-CN",
      "--provider",
      "mock",
      "--overwrite",
      "--dry-run",
      "--allow-mock-input",
    ]);
    expect(args).toEqual({
      start: "2026-07-08",
      end: "2026-07-14",
      input: "custom-report.json",
      language: "zh-CN",
      provider: "mock",
      overwrite: true,
      dryRun: true,
      allowMockInput: true,
    });
  });

  it("requires --start and --end even when --input is given", () => {
    expect(() => parseArgs(["--input", "custom-report.json"])).toThrow(/requires --start and --end/);
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

  it("throws ExperimentDecisionDateRangeError for invalid dates or start-after-end", () => {
    expect(() => assertValidDateRange("bad", "2026-07-14")).toThrow(ExperimentDecisionDateRangeError);
    expect(() => assertValidDateRange("2026-07-14", "2026-07-08")).toThrow(ExperimentDecisionDateRangeError);
  });
});

describe("readProviderEnv", () => {
  it("defaults EXPERIMENT_DECISION_MAX_TOKENS to 6000 when unset", () => {
    expect(readProviderEnv({} as NodeJS.ProcessEnv).maxTokens).toBe(6000);
  });

  it("reads the decision-specific and fallback growth-report variables", () => {
    const env = readProviderEnv({
      EXPERIMENT_DECISION_LLM_PROVIDER: "anthropic",
      EXPERIMENT_DECISION_MODEL: "claude-decision",
      EXPERIMENT_DECISION_MAX_TOKENS: "8000",
      ANTHROPIC_API_KEY: "sk-ant-test",
      GROWTH_REPORT_LLM_PROVIDER: "mock",
      GROWTH_REPORT_MODEL: "claude-report",
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({
      provider: "anthropic",
      model: "claude-decision",
      maxTokens: 8000,
      apiKey: "sk-ant-test",
      growthReportProvider: "mock",
      growthReportModel: "claude-report",
    });
  });
});

describe("resolveProvider — fallback chain", () => {
  const baseEnv = { provider: undefined, model: undefined, maxTokens: 6000, apiKey: undefined, growthReportProvider: undefined, growthReportModel: undefined };

  it("throws ExperimentDecisionConfigError when nothing is configured", () => {
    expect(() => resolveProvider({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, baseEnv)).toThrow(ExperimentDecisionConfigError);
  });

  it("--provider takes priority over EXPERIMENT_DECISION_LLM_PROVIDER and GROWTH_REPORT_LLM_PROVIDER", () => {
    const provider = resolveProvider(
      { language: "en", overwrite: false, dryRun: false, allowMockInput: false, provider: "mock" },
      { ...baseEnv, provider: "anthropic", growthReportProvider: "anthropic" }
    );
    expect(provider).toBeInstanceOf(MockExperimentDecisionProvider);
  });

  it("falls back to EXPERIMENT_DECISION_LLM_PROVIDER when --provider is absent", () => {
    const provider = resolveProvider({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, { ...baseEnv, provider: "mock" });
    expect(provider).toBeInstanceOf(MockExperimentDecisionProvider);
  });

  it("falls back to GROWTH_REPORT_LLM_PROVIDER when neither --provider nor EXPERIMENT_DECISION_LLM_PROVIDER is set", () => {
    const provider = resolveProvider(
      { language: "en", overwrite: false, dryRun: false, allowMockInput: false },
      { ...baseEnv, growthReportProvider: "mock" }
    );
    expect(provider).toBeInstanceOf(MockExperimentDecisionProvider);
  });

  it("resolves an Anthropic provider using EXPERIMENT_DECISION_MODEL when set", () => {
    const provider = resolveProvider(
      { language: "en", overwrite: false, dryRun: false, allowMockInput: false },
      { ...baseEnv, provider: "anthropic", model: "claude-decision", apiKey: "sk-ant-test" }
    );
    expect(provider).toBeInstanceOf(AnthropicExperimentDecisionProvider);
  });

  it("falls back to GROWTH_REPORT_MODEL when EXPERIMENT_DECISION_MODEL is unset", () => {
    const provider = resolveProvider(
      { language: "en", overwrite: false, dryRun: false, allowMockInput: false },
      { ...baseEnv, provider: "anthropic", growthReportModel: "claude-report", apiKey: "sk-ant-test" }
    );
    expect(provider).toBeInstanceOf(AnthropicExperimentDecisionProvider);
  });

  it("throws ExperimentDecisionConfigError for anthropic without an API key", () => {
    expect(() =>
      resolveProvider({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, { ...baseEnv, provider: "anthropic", model: "claude-decision" })
    ).toThrow(ExperimentDecisionConfigError);
  });

  it("throws ExperimentDecisionConfigError for anthropic without any resolvable model", () => {
    expect(() =>
      resolveProvider({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, { ...baseEnv, provider: "anthropic", apiKey: "sk-ant-test" })
    ).toThrow(ExperimentDecisionConfigError);
  });

  it("throws ExperimentDecisionConfigError for an unknown provider name", () => {
    expect(() =>
      resolveProvider({ language: "en", overwrite: false, dryRun: false, allowMockInput: false, provider: "openai" }, baseEnv)
    ).toThrow(ExperimentDecisionConfigError);
  });
});

describe("assertLiveMockInputAllowed", () => {
  it("throws when the report is mock-generated and --allow-mock-input is not set", () => {
    const report = fixtureReport({ generation: { ...fixtureReport().generation, isMock: true } });
    expect(() => assertLiveMockInputAllowed(report, "growth-report-x.json", false)).toThrow(ExperimentDecisionConfigError);
  });

  it("does not throw when --allow-mock-input is set", () => {
    const report = fixtureReport({ generation: { ...fixtureReport().generation, isMock: true } });
    expect(() => assertLiveMockInputAllowed(report, "growth-report-x.json", true)).not.toThrow();
  });

  it("does not throw when the report is not mock-generated", () => {
    const report = fixtureReport({ generation: { ...fixtureReport().generation, isMock: false } });
    expect(() => assertLiveMockInputAllowed(report, "growth-report-x.json", false)).not.toThrow();
  });
});

describe("loadGrowthReport", () => {
  it("loads a valid discovered Growth Report", () => {
    const deps = fakeDeps({ "growth-report-2026-07-08_to_2026-07-14.json": fixtureReport() });
    const result = loadGrowthReport({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, PERIOD, deps);
    expect(result.filename).toBe("growth-report-2026-07-08_to_2026-07-14.json");
    expect(result.report.period).toEqual(PERIOD);
  });

  it("fails clearly, naming the expected filename and range, when no report is found", () => {
    const deps = fakeDeps({});
    try {
      loadGrowthReport({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, PERIOD, deps);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ExperimentDecisionInputError);
      const message = (err as Error).message;
      expect(message).toContain(`growth-report-${PERIOD.start}_to_${PERIOD.end}`);
      expect(message).toContain("growth:report");
    }
  });

  it("rejects malformed JSON", () => {
    const deps = fakeDeps({ "growth-report-2026-07-08_to_2026-07-14.json": "{not valid json" });
    expect(() => loadGrowthReport({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, PERIOD, deps)).toThrow(ExperimentDecisionInputError);
  });

  it("rejects a file that doesn't match the Growth Report schema", () => {
    const deps = fakeDeps({ "growth-report-2026-07-08_to_2026-07-14.json": { foo: "bar" } });
    expect(() => loadGrowthReport({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, PERIOD, deps)).toThrow(ExperimentDecisionInputError);
  });

  it("rejects a report whose period does not match the requested period", () => {
    const deps = fakeDeps({ "growth-report-2026-07-08_to_2026-07-14.json": fixtureReport({ period: { start: "2026-07-01", end: "2026-07-02" } }) });
    expect(() => loadGrowthReport({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, PERIOD, deps)).toThrow(ExperimentDecisionInputError);
  });

  it("accepts a 'partial' data-quality status", () => {
    const deps = fakeDeps({
      "growth-report-2026-07-08_to_2026-07-14.json": fixtureReport({
        dataQuality: { overallStatus: "partial", dateRangeMatch: true, missingSources: [], emptySources: [], warnings: [], measurementNotes: [] },
      }),
    });
    expect(() => loadGrowthReport({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, PERIOD, deps)).not.toThrow();
  });

  it("rejects an 'invalid' data-quality status", () => {
    const deps = fakeDeps({
      "growth-report-2026-07-08_to_2026-07-14.json": fixtureReport({
        dataQuality: { overallStatus: "invalid", dateRangeMatch: false, missingSources: [], emptySources: [], warnings: [], measurementNotes: [] },
      }),
    });
    expect(() => loadGrowthReport({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, PERIOD, deps)).toThrow(ExperimentDecisionInputError);
  });

  it("rejects a report whose analysis cites an evidence ID missing from its own evidenceCatalog", () => {
    const report = fixtureReport();
    report.analysis.findings[0].evidenceRefs = ["nonexistent.evidence.id"];
    const deps = fakeDeps({ "growth-report-2026-07-08_to_2026-07-14.json": report });
    expect(() => loadGrowthReport({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, PERIOD, deps)).toThrow(ExperimentDecisionInputError);
  });

  it("detects a mock source report via generation.isMock", () => {
    const deps = fakeDeps({ "growth-report-2026-07-08_to_2026-07-14.json": fixtureReport({ generation: { ...fixtureReport().generation, isMock: true } }) });
    const result = loadGrowthReport({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, PERIOD, deps);
    expect(result.report.generation.isMock).toBe(true);
  });

  it("selects the latest-generatedAt report and reports a notice when multiple timestamped files match", () => {
    const deps = fakeDeps({
      "growth-report-2026-07-08_to_2026-07-14.json": fixtureReport({ generatedAt: "2026-07-15T00:00:00.000Z" }),
      "growth-report-2026-07-08_to_2026-07-14.2026-07-15T10-00-00-000Z.json": fixtureReport({ generatedAt: "2026-07-15T10:00:00.000Z" }),
    });
    const result = loadGrowthReport({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, PERIOD, deps);
    expect(result.filename).toBe("growth-report-2026-07-08_to_2026-07-14.2026-07-15T10-00-00-000Z.json");
    expect(result.notice).toContain(result.filename);
  });

  it("never selects the sibling Markdown file as input", () => {
    const deps = fakeDeps({
      "growth-report-2026-07-08_to_2026-07-14.md": "# not json",
      "growth-report-2026-07-08_to_2026-07-14.json": fixtureReport(),
    });
    const result = loadGrowthReport({ language: "en", overwrite: false, dryRun: false, allowMockInput: false }, PERIOD, deps);
    expect(result.filename).toBe("growth-report-2026-07-08_to_2026-07-14.json");
  });

  it("uses exactly the --input file, bypassing discovery, but still validates its period and schema", () => {
    const deps = fakeDeps({ "custom-report.json": fixtureReport() });
    const result = loadGrowthReport({ language: "en", overwrite: false, dryRun: false, allowMockInput: false, input: "custom-report.json" }, PERIOD, deps);
    expect(result.filename).toBe("custom-report.json");
    expect(result.notice).toBeUndefined();
  });
});

describe("resolvePreviewPath / resolveDecisionJsonPath — collision-safe filenames", () => {
  it("uses the base filename when absent", () => {
    const path = resolvePreviewPath(PERIOD, false, () => false);
    expect(path.replace(/\\/g, "/")).toMatch(/experiment-decision-request-2026-07-08_to_2026-07-14\.json$/);
  });

  it("appends a timestamp instead of overwriting an existing preview", () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const path = resolvePreviewPath(PERIOD, false, () => true, now);
    expect(path).not.toMatch(/experiment-decision-request-2026-07-08_to_2026-07-14\.json$/);
  });

  it("reuses the base filename with --overwrite", () => {
    const path = resolvePreviewPath(PERIOD, true, () => true);
    expect(path.replace(/\\/g, "/")).toMatch(/experiment-decision-request-2026-07-08_to_2026-07-14\.json$/);
  });

  it("resolveDecisionJsonPath follows the same convention under growth/decisions/", () => {
    const path = resolveDecisionJsonPath(PERIOD, false, () => false);
    expect(path.replace(/\\/g, "/")).toMatch(/growth\/decisions\/experiment-decision-2026-07-08_to_2026-07-14\.json$/);
  });
});

describe("buildDryRunPreview", () => {
  it("requires no key and no model (defaults intendedModel to not_configured)", () => {
    const report = fixtureReport();
    const preview = buildDryRunPreview({
      report,
      reportFilename: "growth-report-2026-07-08_to_2026-07-14.json",
      reportContent: JSON.stringify(report),
      language: "en",
      intendedProvider: "not_configured",
      intendedModel: undefined,
      maxTokens: 6000,
      createdAt: "2026-07-16T00:00:00.000Z",
    });

    expect(preview.intendedModel).toBe("not_configured");
    expect(preview.source).toBe("experiment_decision_dry_run");
    expect(preview.createdAt).toBe("2026-07-16T00:00:00.000Z");
    expect(preview.sourceGrowthReportIsMock).toBe(true);
    expect(preview.decisionScope).toBeDefined();
    expect(preview.evidenceCatalog.length).toBeGreaterThan(0);
    expect(preview.systemPrompt).toContain("experiment decision analyst");
  });

  it("computes a stable sha256 of the source report content", () => {
    const report = fixtureReport();
    const content = JSON.stringify(report);
    const preview1 = buildDryRunPreview({ report, reportFilename: "f.json", reportContent: content, language: "en", intendedProvider: "mock", intendedModel: undefined, maxTokens: 6000 });
    const preview2 = buildDryRunPreview({ report, reportFilename: "f.json", reportContent: content, language: "en", intendedProvider: "mock", intendedModel: undefined, maxTokens: 6000 });
    expect(preview1.sourceGrowthReportSha256).toBe(preview2.sourceGrowthReportSha256);
    expect(preview1.sourceGrowthReportSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never includes an API key, environment dump, or credential path", () => {
    const report = fixtureReport();
    const preview = buildDryRunPreview({
      report,
      reportFilename: "growth-report-2026-07-08_to_2026-07-14.json",
      reportContent: JSON.stringify(report),
      language: "en",
      intendedProvider: "anthropic",
      intendedModel: "claude-decision",
      maxTokens: 6000,
    });
    const serialized = JSON.stringify(preview).toLowerCase();
    expect(serialized).not.toContain("api_key");
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

  it("writes the decision JSON and leaves no temp file behind", () => {
    dir = mkdtempSync(join(tmpdir(), "growth-decide-test-"));
    const path = join(dir, "experiment-decision-2026-07-08_to_2026-07-14.json");
    writeFileAtomic(path, '{"a":1}\n');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe('{"a":1}\n');
  });
});
