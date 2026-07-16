import { describe, expect, it } from "vitest";
import { AnthropicSignalMiningProvider } from "../llm/anthropic-signal-mining-provider";
import { MockSignalMiningProvider } from "../llm/mock-signal-mining-provider";
import { ManualInputValidationError } from "../signal-sources/manual-json-signal-adapter";
import { GrowthLoopFeedbackValidationError } from "../contracts/loop-feedback";
import {
  SignalMiningConfigError,
  SignalMiningDateRangeError,
  SignalMiningInputError,
  assertLiveMockFeedbackAllowed,
  assertValidDateRange,
  isValidIsoDate,
  loadGrowthLoopFeedback,
  loadGrowthSummary,
  loadManualInput,
  parseArgs,
  readProviderEnv,
  resolvePreviewPath,
  resolveProvider,
  resolveRunJsonPath,
  run,
} from "../scripts/run-signal-mining";
import type { FileSystemDeps } from "../scripts/run-signal-mining";
import type { GrowthSummary } from "../types/growth-summary";
import type { GrowthLoopFeedback } from "../contracts/loop-feedback";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureSummary(overrides: Partial<GrowthSummary> = {}): GrowthSummary {
  return {
    schemaVersion: "1.0.0",
    source: "normalized_growth_summary",
    generatedAt: "2026-07-15T00:00:00.000Z",
    period: PERIOD,
    campaign: CAMPAIGN,
    inputs: { posthog: { status: "ok" }, ga4: { status: "ok" }, searchConsole: { status: "ok" } },
    traffic: {
      overview: { sessions: 100, screenPageViews: 300, engagedSessions: 60, engagementRate: 0.6, activeUsers: null, activeUsersMeasurementNote: "x" },
      acquisition: [],
      landingPages: [],
      topSources: [{ source: "google", medium: "organic", campaign: "(not set)", sessions: 80, engagedSessions: 50, engagementRate: 0.625 }],
      topLandingPages: [],
    },
    behavior: {
      eventTotals: { pageViews: 300, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, totalCtaClicks: 50 },
      uniqueUsers: null,
      uniqueUsersMeasurementNote: "x",
      byApp: [{ appSlug: "orderly", appName: "Orderly", pageViews: 100, viewDemoClicks: 10, remixClicks: 5, buildClicks: 5, copyPromptClicks: 2, totalCtaClicks: 22, eventBasedCtaRate: 0.22 }],
      byPageType: [],
      byUtmSource: [],
      byUtmMedium: [],
      byUtmCampaign: [],
      byUtmContent: [],
    },
    search: { status: "ok", totals: { clicks: 20, impressions: 500, ctr: 0.04, averagePosition: 8.5 }, daily: [], topQueries: [{ query: "inventory tracker", clicks: 12, impressions: 200, ctr: 0.06, position: 6.2 }], topPages: [], queryPages: [] },
    funnel: { growthSite: { pageViews: 300, totalCtaClicks: 50, eventBasedCtaRate: 50 / 300, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, measurementBasis: "PostHog event counts" } },
    productConversions: { signups: null, firstAppCreated: null, appPublished: null, status: "not_connected", note: "x" },
    dataQuality: { overallStatus: "partial", dateRangeMatch: true, missingSources: [], emptySources: [], warnings: [], measurementNotes: [] },
    ...overrides,
  };
}

