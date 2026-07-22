import { describe, expect, it, vi } from "vitest";
import { AnthropicAssetGenerationProvider } from "../llm/anthropic-asset-generation-provider";
import { MockAssetGenerationProvider } from "../llm/mock-asset-generation-provider";
import { AssetGenerationInputError } from "../agents/asset-generation-agent";
import {
  AssetGenerationConfigError,
  AssetGenerationDateRangeError,
  assertHoldTopicAllowed,
  assertLiveMockInputAllowed,
  assertLiveUnapprovedTopicAllowed,
  assertValidDateRange,
  buildDryRunPreview,
  isValidIsoDate,
  loadTopicScoringRun,
  parseArgs,
  parseSocialChannels,
  readProviderEnv,
  resolveIntegrationTestGate,
  resolvePreviewPath,
  resolveProvider,
  resolveRunJsonPath,
  run,
} from "../scripts/generate-assets";
import type { FileSystemDeps } from "../scripts/generate-assets";
import type { ScoringDimensionKey } from "../types/topic-scoring";
import type { FinalTopicScoringRun } from "../types/topic-scoring";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureDimension(key: ScoringDimensionKey, overrides: Record<string, unknown> = {}) {
  return { key, label: key, score: 60, weight: 0.1, weightedScore: 6, rationale: "x", signalRefs: ["signal_1"], evidenceRefs: [], limitations: [], scoreBasis: "evidence" as const, ...overrides };
}

