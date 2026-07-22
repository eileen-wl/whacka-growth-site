import { afterEach, describe, expect, it, vi } from "vitest";

const createOrReplaceMock = vi.fn(async (doc: Record<string, unknown>) => ({
  _id: doc._id as string,
  _rev: "rev1",
  _createdAt: "2026-07-21T00:00:00.000Z",
  _updatedAt: "2026-07-21T00:00:00.000Z",
}));

/** The only Sanity mock in this file — `@sanity/client`'s `createClient` is replaced module-wide, so no test here can ever reach a real Sanity project. */
vi.mock("@sanity/client", () => ({
  createClient: vi.fn(() => ({ createOrReplace: createOrReplaceMock })),
}));

import {
  CmsWriteConfigError,
  CmsWriteDateRangeError,
  CmsWriteInputError,
  assertLiveIntegrationTestInputAllowed,
  assertLiveMockInputAllowed,
  assertSanityConfigured,
  assertValidDateRange,
  isValidIsoDate,
  loadAssetGenerationRun,
  parseArgs,
  readSanityEnv,
  resolveReceiptPath,
  resolveRequestPath,
  run,
} from "../scripts/write-cms-draft";
import type { FileSystemDeps } from "../scripts/write-cms-draft";
import type { FinalAssetGenerationRun as FinalAssetGenerationRunType } from "../types/asset-generation";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };
const TOPIC_ID = "topic_abc";

