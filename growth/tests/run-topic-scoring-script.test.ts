import { describe, expect, it } from "vitest";
import { AnthropicTopicScoringProvider } from "../llm/anthropic-topic-scoring-provider";
import { MockTopicScoringProvider } from "../llm/mock-topic-scoring-provider";
import {
  TopicScoringConfigError,
  TopicScoringDateRangeError,
  TopicScoringInputError,
  assertLiveMockInputAllowed,
  assertValidDateRange,
  buildDryRunPreview,
  isValidIsoDate,
  loadSignalMiningRun,
  parseArgs,
  readProviderEnv,
  resolvePreviewPath,
  resolveProvider,
  resolveRunJsonPath,
  run,
} from "../scripts/run-topic-scoring";
import type { FileSystemDeps } from "../scripts/run-topic-scoring";
import type { FinalSignalMiningRun } from "../types/signal-mining";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureSignalMiningRun(overrides: Partial<FinalSignalMiningRun> = {}): FinalSignalMiningRun {
  return {
    schemaVersion: "1.0.0",
    runType: "signal_mining",
    generatedAt: "2026-07-15T00:00:00.000Z",
    period: PERIOD,
    campaign: CAMPAIGN,
    provenance: { sourceSummaryFilename: "growth-summary-x.json", sourceSummarySha256: "h", sourceFeedbackFilename: null, sourceFeedbackSha256: null, manualInputFilename: null, manualInputSha256: null, sourceFeedbackIsMock: false },
    generation: { provider: "mock", model: "mock-v0", language: "en", isMock: true, requestId: null, stopReason: "end_turn", usage: { inputTokens: null, outputTokens: null } },
    sourceSummary: { recordsCollected: 1, recordsUsed: 1, recordsOmittedByLimit: 0, sourceTypes: ["ga4"], warnings: [] },
    sourceRecordCatalog: [
      {
        id: "sourcerecord_1",
        source: { type: "ga4", name: "GA4 traffic acquisition", recordId: "google/organic", url: null, publishedAt: null, retrievedAt: "2026-07-15T00:00:00.000Z", isInternal: true },
        title: "Traffic source: google / organic",
        content: "GA4 recorded 80 sessions.",
        entities: { keywords: [], topics: [], audiences: [], productsOrApps: ["orderly"], channels: [] },
        metrics: [{ name: "sessions", value: 80, unit: "count", measurementBasis: "x", period: null }],
        references: { evidenceRefs: [], findingRefs: [], limitationRefs: [] },
        quality: { confidence: "medium", limitations: [] },
      },
    ],
    signals: [
      {
        schemaVersion: "1.0.0",
        id: "signal_1",
        campaignId: CAMPAIGN.id,
        capturedAt: "2026-07-15T00:00:00.000Z",
        source: { type: "ga4", name: "GA4 traffic acquisition", recordId: "google/organic", url: null, publishedAt: null, retrievedAt: "2026-07-15T00:00:00.000Z", isInternal: true },
        signalType: "trending_topic",
        title: "Traffic source: google / organic",
        summary: "GA4 recorded 80 sessions.",
        evidenceExcerpt: null,
        entities: { keywords: [], topics: [], audiences: [], productsOrApps: ["orderly"], channels: [] },
        metrics: [{ name: "sessions", value: 80, unit: "count", measurementBasis: "x", period: null }],
        quality: { confidence: "medium", freshness: "fresh", duplicateStatus: "unique", limitations: [] },
        humanReviewRequired: true,
        provenance: { generatedBy: "signal-mining-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["sourcerecord_1"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
      },
    ],
    topicPool: [
      {
        schemaVersion: "1.0.0",
        id: "topic_1",
        campaignId: CAMPAIGN.id,
        createdAt: "2026-07-15T00:00:00.000Z",
        canonicalName: "Orderly traffic signals",
        slug: "orderly-traffic-signals",
        aliases: [],
        problemStatement: "Orderly is receiving organic traffic worth investigating.",
        targetAudience: "Small shop owners",
        useCases: ["Track stock levels"],
        desiredOutcome: "Understand traffic drivers.",
        signalRefs: ["signal_1"],
        evidenceSummary: { signalCount: 1, sourceCount: 1, sourceTypes: ["ga4"], confidence: "medium", limitations: [] },
        relationshipToExistingContent: { status: "related_to_existing_app", relatedTopicIds: [], relatedAppSlugs: ["orderly"] },
        status: "candidate",
        rejection: null,
        provenance: { generatedBy: "signal-mining-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["signal_1"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
      },
    ],
    unresolvedSourceRecords: [],
    deduplication: { inputSignalProposalCount: 1, finalSignalCount: 1, duplicatesRemoved: 0 },
    humanReview: { required: true, approved: false, approvedBy: null, approvedAt: null, note: "x" },
    dataQuality: { overallStatus: "partial", warnings: [], limitations: [] },
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
    const args = parseArgs(["--start", "2026-07-08", "--end", "2026-07-14", "--input", "custom.json", "--language", "zh-CN", "--provider", "mock", "--overwrite", "--dry-run", "--allow-mock-input"]);
    expect(args).toEqual({ start: "2026-07-08", end: "2026-07-14", input: "custom.json", language: "zh-CN", provider: "mock", overwrite: true, dryRun: true, allowMockInput: true });
  });

  it("requires --start and --end even when --input is given", () => {
    expect(() => parseArgs(["--input", "custom.json"])).toThrow(/requires --start and --end/);
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

  it("throws TopicScoringDateRangeError for invalid dates or start-after-end", () => {
    expect(() => assertValidDateRange("bad", "2026-07-14")).toThrow(TopicScoringDateRangeError);
    expect(() => assertValidDateRange("2026-07-14", "2026-07-08")).toThrow(TopicScoringDateRangeError);
  });
});

describe("readProviderEnv", () => {
  it("defaults TOPIC_SCORING_MAX_TOKENS to 8000 when unset", () => {
    expect(readProviderEnv({} as NodeJS.ProcessEnv).maxTokens).toBe(8000);
  });

  it("reads the topic-scoring-specific and fallback growth-report variables", () => {
    const env = readProviderEnv({
      TOPIC_SCORING_LLM_PROVIDER: "anthropic",
      TOPIC_SCORING_MODEL: "claude-scoring",
      TOPIC_SCORING_MAX_TOKENS: "9000",
      ANTHROPIC_API_KEY: "sk-ant-test",
      GROWTH_REPORT_LLM_PROVIDER: "mock",
      GROWTH_REPORT_MODEL: "claude-report",
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({ provider: "anthropic", model: "claude-scoring", maxTokens: 9000, apiKey: "sk-ant-test", growthReportProvider: "mock", growthReportModel: "claude-report" });
  });
});

describe("resolveProvider — fallback chain", () => {
  const baseEnv = { provider: undefined, model: undefined, maxTokens: 8000, apiKey: undefined, growthReportProvider: undefined, growthReportModel: undefined };
  const baseArgs = { language: "en" as const, overwrite: false, dryRun: false, allowMockInput: false };

  it("throws TopicScoringConfigError when nothing is configured", () => {
    expect(() => resolveProvider(baseArgs, baseEnv)).toThrow(TopicScoringConfigError);
  });

  it("--provider takes priority over TOPIC_SCORING_LLM_PROVIDER and GROWTH_REPORT_LLM_PROVIDER", () => {
    const provider = resolveProvider({ ...baseArgs, provider: "mock" }, { ...baseEnv, provider: "anthropic", growthReportProvider: "anthropic" });
    expect(provider).toBeInstanceOf(MockTopicScoringProvider);
  });

  it("falls back to TOPIC_SCORING_LLM_PROVIDER, then GROWTH_REPORT_LLM_PROVIDER", () => {
    expect(resolveProvider(baseArgs, { ...baseEnv, provider: "mock" })).toBeInstanceOf(MockTopicScoringProvider);
    expect(resolveProvider(baseArgs, { ...baseEnv, growthReportProvider: "mock" })).toBeInstanceOf(MockTopicScoringProvider);
  });

  it("resolves an Anthropic provider, falling back to GROWTH_REPORT_MODEL when TOPIC_SCORING_MODEL is unset", () => {
    const provider = resolveProvider(baseArgs, { ...baseEnv, provider: "anthropic", growthReportModel: "claude-report", apiKey: "sk-ant-test" });
    expect(provider).toBeInstanceOf(AnthropicTopicScoringProvider);
  });

  it("throws TopicScoringConfigError for anthropic without an API key or model", () => {
    expect(() => resolveProvider(baseArgs, { ...baseEnv, provider: "anthropic", model: "m" })).toThrow(TopicScoringConfigError);
    expect(() => resolveProvider(baseArgs, { ...baseEnv, provider: "anthropic", apiKey: "sk-ant-test" })).toThrow(TopicScoringConfigError);
  });

  it("throws TopicScoringConfigError for an unknown provider name", () => {
    expect(() => resolveProvider({ ...baseArgs, provider: "openai" }, baseEnv)).toThrow(TopicScoringConfigError);
  });
});

describe("loadSignalMiningRun", () => {
  const args = { language: "en" as const, overwrite: false, dryRun: false, allowMockInput: false };

  it("loads a valid discovered Signal Mining run", () => {
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": fixtureSignalMiningRun() });
    const result = loadSignalMiningRun(args, PERIOD, deps);
    expect(result.filename).toBe("signal-mining-2026-07-08_to_2026-07-14.json");
  });

  it("fails clearly when no run is found", () => {
    expect(() => loadSignalMiningRun(args, PERIOD, fakeDeps({}))).toThrow(TopicScoringInputError);
  });

  it("rejects malformed JSON", () => {
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": "{not json" });
    expect(() => loadSignalMiningRun(args, PERIOD, deps)).toThrow(TopicScoringInputError);
  });

  it("rejects a file that doesn't match the FinalSignalMiningRun schema", () => {
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": { foo: "bar" } });
    expect(() => loadSignalMiningRun(args, PERIOD, deps)).toThrow(TopicScoringInputError);
  });

  it("rejects an 'invalid' data-quality status", () => {
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": fixtureSignalMiningRun({ dataQuality: { overallStatus: "invalid", warnings: [], limitations: [] } }) });
    expect(() => loadSignalMiningRun(args, PERIOD, deps)).toThrow(TopicScoringInputError);
  });

  it("accepts a 'partial' data-quality status", () => {
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": fixtureSignalMiningRun() });
    expect(() => loadSignalMiningRun(args, PERIOD, deps)).not.toThrow();
  });

  it("rejects a run whose period does not match the requested period", () => {
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": fixtureSignalMiningRun({ period: { start: "2026-06-01", end: "2026-06-07" } }) });
    expect(() => loadSignalMiningRun(args, PERIOD, deps)).toThrow(TopicScoringInputError);
  });

  it("rejects duplicate signal ids", () => {
    const base = fixtureSignalMiningRun();
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": { ...base, signals: [base.signals[0], base.signals[0]] } });
    expect(() => loadSignalMiningRun(args, PERIOD, deps)).toThrow(/duplicate SignalCandidate id/);
  });

  it("rejects duplicate topic ids", () => {
    const base = fixtureSignalMiningRun();
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": { ...base, topicPool: [base.topicPool[0], base.topicPool[0]] } });
    expect(() => loadSignalMiningRun(args, PERIOD, deps)).toThrow(/duplicate TopicCandidate id/);
  });

  it("rejects a topic that references an unknown signal", () => {
    const base = fixtureSignalMiningRun();
    const badTopic = { ...base.topicPool[0], signalRefs: ["signal_nonexistent"] };
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": { ...base, topicPool: [badTopic] } });
    expect(() => loadSignalMiningRun(args, PERIOD, deps)).toThrow(/references unknown SignalCandidate/);
  });

  it("rejects a topic pool containing a rejected/archived status topic", () => {
    const base = fixtureSignalMiningRun();
    const badTopic = { ...base.topicPool[0], status: "archived" as const };
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": { ...base, topicPool: [badTopic] } });
    expect(() => loadSignalMiningRun(args, PERIOD, deps)).toThrow(/only "candidate" or "needs_review"/);
  });

  it("rejects a signal whose provenance cites an unknown source record", () => {
    const base = fixtureSignalMiningRun();
    const badSignal = { ...base.signals[0], provenance: { ...base.signals[0].provenance, sourceRecordIds: ["sourcerecord_nonexistent"] } };
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": { ...base, signals: [badSignal] } });
    expect(() => loadSignalMiningRun(args, PERIOD, deps)).toThrow(/references unknown source record/);
  });

  it("accepts a zero-topic run", () => {
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": fixtureSignalMiningRun({ topicPool: [] }) });
    expect(() => loadSignalMiningRun(args, PERIOD, deps)).not.toThrow();
  });

  it("uses exactly the --input file, bypassing discovery", () => {
    const deps = fakeDeps({ "custom.json": fixtureSignalMiningRun() });
    const result = loadSignalMiningRun({ ...args, input: "custom.json" }, PERIOD, deps);
    expect(result.filename).toBe("custom.json");
  });

  it("detects a mock source run via generation.isMock", () => {
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": fixtureSignalMiningRun({ generation: { ...fixtureSignalMiningRun().generation, isMock: true } }) });
    const result = loadSignalMiningRun(args, PERIOD, deps);
    expect(result.run.generation.isMock).toBe(true);
  });
});

describe("assertLiveMockInputAllowed", () => {
  it("throws when the run is mock-generated and --allow-mock-input is not set", () => {
    const run = fixtureSignalMiningRun({ generation: { ...fixtureSignalMiningRun().generation, isMock: true } });
    expect(() => assertLiveMockInputAllowed(run, "signal-mining-x.json", false)).toThrow(TopicScoringConfigError);
  });

  it("does not throw when --allow-mock-input is set", () => {
    const run = fixtureSignalMiningRun({ generation: { ...fixtureSignalMiningRun().generation, isMock: true } });
    expect(() => assertLiveMockInputAllowed(run, "signal-mining-x.json", true)).not.toThrow();
  });

  it("does not throw when the run is not mock-generated", () => {
    const run = fixtureSignalMiningRun({ generation: { ...fixtureSignalMiningRun().generation, isMock: false } });
    expect(() => assertLiveMockInputAllowed(run, "signal-mining-x.json", false)).not.toThrow();
  });
});

describe("resolvePreviewPath / resolveRunJsonPath — collision-safe filenames", () => {
  it("uses the base filename and follows naming conventions", () => {
    const previewPath = resolvePreviewPath(PERIOD, false, () => false);
    expect(previewPath.replace(/\\/g, "/")).toMatch(/topic-scoring-request-2026-07-08_to_2026-07-14\.json$/);
    const runPath = resolveRunJsonPath(PERIOD, false, () => false);
    expect(runPath.replace(/\\/g, "/")).toMatch(/growth\/scores\/topic-scoring-2026-07-08_to_2026-07-14\.json$/);
  });

  it("appends a timestamp instead of overwriting an existing file", () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const path = resolveRunJsonPath(PERIOD, false, () => true, now);
    expect(path).not.toMatch(/topic-scoring-2026-07-08_to_2026-07-14\.json$/);
  });

  it("reuses the base filename with --overwrite", () => {
    const path = resolveRunJsonPath(PERIOD, true, () => true);
    expect(path.replace(/\\/g, "/")).toMatch(/topic-scoring-2026-07-08_to_2026-07-14\.json$/);
  });
});

describe("buildDryRunPreview", () => {
  it("requires no key and no model (defaults intendedModel to not_configured)", () => {
    const run = fixtureSignalMiningRun();
    const preview = buildDryRunPreview({ run, runFilename: "signal-mining-x.json", runContent: JSON.stringify(run), language: "en", intendedProvider: "not_configured", intendedModel: undefined, maxTokens: 8000, createdAt: "2026-07-16T00:00:00.000Z" });
    expect(preview.intendedModel).toBe("not_configured");
    expect(preview.source).toBe("topic_scoring_dry_run");
    expect(preview.createdAt).toBe("2026-07-16T00:00:00.000Z");
    expect(preview.sourceSignalMiningIsMock).toBe(true);
    expect(preview.topicContexts.length).toBeGreaterThan(0);
    expect(preview.systemPrompt).toContain("topic-assessment analyst");
  });

  it("computes a stable sha256 of the source run content", () => {
    const run = fixtureSignalMiningRun();
    const content = JSON.stringify(run);
    const p1 = buildDryRunPreview({ run, runFilename: "f.json", runContent: content, language: "en", intendedProvider: "mock", intendedModel: undefined, maxTokens: 8000 });
    const p2 = buildDryRunPreview({ run, runFilename: "f.json", runContent: content, language: "en", intendedProvider: "mock", intendedModel: undefined, maxTokens: 8000 });
    expect(p1.sourceSignalMiningSha256).toBe(p2.sourceSignalMiningSha256);
    expect(p1.sourceSignalMiningSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never includes an API key, environment dump, or credential path", () => {
    const run = fixtureSignalMiningRun();
    const preview = buildDryRunPreview({ run, runFilename: "signal-mining-x.json", runContent: JSON.stringify(run), language: "en", intendedProvider: "anthropic", intendedModel: "claude-scoring", maxTokens: 8000 });
    const serialized = JSON.stringify(preview).toLowerCase();
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("sk-ant");
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain(":\\users\\");
  });
});

describe("run — dry-run mode", () => {
  it("writes a request preview and makes no provider call, requiring no key or model", async () => {
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": fixtureSignalMiningRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--dry-run"], deps);
    expect(result.mode).toBe("dry-run");
    if (result.mode === "dry-run") {
      expect(result.preview.source).toBe("topic_scoring_dry_run");
      expect(result.preview.topicContexts.length).toBeGreaterThan(0);
    }
  });
});

describe("run — mock provider mode", () => {
  it("produces a valid FinalTopicScoringRun and writes JSON + Markdown", async () => {
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": fixtureSignalMiningRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--provider", "mock"], deps);
    expect(result.mode).toBe("scores");
    if (result.mode === "scores") {
      expect(result.run.generation.isMock).toBe(true);
      expect(result.run.humanReview.required).toBe(true);
      expect(result.jsonPath).toMatch(/topic-scoring-2026-07-08_to_2026-07-14\.json$/);
      expect(result.markdownPath).toMatch(/topic-scoring-2026-07-08_to_2026-07-14\.md$/);
    }
  });

  it("normally yields needs_human_review for a mock Signal Mining input, not advance", async () => {
    const deps = fakeDeps({ "signal-mining-2026-07-08_to_2026-07-14.json": fixtureSignalMiningRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--provider", "mock"], deps);
    if (result.mode === "scores") {
      expect(result.run.ranking.advanceCount).toBe(0);
    }
  });
});