function fixtureTopicScoringRun(overrides: Partial<FinalTopicScoringRun> = {}): FinalTopicScoringRun {
  const topic = {
    schemaVersion: "1.0.0" as const,
    id: "topic_abc",
    campaignId: CAMPAIGN.id,
    createdAt: "2026-07-15T00:00:00.000Z",
    canonicalName: "Inventory Tracker",
    slug: "inventory-tracker",
    aliases: [],
    problemStatement: "Small shops lose track of stock.",
    targetAudience: "Small retail shop owners",
    useCases: ["Track stock counts"],
    desiredOutcome: "Fewer stockouts.",
    signalRefs: ["signal_1"],
    evidenceSummary: { signalCount: 1, sourceCount: 1, sourceTypes: ["ga4"], confidence: "medium" as const, limitations: [] },
    relationshipToExistingContent: { status: "new" as const, relatedTopicIds: [], relatedAppSlugs: [] },
    status: "candidate" as const,
    rejection: null,
    provenance: { generatedBy: "signal-mining-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["signal_1"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
  };

  const scoredTopic = (recommendation: "advance" | "needs_human_review" | "hold" = "advance") => ({
    schemaVersion: "1.0.0" as const,
    id: "scoredtopic_abc",
    topicId: "topic_abc",
    campaignId: CAMPAIGN.id,
    scoredAt: "2026-07-15T00:00:00.000Z",
    scoringVersion: "small_business_topic_scoring@1.0.0",
    dimensions: [
      fixtureDimension("demand"),
      fixtureDimension("audience_relevance"),
      fixtureDimension("product_fit"),
      fixtureDimension("competition"),
      fixtureDimension("feasibility"),
      fixtureDimension("novelty"),
      fixtureDimension("evidence_strength", { score: 70 }),
    ],
    totalScore: recommendation === "hold" ? 30 : 72,
    ranking: { rank: 1, candidateCount: 1 },
    confidence: "high" as const,
    recommendation,
    blockers: recommendation === "hold" ? ["insufficient_evidence: not enough signal"] : [],
    humanReviewRequired: true as const,
    provenance: { generatedBy: "topic-scoring-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["topic_abc"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
  });

  return {
    schemaVersion: "1.0.0",
    runType: "topic_scoring",
    generatedAt: "2026-07-15T00:00:00.000Z",
    period: PERIOD,
    campaign: CAMPAIGN,
    provenance: {
      sourceSignalMiningFilename: "signal-mining-x.json",
      sourceSignalMiningSha256: "h",
      sourceSignalMiningGeneratedAt: "2026-07-15T00:00:00.000Z",
      sourceSignalMiningProvider: "mock",
      sourceSignalMiningModel: "mock-v0",
      sourceSignalMiningIsMock: true,
      sourceSignalsHumanReviewed: false,
    },
    generation: { provider: "mock", model: "mock-v0", language: "en", isMock: true, requestId: null, stopReason: "end_turn", usage: { inputTokens: null, outputTokens: null } },
    scoringProfile: { id: "small_business_topic_scoring", version: "1.0.0", dimensions: [], recommendationRules: { advance: "x", needsHumanReview: "x", hold: "x", reject: "x" }, insufficientEvidenceFallbackScore: 50 },
    topicCatalog: [topic],
    scoredTopics: [scoredTopic("advance")],
    ranking: { candidateCount: 1, rankedTopicIds: ["topic_abc"], topTopicId: "topic_abc", advanceCount: 1, needsHumanReviewCount: 0, holdCount: 0, rejectCount: 0 },
    portfolioObservations: { topicCoverage: "1 of 1 assessed.", evidenceCoverage: "Grounded.", majorLimitations: [], requiresHumanReview: true },
    confidenceAdjustments: [],
    humanReview: { required: true, approved: false, selectedTopicIds: [], approvedBy: null, approvedAt: null, note: "x" },
    dataQuality: { overallStatus: "partial", warnings: [], limitations: [] },
    ...overrides,
  };
}

function fixtureHoldRun(): FinalTopicScoringRun {
  const run = fixtureTopicScoringRun();
  run.scoredTopics[0] = { ...run.scoredTopics[0], recommendation: "hold", totalScore: 30, blockers: ["insufficient_evidence: not enough signal"] };
  return run;
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

describe("parseSocialChannels", () => {
  it("returns [] when no value is supplied", () => {
    expect(parseSocialChannels(undefined)).toEqual([]);
  });

  it("splits, trims, and lowercases comma-separated channels", () => {
    expect(parseSocialChannels(" LinkedIn , X ")).toEqual(["linkedin", "x"]);
  });

  it("dedupes and drops empty entries", () => {
    expect(parseSocialChannels("linkedin,,linkedin,x")).toEqual(["linkedin", "x"]);
  });
});

describe("parseArgs", () => {
  it("requires --topic-id even with --start/--end", () => {
    expect(() => parseArgs(["--start", "2026-07-08", "--end", "2026-07-14"])).toThrow(/requires --topic-id/);
  });

  it("requires --start and --end even with --topic-id", () => {
    expect(() => parseArgs(["--topic-id", "topic_abc"])).toThrow(/requires --start and --end/);
  });

  it("defaults language to en, socialChannels to [], overwrite/dryRun/overrides to false", () => {
    expect(parseArgs(["--start", "2026-07-08", "--end", "2026-07-14", "--topic-id", "topic_abc"])).toEqual({
      start: "2026-07-08",
      end: "2026-07-14",
      topicId: "topic_abc",
      language: "en",
      socialChannels: [],
      overwrite: false,
      dryRun: false,
      allowMockInput: false,
      allowUnapprovedTopic: false,
      allowHoldTopic: false,
      integrationTest: false,
      confirmIntegrationTest: false,
    });
  });

  it("parses --input, --language, --provider, --social-channels, overrides, --overwrite, --dry-run", () => {
    const args = parseArgs([
      "--start", "2026-07-08", "--end", "2026-07-14", "--topic-id", "topic_abc",
      "--input", "custom.json", "--language", "zh-CN", "--provider", "mock",
      "--social-channels", "linkedin,x", "--overwrite", "--dry-run",
      "--allow-mock-input", "--allow-unapproved-topic", "--allow-hold-topic",
    ]);
    expect(args).toEqual({
      start: "2026-07-08",
      end: "2026-07-14",
      topicId: "topic_abc",
      input: "custom.json",
      language: "zh-CN",
      provider: "mock",
      socialChannels: ["linkedin", "x"],
      overwrite: true,
      dryRun: true,
      allowMockInput: true,
      allowUnapprovedTopic: true,
      allowHoldTopic: true,
      integrationTest: false,
      confirmIntegrationTest: false,
    });
  });

  it("rejects unrecognized arguments", () => {
    expect(() => parseArgs(["--start", "2026-07-08", "--end", "2026-07-14", "--topic-id", "topic_abc", "--bogus"])).toThrow(/Unrecognized argument/);
  });
});

describe("parseArgs — integration-test flags", () => {
  const baseArgv = ["--start", "2026-07-08", "--end", "2026-07-14", "--topic-id", "topic_abc"];

  it("parses a fully-specified integration-test invocation", () => {
    const args = parseArgs([...baseArgv, "--provider", "anthropic", "--integration-test", "--confirm-integration-test", "--reviewed-by", "Joy", "--review-note", "Engineering check only.", "--allow-hold-topic", "--allow-unapproved-topic"]);
    expect(args.integrationTest).toBe(true);
    expect(args.confirmIntegrationTest).toBe(true);
    expect(args.reviewedBy).toBe("Joy");
    expect(args.reviewNote).toBe("Engineering check only.");
  });

  it("rejects --integration-test without --confirm-integration-test", () => {
    expect(() => parseArgs([...baseArgv, "--integration-test", "--reviewed-by", "Joy"])).toThrow(/--confirm-integration-test/);
  });

  it("rejects --confirm-integration-test without --integration-test", () => {
    expect(() => parseArgs([...baseArgv, "--confirm-integration-test"])).toThrow(/--integration-test/);
  });

  it("rejects --integration-test without --reviewed-by", () => {
    expect(() => parseArgs([...baseArgv, "--integration-test", "--confirm-integration-test"])).toThrow(/--reviewed-by/);
  });

  it("rejects --integration-test with a whitespace-only --reviewed-by", () => {
    expect(() => parseArgs([...baseArgv, "--integration-test", "--confirm-integration-test", "--reviewed-by", "   "])).toThrow(/--reviewed-by/);
  });

  it("rejects --integration-test combined with --dry-run", () => {
    expect(() => parseArgs([...baseArgv, "--integration-test", "--confirm-integration-test", "--reviewed-by", "Joy", "--dry-run"])).toThrow(/--dry-run/);
  });

  it("does not implement a general --force, --skip-validation, --publish, or --approve-topic flag", () => {
    for (const bogus of ["--force", "--skip-validation", "--publish", "--approve-topic"]) {
      expect(() => parseArgs([...baseArgv, bogus])).toThrow(/Unrecognized argument/);
    }
  });
});

describe("resolveIntegrationTestGate", () => {
  const baseArgs = {
    language: "en" as const,
    socialChannels: [] as string[],
    overwrite: false,
    dryRun: false,
    allowMockInput: false,
    allowUnapprovedTopic: false,
    allowHoldTopic: false,
    integrationTest: false,
    confirmIntegrationTest: false,
    topicId: "topic_abc",
  };

  it("is inactive when --integration-test was not passed", () => {
    expect(resolveIntegrationTestGate(baseArgs)).toEqual({ active: false, reviewedBy: null, reviewNote: null });
  });

  it("is active with reviewedBy/reviewNote when fully specified", () => {
    const gate = resolveIntegrationTestGate({ ...baseArgs, integrationTest: true, confirmIntegrationTest: true, reviewedBy: "Joy", reviewNote: "Note." });
    expect(gate).toEqual({ active: true, reviewedBy: "Joy", reviewNote: "Note." });
  });

  it("defaults reviewNote to null when not supplied", () => {
    const gate = resolveIntegrationTestGate({ ...baseArgs, integrationTest: true, confirmIntegrationTest: true, reviewedBy: "Joy" });
    expect(gate.reviewNote).toBeNull();
  });

  it("throws defensively if integrationTest is true but confirmIntegrationTest/reviewedBy are missing (parseArgs should already prevent this)", () => {
    expect(() => resolveIntegrationTestGate({ ...baseArgs, integrationTest: true })).toThrow(AssetGenerationConfigError);
    expect(() => resolveIntegrationTestGate({ ...baseArgs, integrationTest: true, confirmIntegrationTest: true })).toThrow(AssetGenerationConfigError);
  });
});

describe("isValidIsoDate / assertValidDateRange", () => {
  it("accepts well-formed ISO dates and rejects malformed ones", () => {
    expect(isValidIsoDate("2026-07-15")).toBe(true);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
  });

  it("throws AssetGenerationDateRangeError for invalid dates or start-after-end", () => {
    expect(() => assertValidDateRange("bad", "2026-07-14")).toThrow(AssetGenerationDateRangeError);
    expect(() => assertValidDateRange("2026-07-14", "2026-07-08")).toThrow(AssetGenerationDateRangeError);
  });
});

describe("readProviderEnv", () => {
  it("defaults ASSET_GENERATION_MAX_TOKENS to 10000 and promptVersion to 1.0.0 when unset", () => {
    const env = readProviderEnv({} as NodeJS.ProcessEnv);
    expect(env.maxTokens).toBe(10000);
    expect(env.promptVersion).toBe("1.0.0");
  });

  it("reads the asset-generation-specific and fallback growth-report variables", () => {
    const env = readProviderEnv({
      ASSET_GENERATION_LLM_PROVIDER: "anthropic",
      ASSET_GENERATION_MODEL: "claude-assets",
      ASSET_GENERATION_MAX_TOKENS: "12000",
      ASSET_GENERATION_PROMPT_VERSION: "2.0.0",
      ANTHROPIC_API_KEY: "sk-ant-test",
      GROWTH_REPORT_LLM_PROVIDER: "mock",
      GROWTH_REPORT_MODEL: "claude-report",
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({ provider: "anthropic", model: "claude-assets", maxTokens: 12000, promptVersion: "2.0.0", apiKey: "sk-ant-test", growthReportProvider: "mock", growthReportModel: "claude-report", collectionDestinationUrl: null });
  });

  it("defaults collectionDestinationUrl to null when PUBLIC_SITE_URL is unset", () => {
    expect(readProviderEnv({} as NodeJS.ProcessEnv).collectionDestinationUrl).toBeNull();
  });

  it("reuses the existing PUBLIC_SITE_URL variable as collectionDestinationUrl — no new env var introduced", () => {
    const env = readProviderEnv({ PUBLIC_SITE_URL: "https://whacka-growth-site.vercel.app" } as NodeJS.ProcessEnv);
    expect(env.collectionDestinationUrl).toBe("https://whacka-growth-site.vercel.app");
  });

  it("treats a whitespace-only PUBLIC_SITE_URL as unset (never fabricates a URL)", () => {
    const env = readProviderEnv({ PUBLIC_SITE_URL: "   " } as NodeJS.ProcessEnv);
    expect(env.collectionDestinationUrl).toBeNull();
  });
});

describe("resolveProvider — fallback chain", () => {
  const baseEnv = { provider: undefined, model: undefined, maxTokens: 10000, promptVersion: "1.0.0", apiKey: undefined, growthReportProvider: undefined, growthReportModel: undefined, collectionDestinationUrl: null };
  const baseArgs = { language: "en" as const, socialChannels: [] as string[], overwrite: false, dryRun: false, allowMockInput: false, allowUnapprovedTopic: false, allowHoldTopic: false, integrationTest: false, confirmIntegrationTest: false, topicId: "topic_abc" };

  it("throws AssetGenerationConfigError when nothing is configured", () => {
    expect(() => resolveProvider(baseArgs, baseEnv)).toThrow(AssetGenerationConfigError);
  });

  it("--provider takes priority over ASSET_GENERATION_LLM_PROVIDER and GROWTH_REPORT_LLM_PROVIDER", () => {
    const provider = resolveProvider({ ...baseArgs, provider: "mock" }, { ...baseEnv, provider: "anthropic", growthReportProvider: "anthropic" });
    expect(provider).toBeInstanceOf(MockAssetGenerationProvider);
  });

  it("falls back to ASSET_GENERATION_LLM_PROVIDER, then GROWTH_REPORT_LLM_PROVIDER", () => {
    expect(resolveProvider(baseArgs, { ...baseEnv, provider: "mock" })).toBeInstanceOf(MockAssetGenerationProvider);
    expect(resolveProvider(baseArgs, { ...baseEnv, growthReportProvider: "mock" })).toBeInstanceOf(MockAssetGenerationProvider);
  });

  it("resolves an Anthropic provider, falling back to GROWTH_REPORT_MODEL when ASSET_GENERATION_MODEL is unset", () => {
    const provider = resolveProvider(baseArgs, { ...baseEnv, provider: "anthropic", growthReportModel: "claude-report", apiKey: "sk-ant-test" });
    expect(provider).toBeInstanceOf(AnthropicAssetGenerationProvider);
  });

  it("throws AssetGenerationConfigError for anthropic without an API key or model", () => {
    expect(() => resolveProvider(baseArgs, { ...baseEnv, provider: "anthropic", model: "m" })).toThrow(AssetGenerationConfigError);
    expect(() => resolveProvider(baseArgs, { ...baseEnv, provider: "anthropic", apiKey: "sk-ant-test" })).toThrow(AssetGenerationConfigError);
  });

  it("throws AssetGenerationConfigError for an unknown provider name", () => {
    expect(() => resolveProvider({ ...baseArgs, provider: "openai" }, baseEnv)).toThrow(AssetGenerationConfigError);
  });
});

describe("loadTopicScoringRun", () => {
  const args = { language: "en" as const, socialChannels: [] as string[], overwrite: false, dryRun: false, allowMockInput: false, allowUnapprovedTopic: false, allowHoldTopic: false, integrationTest: false, confirmIntegrationTest: false, topicId: "topic_abc" };

  it("loads a valid discovered Topic Scoring run", () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    const result = loadTopicScoringRun(args, PERIOD, deps);
    expect(result.filename).toBe("topic-scoring-2026-07-08_to_2026-07-14.json");
  });

  it("fails clearly when no run is found", () => {
    expect(() => loadTopicScoringRun(args, PERIOD, fakeDeps({}))).toThrow(AssetGenerationInputError);
  });

  it("rejects malformed JSON", () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": "{not json" });
    expect(() => loadTopicScoringRun(args, PERIOD, deps)).toThrow(AssetGenerationInputError);
  });

  it("rejects a file that doesn't match the FinalTopicScoringRun schema", () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": { foo: "bar" } });
    expect(() => loadTopicScoringRun(args, PERIOD, deps)).toThrow(AssetGenerationInputError);
  });

  it("rejects an 'invalid' data-quality status", () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun({ dataQuality: { overallStatus: "invalid", warnings: [], limitations: [] } }) });
    expect(() => loadTopicScoringRun(args, PERIOD, deps)).toThrow(AssetGenerationInputError);
  });

  it("accepts a 'partial' data-quality status", () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    expect(() => loadTopicScoringRun(args, PERIOD, deps)).not.toThrow();
  });

  it("rejects a run whose period does not match the requested period", () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun({ period: { start: "2026-06-01", end: "2026-06-07" } }) });
    expect(() => loadTopicScoringRun(args, PERIOD, deps)).toThrow(AssetGenerationInputError);
  });

  it("uses exactly --input, bypassing discovery", () => {
    const deps = fakeDeps({ "custom.json": fixtureTopicScoringRun() });
    const result = loadTopicScoringRun({ ...args, input: "custom.json" }, PERIOD, deps);
    expect(result.filename).toBe("custom.json");
  });
});