function fixtureFeedback(overrides: Partial<GrowthLoopFeedback> = {}): GrowthLoopFeedback {
  return {
    schemaVersion: "1.0.0",
    id: "loopfeedback_abc",
    createdAt: "2026-07-15T00:00:00.000Z",
    campaignId: CAMPAIGN.id,
    sourceDecision: { filename: "experiment-decision-x.json", sha256: "hash", generatedAt: "2026-07-15T00:00:00.000Z", decisionStatus: "defer", isMock: false },
    feedbackType: "collect_more_data",
    instructions: [{ destination: "signal_mining", instruction: "Collect more data.", topicOrApp: null, ctaType: null, channel: null, evidenceRefs: [], findingRefs: [], limitationRefs: [] }],
    constraints: { allowedTopics: [], allowedCtaTypes: [], allowedChannels: [], mustCollectEvidence: true, mustNotClaim: [] },
    humanReview: { required: true, approved: false, approvedBy: null, approvedAt: null },
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

  it("parses --summary, --feedback, --manual-input, --language, --provider, --overwrite, --dry-run, --allow-mock-input", () => {
    const args = parseArgs([
      "--start", "2026-07-08", "--end", "2026-07-14",
      "--summary", "custom-summary.json",
      "--feedback", "custom-feedback.json",
      "--manual-input", "manual.json",
      "--language", "zh-CN",
      "--provider", "mock",
      "--overwrite",
      "--dry-run",
      "--allow-mock-input",
    ]);
    expect(args).toEqual({
      start: "2026-07-08",
      end: "2026-07-14",
      summary: "custom-summary.json",
      feedback: "custom-feedback.json",
      manualInput: "manual.json",
      language: "zh-CN",
      provider: "mock",
      overwrite: true,
      dryRun: true,
      allowMockInput: true,
    });
  });

  it("requires --start and --end even when --summary is given", () => {
    expect(() => parseArgs(["--summary", "custom.json"])).toThrow(/requires --start and --end/);
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

  it("throws SignalMiningDateRangeError for invalid dates or start-after-end", () => {
    expect(() => assertValidDateRange("bad", "2026-07-14")).toThrow(SignalMiningDateRangeError);
    expect(() => assertValidDateRange("2026-07-14", "2026-07-08")).toThrow(SignalMiningDateRangeError);
  });
});

describe("readProviderEnv", () => {
  it("defaults SIGNAL_MINING_MAX_TOKENS to 8000 and SIGNAL_MINING_MAX_SOURCE_RECORDS to 100 when unset", () => {
    const env = readProviderEnv({} as NodeJS.ProcessEnv);
    expect(env.maxTokens).toBe(8000);
    expect(env.maxSourceRecords).toBe(100);
  });

  it("reads the signal-mining-specific and fallback growth-report variables", () => {
    const env = readProviderEnv({
      SIGNAL_MINING_LLM_PROVIDER: "anthropic",
      SIGNAL_MINING_MODEL: "claude-signals",
      SIGNAL_MINING_MAX_TOKENS: "9000",
      SIGNAL_MINING_MAX_SOURCE_RECORDS: "50",
      ANTHROPIC_API_KEY: "sk-ant-test",
      GROWTH_REPORT_LLM_PROVIDER: "mock",
      GROWTH_REPORT_MODEL: "claude-report",
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({
      provider: "anthropic",
      model: "claude-signals",
      maxTokens: 9000,
      maxSourceRecords: 50,
      apiKey: "sk-ant-test",
      growthReportProvider: "mock",
      growthReportModel: "claude-report",
    });
  });
});

describe("resolveProvider — fallback chain", () => {
  const baseEnv = { provider: undefined, model: undefined, maxTokens: 8000, maxSourceRecords: 100, apiKey: undefined, growthReportProvider: undefined, growthReportModel: undefined };
  const baseArgs = { language: "en" as const, overwrite: false, dryRun: false, allowMockInput: false };

  it("throws SignalMiningConfigError when nothing is configured", () => {
    expect(() => resolveProvider(baseArgs, baseEnv)).toThrow(SignalMiningConfigError);
  });

  it("--provider takes priority over SIGNAL_MINING_LLM_PROVIDER and GROWTH_REPORT_LLM_PROVIDER", () => {
    const provider = resolveProvider({ ...baseArgs, provider: "mock" }, { ...baseEnv, provider: "anthropic", growthReportProvider: "anthropic" });
    expect(provider).toBeInstanceOf(MockSignalMiningProvider);
  });

  it("falls back to SIGNAL_MINING_LLM_PROVIDER, then GROWTH_REPORT_LLM_PROVIDER", () => {
    expect(resolveProvider(baseArgs, { ...baseEnv, provider: "mock" })).toBeInstanceOf(MockSignalMiningProvider);
    expect(resolveProvider(baseArgs, { ...baseEnv, growthReportProvider: "mock" })).toBeInstanceOf(MockSignalMiningProvider);
  });

  it("resolves an Anthropic provider, falling back to GROWTH_REPORT_MODEL when SIGNAL_MINING_MODEL is unset", () => {
    const provider = resolveProvider(baseArgs, { ...baseEnv, provider: "anthropic", growthReportModel: "claude-report", apiKey: "sk-ant-test" });
    expect(provider).toBeInstanceOf(AnthropicSignalMiningProvider);
  });

  it("throws SignalMiningConfigError for anthropic without an API key or model", () => {
    expect(() => resolveProvider(baseArgs, { ...baseEnv, provider: "anthropic", model: "m" })).toThrow(SignalMiningConfigError);
    expect(() => resolveProvider(baseArgs, { ...baseEnv, provider: "anthropic", apiKey: "sk-ant-test" })).toThrow(SignalMiningConfigError);
  });

  it("throws SignalMiningConfigError for an unknown provider name", () => {
    expect(() => resolveProvider({ ...baseArgs, provider: "openai" }, baseEnv)).toThrow(SignalMiningConfigError);
  });
});

describe("loadGrowthSummary", () => {
  const args = { language: "en" as const, overwrite: false, dryRun: false, allowMockInput: false };

  it("loads a valid discovered growth summary", () => {
    const deps = fakeDeps({ "growth-summary-2026-07-08_to_2026-07-14.json": fixtureSummary() });
    const result = loadGrowthSummary(args, PERIOD, deps);
    expect(result.filename).toBe("growth-summary-2026-07-08_to_2026-07-14.json");
  });

  it("fails clearly when no summary is found", () => {
    expect(() => loadGrowthSummary(args, PERIOD, fakeDeps({}))).toThrow(SignalMiningInputError);
  });

  it("rejects malformed JSON", () => {
    expect(() => loadGrowthSummary(args, PERIOD, fakeDeps({ "growth-summary-2026-07-08_to_2026-07-14.json": "{not json" }))).toThrow(SignalMiningInputError);
  });

  it("rejects an 'invalid' data-quality status", () => {
    const deps = fakeDeps({ "growth-summary-2026-07-08_to_2026-07-14.json": fixtureSummary({ dataQuality: { overallStatus: "invalid", dateRangeMatch: false, missingSources: [], emptySources: [], warnings: [], measurementNotes: [] } }) });
    expect(() => loadGrowthSummary(args, PERIOD, deps)).toThrow(SignalMiningInputError);
  });

  it("rejects a summary whose period does not match the requested period", () => {
    const deps = fakeDeps({ "growth-summary-2026-07-08_to_2026-07-14.json": fixtureSummary({ period: { start: "2026-06-01", end: "2026-06-07" } }) });
    expect(() => loadGrowthSummary(args, PERIOD, deps)).toThrow(SignalMiningInputError);
  });

  it("uses exactly --summary, bypassing discovery", () => {
    const deps = fakeDeps({ "custom-summary.json": fixtureSummary() });
    const result = loadGrowthSummary({ ...args, summary: "custom-summary.json" }, PERIOD, deps);
    expect(result.filename).toBe("custom-summary.json");
  });
});

describe("loadGrowthLoopFeedback", () => {
  const args = { language: "en" as const, overwrite: false, dryRun: false, allowMockInput: false };

  it("continues without feedback (non-fatal notice) when none is found", () => {
    const result = loadGrowthLoopFeedback(args, PERIOD, fakeDeps({}));
    expect(result.feedback).toBeNull();
    expect(result.notice).toBeDefined();
  });

  it("loads and validates an explicit --feedback file", () => {
    const deps = fakeDeps({ "custom-feedback.json": fixtureFeedback() });
    const result = loadGrowthLoopFeedback({ ...args, feedback: "custom-feedback.json" }, PERIOD, deps);
    expect(result.feedback?.id).toBe("loopfeedback_abc");
  });

  it("rejects an explicit --feedback file that fails contract validation", () => {
    const deps = fakeDeps({ "custom-feedback.json": { not: "valid" } });
    expect(() => loadGrowthLoopFeedback({ ...args, feedback: "custom-feedback.json" }, PERIOD, deps)).toThrow(GrowthLoopFeedbackValidationError);
  });

  it("discovers a matching growth-loop-feedback file when --feedback is absent", () => {
    const deps = fakeDeps({ "growth-loop-feedback-2026-07-08_to_2026-07-14.json": fixtureFeedback() });
    const result = loadGrowthLoopFeedback(args, PERIOD, deps);
    expect(result.feedback?.id).toBe("loopfeedback_abc");
  });

  it("detects mock-generated feedback via sourceDecision.isMock", () => {
    const deps = fakeDeps({ "custom-feedback.json": fixtureFeedback({ sourceDecision: { ...fixtureFeedback().sourceDecision, isMock: true } }) });
    const result = loadGrowthLoopFeedback({ ...args, feedback: "custom-feedback.json" }, PERIOD, deps);
    expect(result.feedback?.sourceDecision.isMock).toBe(true);
  });
});

describe("assertLiveMockFeedbackAllowed", () => {
  it("throws when feedback is mock and --allow-mock-input is not set", () => {
    expect(() => assertLiveMockFeedbackAllowed(fixtureFeedback({ sourceDecision: { ...fixtureFeedback().sourceDecision, isMock: true } }), false)).toThrow(SignalMiningConfigError);
  });

  it("does not throw when --allow-mock-input is set", () => {
    expect(() => assertLiveMockFeedbackAllowed(fixtureFeedback({ sourceDecision: { ...fixtureFeedback().sourceDecision, isMock: true } }), true)).not.toThrow();
  });

  it("does not throw when there is no feedback at all", () => {
    expect(() => assertLiveMockFeedbackAllowed(null, false)).not.toThrow();
  });
});

describe("loadManualInput", () => {
  const args = { language: "en" as const, overwrite: false, dryRun: false, allowMockInput: false };

  it("returns an empty record list when --manual-input is absent", () => {
    const result = loadManualInput(args, fakeDeps({}));
    expect(result.filename).toBeNull();
    expect(result.records).toEqual([]);
  });

  it("loads and validates records from --manual-input", () => {
    const deps = fakeDeps({ "manual.json": { records: [{ sourceType: "mentor_input", sourceName: "Mentor", title: "T", text: "Text." }] } });
    const result = loadManualInput({ ...args, manualInput: "manual.json" }, deps);
    expect(result.records).toHaveLength(1);
    expect(result.filename).toBe("manual.json");
  });

  it("rejects invalid manual input records", () => {
    const deps = fakeDeps({ "manual.json": { records: [{ sourceType: "mentor_input" }] } });
    expect(() => loadManualInput({ ...args, manualInput: "manual.json" }, deps)).toThrow(ManualInputValidationError);
  });

  it("rejects malformed JSON", () => {
    const deps = fakeDeps({ "manual.json": "{not json" });
    expect(() => loadManualInput({ ...args, manualInput: "manual.json" }, deps)).toThrow(ManualInputValidationError);
  });
});

describe("resolvePreviewPath / resolveRunJsonPath — collision-safe filenames", () => {
  it("uses the base filename when absent, and follows the signal-mining naming convention", () => {
    const previewPath = resolvePreviewPath(PERIOD, false, () => false);
    expect(previewPath.replace(/\\/g, "/")).toMatch(/signal-mining-request-2026-07-08_to_2026-07-14\.json$/);

    const runPath = resolveRunJsonPath(PERIOD, false, () => false);
    expect(runPath.replace(/\\/g, "/")).toMatch(/growth\/signals\/signal-mining-2026-07-08_to_2026-07-14\.json$/);
  });

  it("appends a timestamp instead of overwriting an existing file", () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const path = resolveRunJsonPath(PERIOD, false, () => true, now);
    expect(path).not.toMatch(/signal-mining-2026-07-08_to_2026-07-14\.json$/);
  });

  it("reuses the base filename with --overwrite", () => {
    const path = resolveRunJsonPath(PERIOD, true, () => true);
    expect(path.replace(/\\/g, "/")).toMatch(/signal-mining-2026-07-08_to_2026-07-14\.json$/);
  });
});

describe("run — dry-run mode", () => {
  it("writes a request preview and makes no provider call, requiring no key or model", async () => {
    const deps = fakeDeps({ "growth-summary-2026-07-08_to_2026-07-14.json": fixtureSummary() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--dry-run"], deps);
    expect(result.mode).toBe("dry-run");
    if (result.mode === "dry-run") {
      expect(result.preview.source).toBe("signal_mining_dry_run");
      expect(result.preview.sourceRecordCatalog.length).toBeGreaterThan(0);
      expect(result.preview.intendedModel).toBeDefined();
    }
  });

  it("never includes an API key, environment dump, or credential path in the preview", async () => {
    const deps = fakeDeps({ "growth-summary-2026-07-08_to_2026-07-14.json": fixtureSummary() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--dry-run", "--provider", "anthropic"], deps);
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("sk-ant");
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain(":\\users\\");
  });
});

describe("run — mock provider mode", () => {
  it("produces a valid FinalSignalMiningRun and writes JSON + Markdown", async () => {
    const deps = fakeDeps({ "growth-summary-2026-07-08_to_2026-07-14.json": fixtureSummary() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--provider", "mock"], deps);
    expect(result.mode).toBe("signals");
    if (result.mode === "signals") {
      expect(result.run.generation.isMock).toBe(true);
      expect(result.run.humanReview.required).toBe(true);
      expect(result.jsonPath).toMatch(/signal-mining-2026-07-08_to_2026-07-14\.json$/);
      expect(result.markdownPath).toMatch(/signal-mining-2026-07-08_to_2026-07-14\.md$/);
    }
  });

  it("throws SignalMiningInputError when no usable source records exist for a non-dry-run", async () => {
    const emptySummary = fixtureSummary({
      traffic: { overview: { sessions: 0, screenPageViews: 0, engagedSessions: 0, engagementRate: null, activeUsers: null, activeUsersMeasurementNote: "x" }, acquisition: [], landingPages: [], topSources: [], topLandingPages: [] },
      behavior: { eventTotals: { pageViews: 0, viewDemoClicks: 0, remixClicks: 0, buildClicks: 0, copyPromptClicks: 0, totalCtaClicks: 0 }, uniqueUsers: null, uniqueUsersMeasurementNote: "x", byApp: [], byPageType: [], byUtmSource: [], byUtmMedium: [], byUtmCampaign: [], byUtmContent: [] },
      search: { status: "missing", totals: { clicks: 0, impressions: 0, ctr: null, averagePosition: null }, daily: [], topQueries: [], topPages: [], queryPages: [] },
    });
    const deps = fakeDeps({ "growth-summary-2026-07-08_to_2026-07-14.json": emptySummary });
    await expect(run(["--start", PERIOD.start, "--end", PERIOD.end, "--provider", "mock"], deps)).rejects.toThrow(SignalMiningInputError);
  });

  it("carries a manual-input record through into the final run's signals", async () => {
    const deps = fakeDeps({
      "growth-summary-2026-07-08_to_2026-07-14.json": fixtureSummary(),
      "manual.json": { records: [{ sourceType: "mentor_input", sourceName: "Mentor", title: "Manual signal", text: "Manual observation text." }] },
    });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--provider", "mock", "--manual-input", "manual.json"], deps);
    expect(result.mode).toBe("signals");
    if (result.mode === "signals") {
      expect(result.run.provenance.manualInputFilename).toBe("manual.json");
      expect(result.run.sourceSummary.sourceTypes).toContain("mentor_input");
    }
  });
});