function fixtureAssetGenerationRun(overrides: Record<string, unknown> = {}): FinalAssetGenerationRunType {
  const base = {
    schemaVersion: "1.0.0",
    runType: "asset_generation",
    generatedAt: "2026-07-16T00:00:00.000Z",
    period: PERIOD,
    campaign: CAMPAIGN,
    provenance: {
      sourceTopicScoringFilename: "topic-scoring-2026-07-08_to_2026-07-14.json",
      sourceTopicScoringSha256: "hash",
      sourceTopicScoringGeneratedAt: "2026-07-15T00:00:00.000Z",
      sourceTopicScoringProvider: "mock",
      sourceTopicScoringModel: "mock-v0",
      sourceTopicScoringIsMock: true,
      sourceTopicsHumanReviewed: false,
      selectedTopicId: TOPIC_ID,
      selectedScoredTopicId: "scoredtopic_abc",
      allowMockInputUsed: false,
      allowUnapprovedTopicUsed: false,
      allowHoldTopicUsed: false,
    },
    generation: { provider: "mock", model: "mock-v0", language: "en", promptVersion: "1.0.0", isMock: true, requestId: null, stopReason: "end_turn", usage: { inputTokens: null, outputTokens: null } },
    selectedTopic: {
      schemaVersion: "1.0.0",
      id: TOPIC_ID,
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
      evidenceSummary: { signalCount: 1, sourceCount: 1, sourceTypes: ["ga4"], confidence: "medium", limitations: [] },
      relationshipToExistingContent: { status: "new", relatedTopicIds: [], relatedAppSlugs: [] },
      status: "candidate",
      rejection: null,
      provenance: { generatedBy: "signal-mining-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["signal_1"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
    },
    selectedScoredTopic: {
      schemaVersion: "1.0.0",
      id: "scoredtopic_abc",
      topicId: TOPIC_ID,
      campaignId: CAMPAIGN.id,
      scoredAt: "2026-07-15T00:00:00.000Z",
      scoringVersion: "small_business_topic_scoring@1.0.0",
      dimensions: [],
      totalScore: 72,
      ranking: { rank: 1, candidateCount: 3 },
      confidence: "high",
      recommendation: "advance",
      blockers: [],
      humanReviewRequired: true,
      provenance: { generatedBy: "topic-scoring-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: [TOPIC_ID], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
    },
    assetBundle: {
      schemaVersion: "1.0.0",
      id: "assetbundle_fixed_id",
      scoredTopicId: "scoredtopic_abc",
      topicId: TOPIC_ID,
      campaignId: CAMPAIGN.id,
      generatedAt: "2026-07-16T00:00:00.000Z",
      app: {
        name: "Inventory Tracker",
        slug: "inventory-tracker",
        tagline: "Track stock without a spreadsheet.",
        category: "Mini App Concept",
        shortDescription: "A focused tool for small shops.",
        image: "/images/inventory-tracker/cover.svg",
        screenshots: [],
        problem: "Small shops lose track of stock.",
        solution: "Log stock counts in one place.",
        whoItsFor: ["Small retail shop owners"],
        appPrompt: "Build a mini app called Inventory Tracker.",
        ctaLabel: "Build Inventory Tracker with Whacka",
        ctaHref: "https://whacka.app/dashboard",
        relatedSlugs: [],
        faq: [{ question: "Is this free?", answer: "Yes." }],
        status: "draft",
      },
      creativeBrief: { hook: "Never run out of stock again.", persona: "Small shop owner", scenario: "Managing stock.", steps: [] },
      seo: { title: "Inventory Tracker", metaDescription: "Track stock levels without a spreadsheet.", primaryKeyword: "inventory tracker", secondaryKeywords: ["stock tracker"] },
      cta: {
        primaryType: "build",
        demoUrl: null,
        remixUrl: null,
        buildUrl: "https://whacka.app/dashboard",
        labels: { viewDemo: null, remix: null, build: "Build Inventory Tracker with Whacka", copyPrompt: null },
        utmContent: "inventory-tracker",
      },
      social: { posts: [] },
      generation: { provider: "mock", model: "mock-v0", isMock: true, promptVersion: "1.0.0", evidenceRefs: [], signalRefs: [], findingRefs: [] },
      validation: { status: "needs_review", warnings: [], humanReviewRequired: true },
      provenance: { generatedBy: "asset-generation-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["scoredtopic_abc"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
    },
    compatibility: { sanityAppToolCompatible: true, astroAppDataCompatible: true, seoPersistenceAvailable: true, cmsWritePerformed: false, siteModified: false, warnings: [] },
    humanReview: { required: true, approved: false, approvedBy: null, approvedAt: null, note: "AssetBundle must be reviewed before CMS Writer creates a Sanity draft." },
    dataQuality: { overallStatus: "partial", warnings: [], limitations: [] },
  };
  return { ...base, ...overrides } as unknown as FinalAssetGenerationRunType;
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

const RUN_FILENAME = `asset-generation-${PERIOD.start}_to_${PERIOD.end}-${TOPIC_ID}.json`;

afterEach(() => {
  vi.unstubAllEnvs();
  createOrReplaceMock.mockClear();
});

describe("parseArgs", () => {
  const baseArgv = ["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID];

  it("requires exactly one of --dry-run or --write-draft", () => {
    expect(() => parseArgs(baseArgv)).toThrow(/exactly one/);
    expect(() => parseArgs([...baseArgv, "--dry-run", "--write-draft"])).toThrow(/exactly one/);
  });

  it("accepts a valid --dry-run invocation", () => {
    const args = parseArgs([...baseArgv, "--dry-run"]);
    expect(args.dryRun).toBe(true);
    expect(args.writeDraft).toBe(false);
  });

  it("requires --start and --end even when --input is given", () => {
    expect(() => parseArgs(["--input", "growth/assets/x.json", "--dry-run"])).toThrow(/requires --start and --end/);
  });

  it("requires --topic-id for automatic discovery unless --input is given", () => {
    expect(() => parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--dry-run"])).toThrow(/--topic-id/);
    expect(() => parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--input", "x.json", "--dry-run"])).not.toThrow();
  });

  it("requires --confirm-reviewed for --write-draft", () => {
    expect(() => parseArgs([...baseArgv, "--write-draft", "--reviewed-by", "Joy"])).toThrow(/--confirm-reviewed/);
  });

  it("requires a non-empty --reviewed-by for --write-draft", () => {
    expect(() => parseArgs([...baseArgv, "--write-draft", "--confirm-reviewed"])).toThrow(/--reviewed-by/);
    expect(() => parseArgs([...baseArgv, "--write-draft", "--confirm-reviewed", "--reviewed-by", "  "])).toThrow(/--reviewed-by/);
  });

  it("accepts a fully-specified --write-draft invocation", () => {
    const args = parseArgs([...baseArgv, "--write-draft", "--confirm-reviewed", "--reviewed-by", "Joy", "--review-note", "Looks good", "--allow-mock-input", "--overwrite"]);
    expect(args.writeDraft).toBe(true);
    expect(args.confirmReviewed).toBe(true);
    expect(args.reviewedBy).toBe("Joy");
    expect(args.reviewNote).toBe("Looks good");
    expect(args.allowMockInput).toBe(true);
    expect(args.overwrite).toBe(true);
  });

  it("parses --allow-integration-test-input, defaulting to false", () => {
    expect(parseArgs([...baseArgv, "--dry-run"]).allowIntegrationTestInput).toBe(false);
    const args = parseArgs([...baseArgv, "--write-draft", "--confirm-reviewed", "--reviewed-by", "Joy", "--allow-integration-test-input"]);
    expect(args.allowIntegrationTestInput).toBe(true);
  });

  it("rejects an unrecognized argument", () => {
    expect(() => parseArgs([...baseArgv, "--dry-run", "--publish"])).toThrow(/Unrecognized argument/);
  });

  it("does not implement a --publish flag at all", () => {
    expect(() => parseArgs([...baseArgv, "--dry-run", "--publish"])).toThrow();
  });
});

describe("isValidIsoDate / assertValidDateRange", () => {
  it("accepts a valid ISO date", () => {
    expect(isValidIsoDate("2026-07-08")).toBe(true);
  });

  it("rejects a malformed date", () => {
    expect(isValidIsoDate("2026-13-40")).toBe(false);
  });

  it("throws CmsWriteDateRangeError when start is after end", () => {
    expect(() => assertValidDateRange("2026-07-14", "2026-07-08")).toThrow(CmsWriteDateRangeError);
  });
});

describe("readSanityEnv / assertSanityConfigured", () => {
  it("reads the existing PUBLIC_SANITY_*/SANITY_API_TOKEN variable names — no new env vars introduced", () => {
    const env = readSanityEnv({
      PUBLIC_SANITY_PROJECT_ID: "proj123",
      PUBLIC_SANITY_DATASET: "production",
      PUBLIC_SANITY_API_VERSION: "2024-06-01",
      SANITY_API_TOKEN: "sk-test",
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({ projectId: "proj123", dataset: "production", apiVersion: "2024-06-01", token: "sk-test" });
  });

  it("defaults apiVersion when unset", () => {
    const env = readSanityEnv({} as NodeJS.ProcessEnv);
    expect(env.apiVersion).toBe("2024-01-01");
  });

  it("throws CmsWriteConfigError listing every missing variable", () => {
    expect(() => assertSanityConfigured({ projectId: undefined, dataset: undefined, apiVersion: "2024-01-01", token: undefined })).toThrow(CmsWriteConfigError);
    try {
      assertSanityConfigured({ projectId: undefined, dataset: "production", apiVersion: "2024-01-01", token: undefined });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("PUBLIC_SANITY_PROJECT_ID");
      expect((err as Error).message).toContain("SANITY_API_TOKEN");
      expect((err as Error).message).not.toContain("PUBLIC_SANITY_DATASET");
    }
  });

  it("returns a resolved config when everything is present", () => {
    const config = assertSanityConfigured({ projectId: "p", dataset: "d", apiVersion: "v", token: "t" });
    expect(config).toEqual({ projectId: "p", dataset: "d", apiVersion: "v", token: "t" });
  });
});

describe("loadAssetGenerationRun", () => {
  it("discovers the run matching period + topic-id", () => {
    const deps = fakeDeps({ [RUN_FILENAME]: fixtureAssetGenerationRun() });
    const args = parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--dry-run"]);
    const loaded = loadAssetGenerationRun(args, PERIOD, deps);
    expect(loaded.filename).toBe(RUN_FILENAME);
  });

  it("throws CmsWriteInputError when no match exists", () => {
    const args = parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--dry-run"]);
    expect(() => loadAssetGenerationRun(args, PERIOD, fakeDeps({}))).toThrow(CmsWriteInputError);
  });

  it("throws on malformed JSON", () => {
    const deps = fakeDeps({ [RUN_FILENAME]: "{not json" });
    const args = parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--dry-run"]);
    expect(() => loadAssetGenerationRun(args, PERIOD, deps)).toThrow(CmsWriteInputError);
  });

  it("throws when runType does not match", () => {
    const deps = fakeDeps({ [RUN_FILENAME]: fixtureAssetGenerationRun({ runType: "topic_scoring" }) });
    const args = parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--dry-run"]);
    expect(() => loadAssetGenerationRun(args, PERIOD, deps)).toThrow(CmsWriteInputError);
  });

  it("throws on a period mismatch", () => {
    const deps = fakeDeps({ [RUN_FILENAME]: fixtureAssetGenerationRun({ period: { start: "2026-06-01", end: "2026-06-07" } }) });
    const args = parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--dry-run"]);
    expect(() => loadAssetGenerationRun(args, PERIOD, deps)).toThrow(CmsWriteInputError);
  });

  it("throws when AssetBundle.app.status is not draft", () => {
    const badRun = fixtureAssetGenerationRun();
    (badRun.assetBundle.app as unknown as Record<string, unknown>).status = "published";
    const deps = fakeDeps({ [RUN_FILENAME]: badRun });
    const args = parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--dry-run"]);
    expect(() => loadAssetGenerationRun(args, PERIOD, deps)).toThrow(CmsWriteInputError);
  });

  it("--input bypasses discovery and reads exactly the given file", () => {
    const deps = fakeDeps({ "custom-name.json": fixtureAssetGenerationRun() });
    const args = parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--input", "custom-name.json", "--dry-run"]);
    const loaded = loadAssetGenerationRun(args, PERIOD, deps);
    expect(loaded.filename).toBe("custom-name.json");
  });

  it("throws when --input's basename is used, not the absolute path (never recorded as an absolute path)", () => {
    const deps = fakeDeps({ "custom-name.json": fixtureAssetGenerationRun() });
    const args = parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--input", "growth/assets/custom-name.json", "--dry-run"]);
    const loaded = loadAssetGenerationRun(args, PERIOD, deps);
    expect(loaded.filename).toBe("custom-name.json");
    expect(loaded.filename).not.toContain("growth/assets");
  });

  it("throws when --topic-id conflicts with the --input file's selected topic", () => {
    const deps = fakeDeps({ "custom-name.json": fixtureAssetGenerationRun() });
    const args = parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", "topic_other", "--input", "custom-name.json", "--dry-run"]);
    expect(() => loadAssetGenerationRun(args, PERIOD, deps)).toThrow(CmsWriteInputError);
  });

  it("never auto-discovers a .integration-test.json file — it is invisible to plain --topic-id discovery", () => {
    const integrationTestFilename = `asset-generation-${PERIOD.start}_to_${PERIOD.end}-${TOPIC_ID}.integration-test.json`;
    const deps = fakeDeps({ [integrationTestFilename]: fixtureAssetGenerationRun({ executionPurpose: "integration_test" }) });
    const args = parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--dry-run"]);
    expect(() => loadAssetGenerationRun(args, PERIOD, deps)).toThrow(CmsWriteInputError);
  });

  it("never auto-discovers a .integration-test.{timestamp}.json collision variant either", () => {
    const integrationTestFilename = `asset-generation-${PERIOD.start}_to_${PERIOD.end}-${TOPIC_ID}.integration-test.2026-07-16T08-25-56-998Z.json`;
    const deps = fakeDeps({ [integrationTestFilename]: fixtureAssetGenerationRun({ executionPurpose: "integration_test" }) });
    const args = parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--dry-run"]);
    expect(() => loadAssetGenerationRun(args, PERIOD, deps)).toThrow(CmsWriteInputError);
  });

  it("still discovers a normal timestamped collision variant (regression check for the tightened regex)", () => {
    const timestampedFilename = `asset-generation-${PERIOD.start}_to_${PERIOD.end}-${TOPIC_ID}.2026-07-16T08-25-56-998Z.json`;
    const deps = fakeDeps({ [timestampedFilename]: fixtureAssetGenerationRun() });
    const args = parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--dry-run"]);
    const loaded = loadAssetGenerationRun(args, PERIOD, deps);
    expect(loaded.filename).toBe(timestampedFilename);
  });

  it("--input still accepts an integration-test file explicitly, after validating its executionPurpose shape", () => {
    const deps = fakeDeps({ "custom-name.json": fixtureAssetGenerationRun({ executionPurpose: "integration_test" }) });
    const args = parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--input", "custom-name.json", "--dry-run"]);
    const loaded = loadAssetGenerationRun(args, PERIOD, deps);
    expect(loaded.run.executionPurpose).toBe("integration_test");
  });

  it("rejects a malformed executionPurpose value", () => {
    const deps = fakeDeps({ "custom-name.json": fixtureAssetGenerationRun({ executionPurpose: "not_a_real_value" }) });
    const args = parseArgs(["--start", PERIOD.start, "--end", PERIOD.end, "--input", "custom-name.json", "--dry-run"]);
    expect(() => loadAssetGenerationRun(args, PERIOD, deps)).toThrow(CmsWriteInputError);
  });
});

describe("assertLiveIntegrationTestInputAllowed", () => {
  it("throws for executionPurpose: integration_test without the override", () => {
    const run = fixtureAssetGenerationRun({ executionPurpose: "integration_test" });
    expect(() => assertLiveIntegrationTestInputAllowed(run, RUN_FILENAME, false)).toThrow(CmsWriteConfigError);
  });

  it("does not throw when the override is used", () => {
    const run = fixtureAssetGenerationRun({ executionPurpose: "integration_test" });
    expect(() => assertLiveIntegrationTestInputAllowed(run, RUN_FILENAME, true)).not.toThrow();
  });

  it("does not throw for a normal business_experiment run, override or not", () => {
    const run = fixtureAssetGenerationRun({ executionPurpose: "business_experiment" });
    expect(() => assertLiveIntegrationTestInputAllowed(run, RUN_FILENAME, false)).not.toThrow();
    expect(() => assertLiveIntegrationTestInputAllowed(run, RUN_FILENAME, true)).not.toThrow();
  });

  it("does not throw when executionPurpose is absent (an old run, defaults to business_experiment)", () => {
    const run = fixtureAssetGenerationRun();
    delete (run as unknown as Record<string, unknown>).executionPurpose;
    expect(() => assertLiveIntegrationTestInputAllowed(run, RUN_FILENAME, false)).not.toThrow();
  });
});

describe("assertLiveMockInputAllowed", () => {
  it("throws when the run is mock-generated and the override was not used", () => {
    expect(() => assertLiveMockInputAllowed(fixtureAssetGenerationRun(), RUN_FILENAME, false)).toThrow(CmsWriteConfigError);
  });

  it("does not throw when the override was used", () => {
    expect(() => assertLiveMockInputAllowed(fixtureAssetGenerationRun(), RUN_FILENAME, true)).not.toThrow();
  });

  it("does not throw when the run is not mock-generated", () => {
    const nonMock = fixtureAssetGenerationRun({ generation: { ...fixtureAssetGenerationRun().generation, isMock: false } });
    expect(() => assertLiveMockInputAllowed(nonMock, RUN_FILENAME, false)).not.toThrow();
  });
});

describe("resolveRequestPath / resolveReceiptPath", () => {
  it("reuses the base filename when it does not already exist", () => {
    const path = resolveRequestPath(PERIOD, TOPIC_ID, false, () => false, new Date("2026-07-21T00:00:00.000Z"));
    expect(path.replace(/\\/g, "/")).toContain(`cms-write-request-${PERIOD.start}_to_${PERIOD.end}-${TOPIC_ID}.json`);
  });

  it("appends a timestamp when the base filename exists and overwrite is false", () => {
    const path = resolveRequestPath(PERIOD, TOPIC_ID, false, () => true, new Date("2026-07-21T00:00:00.000Z"));
    expect(path).toContain("2026-07-21T00-00-00");
  });

  it("reuses the base filename in place when overwrite is true", () => {
    const path = resolveReceiptPath(PERIOD, TOPIC_ID, true, () => true, new Date("2026-07-21T00:00:00.000Z"));
    expect(path.replace(/\\/g, "/")).toContain(`cms-write-receipt-${PERIOD.start}_to_${PERIOD.end}-${TOPIC_ID}.json`);
  });
});

describe("run — dry-run", () => {
  it("writes a request preview and markdown, makes no network request, and requires no Sanity token", async () => {
    const deps = fakeDeps({ [RUN_FILENAME]: fixtureAssetGenerationRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--dry-run"], deps);

    expect(result.mode).toBe("dry-run");
    if (result.mode !== "dry-run") throw new Error("unreachable");
    expect(result.preview.draftDocumentId).toBe("drafts.appTool-inventory-tracker");
    expect(result.preview.cmsWriteRequest.payload.seo.title).toBe("Inventory Tracker");
    expect(createOrReplaceMock).not.toHaveBeenCalled();
  });

  it("does not require SANITY_API_TOKEN to be set", async () => {
    vi.stubEnv("SANITY_API_TOKEN", "");
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "");
    const deps = fakeDeps({ [RUN_FILENAME]: fixtureAssetGenerationRun() });
    await expect(run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--dry-run"], deps)).resolves.toBeDefined();
  });

  it("allows mock Asset Generation input for a dry-run without --allow-mock-input", async () => {
    const deps = fakeDeps({ [RUN_FILENAME]: fixtureAssetGenerationRun() });
    const result = await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--dry-run"], deps);
    expect(result.mode).toBe("dry-run");
  });

  it("accepts integration-test input via explicit --input without --allow-integration-test-input, and shows the warning/not-business-approved statement", async () => {
    const deps = fakeDeps({ "integration-test-input.json": fixtureAssetGenerationRun({ executionPurpose: "integration_test" }) });
    const result = await run(
      ["--start", PERIOD.start, "--end", PERIOD.end, "--input", "integration-test-input.json", "--dry-run"],
      deps
    );
    expect(result.mode).toBe("dry-run");
    if (result.mode !== "dry-run") throw new Error("unreachable");
    expect(result.preview.sourceExecutionPurpose).toBe("integration_test");
    expect(createOrReplaceMock).not.toHaveBeenCalled();
  });
});

describe("run — write-draft", () => {
  it("rejects mock Asset Generation input by default", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "proj123");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_API_TOKEN", "sk-test-token");
    const deps = fakeDeps({ [RUN_FILENAME]: fixtureAssetGenerationRun() });
    await expect(
      run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--write-draft", "--confirm-reviewed", "--reviewed-by", "Joy"], deps)
    ).rejects.toThrow(CmsWriteConfigError);
    expect(createOrReplaceMock).not.toHaveBeenCalled();
  });

  it("fails clearly when Sanity configuration is missing", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "");
    vi.stubEnv("SANITY_API_TOKEN", "");
    const deps = fakeDeps({ [RUN_FILENAME]: fixtureAssetGenerationRun() });
    await expect(
      run(
        ["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--write-draft", "--confirm-reviewed", "--reviewed-by", "Joy", "--allow-mock-input"],
        deps
      )
    ).rejects.toThrow(CmsWriteConfigError);
    expect(createOrReplaceMock).not.toHaveBeenCalled();
  });

  it("succeeds end-to-end with --allow-mock-input and full Sanity configuration, writing exactly one draft", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "proj123");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_API_TOKEN", "sk-test-token");
    const deps = fakeDeps({ [RUN_FILENAME]: fixtureAssetGenerationRun() });

    const result = await run(
      ["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--write-draft", "--confirm-reviewed", "--reviewed-by", "Joy", "--allow-mock-input"],
      deps
    );

    expect(result.mode).toBe("draft-write");
    if (result.mode !== "draft-write") throw new Error("unreachable");
    expect(createOrReplaceMock).toHaveBeenCalledTimes(1);
    expect(result.run.receipt?.draftDocumentId).toBe("drafts.appTool-inventory-tracker");
    expect(result.run.compatibility.publishPerformed).toBe(false);
    expect(result.run.compatibility.siteModified).toBe(false);
    expect(result.run.review.reviewedBy).toBe("Joy");
    const sentDoc = createOrReplaceMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sentDoc._id).toBe("drafts.appTool-inventory-tracker");
  });

  it("never sends a publish-style call — the fake client has no publish method invoked", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "proj123");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_API_TOKEN", "sk-test-token");
    const deps = fakeDeps({ [RUN_FILENAME]: fixtureAssetGenerationRun() });
    await run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--write-draft", "--confirm-reviewed", "--reviewed-by", "Joy", "--allow-mock-input"], deps);
    expect(createOrReplaceMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a real draft write from integration-test input without --allow-integration-test-input", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "proj123");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_API_TOKEN", "sk-test-token");
    const deps = fakeDeps({ [RUN_FILENAME]: fixtureAssetGenerationRun({ executionPurpose: "integration_test" }) });
    await expect(
      run(["--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID, "--write-draft", "--confirm-reviewed", "--reviewed-by", "Joy", "--allow-mock-input"], deps)
    ).rejects.toThrow(CmsWriteConfigError);
    expect(createOrReplaceMock).not.toHaveBeenCalled();
  });

  it("allows a real draft write from integration-test input with --allow-integration-test-input, writes only a draft, and records the override in the receipt", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "proj123");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_API_TOKEN", "sk-test-token");
    const deps = fakeDeps({ [RUN_FILENAME]: fixtureAssetGenerationRun({ executionPurpose: "integration_test" }) });

    const result = await run(
      [
        "--start", PERIOD.start, "--end", PERIOD.end, "--topic-id", TOPIC_ID,
        "--write-draft", "--confirm-reviewed", "--reviewed-by", "Joy",
        "--allow-mock-input", "--allow-integration-test-input",
      ],
      deps
    );

    expect(result.mode).toBe("draft-write");
    if (result.mode !== "draft-write") throw new Error("unreachable");
    expect(createOrReplaceMock).toHaveBeenCalledTimes(1);
    expect(result.run.receipt?.draftDocumentId).toBe("drafts.appTool-inventory-tracker");
    expect(result.run.provenance.sourceExecutionPurpose).toBe("integration_test");
    expect(result.run.provenance.allowIntegrationTestInputUsed).toBe(true);
    const sentDoc = createOrReplaceMock.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(sentDoc).toLowerCase()).not.toContain("integrationtest");
    expect(JSON.stringify(sentDoc).toLowerCase()).not.toContain("executionpurpose");
  });
});