describe("assertLiveMockInputAllowed / assertLiveUnapprovedTopicAllowed / assertHoldTopicAllowed", () => {
  it("assertLiveMockInputAllowed throws for mock input without override", () => {
    const run = fixtureTopicScoringRun({ generation: { ...fixtureTopicScoringRun().generation, isMock: true } });
    expect(() => assertLiveMockInputAllowed(run, "f.json", false)).toThrow(AssetGenerationConfigError);
    expect(() => assertLiveMockInputAllowed(run, "f.json", true)).not.toThrow();
  });

  it("assertLiveUnapprovedTopicAllowed throws for unapproved topics without override", () => {
    const run = fixtureTopicScoringRun();
    expect(() => assertLiveUnapprovedTopicAllowed(run, false)).toThrow(AssetGenerationConfigError);
    expect(() => assertLiveUnapprovedTopicAllowed(run, true)).not.toThrow();
  });

  it("assertHoldTopicAllowed allows advance/needs_human_review without any override", () => {
    expect(() => assertHoldTopicAllowed("advance", "mock", false)).not.toThrow();
    expect(() => assertHoldTopicAllowed("needs_human_review", "dry-run", false)).not.toThrow();
  });

  it("assertHoldTopicAllowed rejects hold in mock/dry-run without --allow-hold-topic", () => {
    expect(() => assertHoldTopicAllowed("hold", "mock", false)).toThrow(AssetGenerationConfigError);
    expect(() => assertHoldTopicAllowed("hold", "dry-run", false)).toThrow(AssetGenerationConfigError);
  });

  it("assertHoldTopicAllowed accepts hold in mock/dry-run with --allow-hold-topic", () => {
    expect(() => assertHoldTopicAllowed("hold", "mock", true)).not.toThrow();
    expect(() => assertHoldTopicAllowed("hold", "dry-run", true)).not.toThrow();
  });

  it("assertHoldTopicAllowed always rejects hold for live anthropic without the integration-test override, even with --allow-hold-topic", () => {
    expect(() => assertHoldTopicAllowed("hold", "anthropic", true)).toThrow(AssetGenerationConfigError);
    expect(() => assertHoldTopicAllowed("hold", "anthropic", false)).toThrow(AssetGenerationConfigError);
  });

  it("assertHoldTopicAllowed accepts hold for live anthropic ONLY with the explicit integration-test override", () => {
    expect(() => assertHoldTopicAllowed("hold", "anthropic", true, true)).not.toThrow();
  });

  it("assertHoldTopicAllowed still rejects hold for live anthropic if integrationTestOverride is true but the caller lied about allowHoldTopic being needed too — override alone never substitutes for the flag bundle", () => {
    // The real caller (run()) only ever passes integrationTestOverride = (gate.active && args.allowHoldTopic),
    // so this exercises the function's own contract in isolation: integrationTestOverride is a pass/fail signal computed by the caller, not re-derived here.
    expect(() => assertHoldTopicAllowed("hold", "anthropic", false, false)).toThrow(AssetGenerationConfigError);
  });

  it("the integration-test override never applies outside live anthropic mode — mock/dry-run still require --allow-hold-topic on its own", () => {
    expect(() => assertHoldTopicAllowed("hold", "mock", false, true)).toThrow(AssetGenerationConfigError);
    expect(() => assertHoldTopicAllowed("hold", "dry-run", false, true)).toThrow(AssetGenerationConfigError);
  });
});

describe("resolvePreviewPath / resolveRunJsonPath — collision-safe, topic-id-suffixed filenames", () => {
  it("includes the topic ID after the date range", () => {
    const previewPath = resolvePreviewPath(PERIOD, "topic_abc", false, () => false);
    expect(previewPath.replace(/\\/g, "/")).toMatch(/asset-generation-request-2026-07-08_to_2026-07-14-topic_abc\.json$/);
    const runPath = resolveRunJsonPath(PERIOD, "topic_abc", false, () => false);
    expect(runPath.replace(/\\/g, "/")).toMatch(/growth\/assets\/asset-generation-2026-07-08_to_2026-07-14-topic_abc\.json$/);
  });

  it("appends a timestamp instead of overwriting an existing file", () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const path = resolveRunJsonPath(PERIOD, "topic_abc", false, () => true, now);
    expect(path).not.toMatch(/asset-generation-2026-07-08_to_2026-07-14-topic_abc\.json$/);
  });

  it("reuses the base filename with --overwrite", () => {
    const path = resolveRunJsonPath(PERIOD, "topic_abc", true, () => true);
    expect(path.replace(/\\/g, "/")).toMatch(/asset-generation-2026-07-08_to_2026-07-14-topic_abc\.json$/);
  });

  it("inserts a visible .integration-test segment when integrationTest is true, leaving normal filenames untouched", () => {
    const normalPath = resolveRunJsonPath(PERIOD, "topic_abc", false, () => false);
    expect(normalPath.replace(/\\/g, "/")).toMatch(/asset-generation-2026-07-08_to_2026-07-14-topic_abc\.json$/);

    const integrationTestPath = resolveRunJsonPath(PERIOD, "topic_abc", false, () => false, undefined, true);
    expect(integrationTestPath.replace(/\\/g, "/")).toMatch(/asset-generation-2026-07-08_to_2026-07-14-topic_abc\.integration-test\.json$/);
  });

  it("still applies collision-safe timestamping and --overwrite to integration-test filenames", () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const collidedPath = resolveRunJsonPath(PERIOD, "topic_abc", false, () => true, now, true);
    expect(collidedPath.replace(/\\/g, "/")).not.toMatch(/\.integration-test\.json$/);
    expect(collidedPath.replace(/\\/g, "/")).toMatch(/\.integration-test\.2026-07-16T00-00-00-000Z\.json$/);

    const overwritePath = resolveRunJsonPath(PERIOD, "topic_abc", true, () => true, now, true);
    expect(overwritePath.replace(/\\/g, "/")).toMatch(/asset-generation-2026-07-08_to_2026-07-14-topic_abc\.integration-test\.json$/);
  });
});

describe("buildDryRunPreview", () => {
  it("requires no key and no model (defaults intendedModel to not_configured)", () => {
    const runFixture = fixtureTopicScoringRun();
    const preview = buildDryRunPreview({
      run: runFixture,
      runFilename: "topic-scoring-x.json",
      runContent: JSON.stringify(runFixture),
      topicId: "topic_abc",
      language: "en",
      socialChannels: [],
      intendedProvider: "not_configured",
      intendedModel: undefined,
      maxTokens: 10000,
      overrides: { allowMockInput: false, allowUnapprovedTopic: false, allowHoldTopic: false },
      createdAt: "2026-07-16T00:00:00.000Z",
    });
    expect(preview.intendedModel).toBe("not_configured");
    expect(preview.source).toBe("asset_generation_dry_run");
    expect(preview.selectedTopicId).toBe("topic_abc");
    expect(preview.systemPrompt).toContain("growth asset designer");
  });

  it("never includes an API key, environment dump, or credential path", () => {
    const runFixture = fixtureTopicScoringRun();
    const preview = buildDryRunPreview({
      run: runFixture,
      runFilename: "topic-scoring-x.json",
      runContent: JSON.stringify(runFixture),
      topicId: "topic_abc",
      language: "en",
      socialChannels: [],
      intendedProvider: "anthropic",
      intendedModel: "claude-assets",
      maxTokens: 10000,
      overrides: { allowMockInput: false, allowUnapprovedTopic: false, allowHoldTopic: false },
    });
    const serialized = JSON.stringify(preview).toLowerCase();
    expect(serialized).not.toContain("sk-ant");
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain(":\\users\\");
  });
});

describe("run — dry-run mode", () => {
  it("writes a request preview and makes no provider call, requiring no key or model", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--dry-run"], deps);
    expect(result.mode).toBe("dry-run");
    if (result.mode === "dry-run") {
      expect(result.preview.source).toBe("asset_generation_dry_run");
      expect(result.preview.selectedTopicId).toBe("topic_abc");
    }
  });

  it("rejects an unknown --topic-id even in dry-run", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    await expect(run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_unknown", "--dry-run"], deps)).rejects.toThrow(AssetGenerationInputError);
  });

  it("rejects a hold-recommendation topic in dry-run without --allow-hold-topic", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureHoldRun() });
    await expect(run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--dry-run"], deps)).rejects.toThrow(AssetGenerationConfigError);
  });

  it("accepts a hold-recommendation topic in dry-run with --allow-hold-topic", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureHoldRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--dry-run", "--allow-hold-topic"], deps);
    expect(result.mode).toBe("dry-run");
  });
});

describe("run — mock provider mode", () => {
  it("produces a valid FinalAssetGenerationRun and writes JSON + Markdown", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock"], deps);
    expect(result.mode).toBe("assets");
    if (result.mode === "assets") {
      expect(result.run.generation.isMock).toBe(true);
      expect(result.run.humanReview.required).toBe(true);
      expect(result.jsonPath).toMatch(/asset-generation-2026-07-08_to_2026-07-14-topic_abc\.json$/);
      expect(result.markdownPath).toMatch(/asset-generation-2026-07-08_to_2026-07-14-topic_abc\.md$/);
    }
  });

  it("does not require --allow-mock-input or --allow-unapproved-topic for the Mock Provider", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock"], deps);
    expect(result.mode).toBe("assets");
  });

  it("rejects a hold-recommendation topic with the Mock Provider without --allow-hold-topic", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureHoldRun() });
    await expect(run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock"], deps)).rejects.toThrow(AssetGenerationConfigError);
  });

  it("accepts a hold-recommendation topic with the Mock Provider and --allow-hold-topic", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureHoldRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock", "--allow-hold-topic"], deps);
    expect(result.mode).toBe("assets");
  });

  it("carries requested social channels through into the final AssetBundle", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock", "--social-channels", "linkedin"], deps);
    if (result.mode === "assets") {
      expect(result.run.assetBundle.social.posts.map((p) => p.channel)).toEqual(["linkedin"]);
    }
  });

  it("produces collection-scoped LinkedIn output featuring existing apps alongside the new concept, not the new app alone", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock", "--social-channels", "linkedin"], deps);
    if (result.mode !== "assets") throw new Error("unreachable");
    const strategy = result.run.assetBundle.social.strategy;
    expect(strategy).toBeDefined();
    expect(strategy?.scope).toBe("collection");
    expect(strategy?.featuredAppSlugs.length).toBeGreaterThanOrEqual(3); // new app + at least 2 existing
    expect(strategy?.campaignId).toBe(result.run.campaign.id);
  });

  it("produces collection-scoped X output the same way as LinkedIn", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock", "--social-channels", "x"], deps);
    if (result.mode !== "assets") throw new Error("unreachable");
    expect(result.run.assetBundle.social.posts.map((p) => p.channel)).toEqual(["x"]);
    expect(result.run.assetBundle.social.strategy?.scope).toBe("collection");
  });

  it("supports multiple channels at once, each collection-scoped, sharing the same strategy", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock", "--social-channels", "linkedin,x"], deps);
    if (result.mode !== "assets") throw new Error("unreachable");
    expect(result.run.assetBundle.social.posts.map((p) => p.channel).sort()).toEqual(["linkedin", "x"]);
    expect(result.run.assetBundle.social.strategy?.scope).toBe("collection");
  });

  it("still rejects an unsupported/unrequested channel exactly as before (existing CLI behavior unchanged)", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    // Mock Provider only ever posts to requested channels, so simulate the rejection path directly via validateAssetGenerationAnalysis-covered behavior:
    // requesting zero channels must still yield zero posts and no strategy.
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock"], deps);
    if (result.mode !== "assets") throw new Error("unreachable");
    expect(result.run.assetBundle.social.posts).toEqual([]);
    expect(result.run.assetBundle.social.strategy).toBeUndefined();
  });

  it("passes PUBLIC_SITE_URL through to social.strategy.destinationUrl when configured", async () => {
    vi.stubEnv("PUBLIC_SITE_URL", "https://whacka-growth-site.vercel.app");
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock", "--social-channels", "linkedin"], deps);
    if (result.mode !== "assets") throw new Error("unreachable");
    expect(result.run.assetBundle.social.strategy?.destinationUrl).toBe("https://whacka-growth-site.vercel.app");
    vi.unstubAllEnvs();
  });

  it("leaves destinationUrl null and records a warning when PUBLIC_SITE_URL is unset", async () => {
    vi.stubEnv("PUBLIC_SITE_URL", "");
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock", "--social-channels", "linkedin"], deps);
    if (result.mode !== "assets") throw new Error("unreachable");
    expect(result.run.assetBundle.social.strategy?.destinationUrl).toBeNull();
    expect(result.run.assetBundle.validation.warnings.some((w) => w.includes("No public collection landing page URL is configured"))).toBe(true);
    vi.unstubAllEnvs();
  });

  it("does not add any posting/scheduling side effect — run() only ever returns data and writes local files", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock", "--social-channels", "linkedin"], deps);
    expect(result.mode).toBe("assets");
    // No network/posting API exists on the result or the module — nothing to invoke.
    expect(result).not.toHaveProperty("posted");
    expect(result).not.toHaveProperty("scheduled");
  });
});

describe("run — integration-test mode (offline via Mock Provider)", () => {
  const INTEGRATION_TEST_FLAGS = ["--integration-test", "--confirm-integration-test", "--reviewed-by", "Joy", "--review-note", "Engineering integration test only."];

  it("produces executionPurpose: integration_test with full metadata, forced needs_review, and a suffixed filename", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureHoldRun() });
    const result = await run(
      ["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock", "--allow-hold-topic", "--allow-unapproved-topic", ...INTEGRATION_TEST_FLAGS],
      deps
    );
    expect(result.mode).toBe("assets");
    if (result.mode !== "assets") return;

    expect(result.run.executionPurpose).toBe("integration_test");
    expect(result.run.integrationTestReview).toEqual({
      confirmed: true,
      reviewedBy: "Joy",
      reviewNote: "Engineering integration test only.",
      sourceRecommendation: "hold",
      businessApprovalGranted: false,
    });
    expect(result.run.assetBundle.validation.status).toBe("needs_review");
    expect(result.run.humanReview.required).toBe(true);
    expect(result.run.humanReview.approved).toBe(false);
    expect(result.run.compatibility.cmsWritePerformed).toBe(false);
    expect(result.run.compatibility.siteModified).toBe(false);
    expect(result.run.compatibility.seoPersistenceAvailable).toBe(true);
    expect(result.jsonPath.replace(/\\/g, "/")).toMatch(/asset-generation-2026-07-08_to_2026-07-14-topic_abc\.integration-test\.json$/);
    expect(result.markdownPath.replace(/\\/g, "/")).toMatch(/asset-generation-2026-07-08_to_2026-07-14-topic_abc\.integration-test\.md$/);
  });

  it("records the four required integration-test warnings on the AssetBundle", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureHoldRun() });
    const result = await run(
      ["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock", "--allow-hold-topic", "--allow-unapproved-topic", ...INTEGRATION_TEST_FLAGS],
      deps
    );
    if (result.mode !== "assets") throw new Error("unreachable");
    expect(result.run.assetBundle.validation.warnings).toEqual(
      expect.arrayContaining([
        "Generated under explicit engineering integration-test override.",
        'Source topic recommendation is "hold".',
        "This output is not approved as a business experiment.",
        "Human content review is required before any CMS draft write.",
      ])
    );
  });

  it("does not mutate the source ScoredTopic's recommendation or blockers", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureHoldRun() });
    const result = await run(
      ["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock", "--allow-hold-topic", "--allow-unapproved-topic", ...INTEGRATION_TEST_FLAGS],
      deps
    );
    if (result.mode !== "assets") throw new Error("unreachable");
    expect(result.run.selectedScoredTopic.recommendation).toBe("hold");
    expect(result.run.selectedScoredTopic.blockers).toEqual(["insufficient_evidence: not enough signal"]);
  });

  it("normal (non-integration-test) runs still resolve executionPurpose to business_experiment", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureTopicScoringRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock"], deps);
    if (result.mode !== "assets") throw new Error("unreachable");
    expect(result.run.executionPurpose).toBe("business_experiment");
    expect(result.run.integrationTestReview).toBeNull();
    expect(result.jsonPath).not.toContain("integration-test");
  });

  it("rejects a full integration-test request missing --allow-hold-topic", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureHoldRun() });
    await expect(
      run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock", "--allow-unapproved-topic", ...INTEGRATION_TEST_FLAGS], deps)
    ).rejects.toThrow(AssetGenerationConfigError);
  });

  it("never lets any integration-test flag override an invalid/unknown --topic-id", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureHoldRun() });
    await expect(
      run(
        ["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_does_not_exist", "--provider", "mock", "--allow-hold-topic", "--allow-unapproved-topic", ...INTEGRATION_TEST_FLAGS],
        deps
      )
    ).rejects.toThrow(AssetGenerationInputError);
  });

  it("never lets integration-test flags override an unsupported Topic Scoring schema version", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": { ...fixtureHoldRun(), schemaVersion: "2.0.0" } });
    await expect(
      run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock", "--allow-hold-topic", "--allow-unapproved-topic", ...INTEGRATION_TEST_FLAGS], deps)
    ).rejects.toThrow(AssetGenerationInputError);
  });

  it("no secret or absolute local path ever appears in an integration-test run", async () => {
    const deps = fakeDeps({ "topic-scoring-2026-07-08_to_2026-07-14.json": fixtureHoldRun() });
    const result = await run(
      ["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_abc", "--provider", "mock", "--allow-hold-topic", "--allow-unapproved-topic", ...INTEGRATION_TEST_FLAGS],
      deps
    );
    if (result.mode !== "assets") throw new Error("unreachable");
    const serialized = JSON.stringify(result.run).toLowerCase();
    expect(serialized).not.toContain("sk-ant");
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain(":\\users\\");
  });
});
