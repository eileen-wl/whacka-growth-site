import { describe, expect, it, vi } from "vitest";
import { buildCmsWriteDryRunPreview, CmsWriterValidationError, runCmsWriter } from "../cms/cms-writer";
import { AssetBundleValidationError, buildAssetBundleId } from "../contracts/asset-bundle";
import type { SanityWriteClient } from "../cms/sanity-draft-writer";
import type { AssetBundle } from "../contracts/asset-bundle";
import type { FinalAssetGenerationRun } from "../types/asset-generation";
import type { TopicCandidate } from "../contracts/topic-candidate";
import type { ScoredTopic } from "../contracts/scored-topic";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureTopic(): TopicCandidate {
  return {
    schemaVersion: "1.0.0",
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
    evidenceSummary: { signalCount: 1, sourceCount: 1, sourceTypes: ["ga4"], confidence: "medium", limitations: [] },
    relationshipToExistingContent: { status: "new", relatedTopicIds: [], relatedAppSlugs: [] },
    status: "candidate",
    rejection: null,
    provenance: { generatedBy: "signal-mining-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["signal_1"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
  };
}

function fixtureScoredTopic(): ScoredTopic {
  return {
    schemaVersion: "1.0.0",
    id: "scoredtopic_abc",
    topicId: "topic_abc",
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
    provenance: { generatedBy: "topic-scoring-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["topic_abc"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
  };
}

function fixtureAssetBundle(overrides: Partial<AssetBundle> = {}): AssetBundle {
  return {
    schemaVersion: "1.0.0",
    id: buildAssetBundleId({ scoredTopicId: "scoredtopic_abc", promptVersion: "1.0.0" }),
    scoredTopicId: "scoredtopic_abc",
    topicId: "topic_abc",
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
    creativeBrief: { hook: "Never run out of stock again.", persona: "Small shop owner", scenario: "Managing stock between customers.", steps: ["Log stock — enter counts."] },
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
    generation: { provider: "mock", model: "mock-v0", isMock: true, promptVersion: "1.0.0", evidenceRefs: [], signalRefs: ["signal_1"], findingRefs: [] },
    validation: { status: "needs_review", warnings: ["Source Topic Scoring run was mock-generated (generation.isMock = true)."], humanReviewRequired: true },
    provenance: { generatedBy: "asset-generation-agent", sourceFileNames: ["topic-scoring-x.json"], sourceHashes: ["hash"], sourceRecordIds: ["scoredtopic_abc"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
    ...overrides,
  };
}

function fixtureAssetGenerationRun(overrides: Partial<FinalAssetGenerationRun> = {}): FinalAssetGenerationRun {
  return {
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
      selectedTopicId: "topic_abc",
      selectedScoredTopicId: "scoredtopic_abc",
      allowMockInputUsed: false,
      allowUnapprovedTopicUsed: false,
      allowHoldTopicUsed: false,
    },
    generation: { provider: "mock", model: "mock-v0", language: "en", promptVersion: "1.0.0", isMock: true, requestId: null, stopReason: "end_turn", usage: { inputTokens: null, outputTokens: null } },
    selectedTopic: fixtureTopic(),
    selectedScoredTopic: fixtureScoredTopic(),
    assetBundle: fixtureAssetBundle(),
    compatibility: { sanityAppToolCompatible: true, astroAppDataCompatible: true, seoPersistenceAvailable: true, cmsWritePerformed: false, siteModified: false, warnings: [] },
    humanReview: { required: true, approved: false, approvedBy: null, approvedAt: null, note: "AssetBundle must be reviewed before CMS Writer creates a Sanity draft." },
    dataQuality: { overallStatus: "partial", warnings: [], limitations: [] },
    ...overrides,
  };
}

describe("runCmsWriter — integration-test provenance", () => {
  it("defaults sourceExecutionPurpose to business_experiment and allowIntegrationTestInputUsed to false when unspecified", async () => {
    const run = await runCmsWriter({
      run: fixtureAssetGenerationRun(),
      sourceFilename: "f.json",
      sourceSha256: "abc123",
      mode: "dry_run",
      review: { reviewedBy: null, reviewNote: null },
      allowMockInputUsed: false,
    });
    expect(run.provenance.sourceExecutionPurpose).toBe("business_experiment");
    expect(run.provenance.allowIntegrationTestInputUsed).toBe(false);
  });

  it("carries executionPurpose: integration_test through into provenance, and records the override flag", async () => {
    const run = await runCmsWriter({
      run: fixtureAssetGenerationRun({ executionPurpose: "integration_test" }),
      sourceFilename: "f.json",
      sourceSha256: "abc123",
      mode: "dry_run",
      review: { reviewedBy: null, reviewNote: null },
      allowMockInputUsed: false,
      allowIntegrationTestInputUsed: true,
    });
    expect(run.provenance.sourceExecutionPurpose).toBe("integration_test");
    expect(run.provenance.allowIntegrationTestInputUsed).toBe(true);
  });

  it("never includes integration-test metadata in the appTool payload itself", async () => {
    const run = await runCmsWriter({
      run: fixtureAssetGenerationRun({ executionPurpose: "integration_test" }),
      sourceFilename: "f.json",
      sourceSha256: "abc123",
      mode: "dry_run",
      review: { reviewedBy: null, reviewNote: null },
      allowMockInputUsed: false,
      allowIntegrationTestInputUsed: true,
    });
    const payloadKeys = Object.keys(run.cmsWriteRequest.payload);
    expect(payloadKeys).not.toContain("executionPurpose");
    expect(payloadKeys).not.toContain("integrationTestReview");
    expect(JSON.stringify(run.cmsWriteRequest.payload).toLowerCase()).not.toContain("integrationtest");
  });
});

describe("runCmsWriter — dry_run", () => {
  it("builds a FinalCmsWriterRun with mode dry_run, writeStatus not_attempted, and a null receipt", async () => {
    const run = await runCmsWriter({
      run: fixtureAssetGenerationRun(),
      sourceFilename: "asset-generation-2026-07-08_to_2026-07-14-topic_abc.json",
      sourceSha256: "abc123",
      mode: "dry_run",
      review: { reviewedBy: null, reviewNote: null },
      allowMockInputUsed: false,
    });

    expect(run.mode).toBe("dry_run");
    expect(run.writeStatus).toBe("not_attempted");
    expect(run.receipt).toBeNull();
  });

  it("never requires a Sanity client for dry_run", async () => {
    await expect(
      runCmsWriter({
        run: fixtureAssetGenerationRun(),
        sourceFilename: "f.json",
        sourceSha256: "abc123",
        mode: "dry_run",
        review: { reviewedBy: null, reviewNote: null },
        allowMockInputUsed: false,
      })
    ).resolves.toBeDefined();
  });

  it("sets compatibility.seoPersistenceAvailable and faqMappingAvailable to true", async () => {
    const run = await runCmsWriter({
      run: fixtureAssetGenerationRun(),
      sourceFilename: "f.json",
      sourceSha256: "abc123",
      mode: "dry_run",
      review: { reviewedBy: null, reviewNote: null },
      allowMockInputUsed: false,
    });
    expect(run.compatibility.seoPersistenceAvailable).toBe(true);
    expect(run.compatibility.faqMappingAvailable).toBe(true);
    expect(run.compatibility.publishPerformed).toBe(false);
    expect(run.compatibility.siteModified).toBe(false);
    expect(run.compatibility.draftOnly).toBe(true);
  });

  it("marks review.confirmedReviewed as false for dry_run even if reviewer info is supplied", async () => {
    const run = await runCmsWriter({
      run: fixtureAssetGenerationRun(),
      sourceFilename: "f.json",
      sourceSha256: "abc123",
      mode: "dry_run",
      review: { reviewedBy: "Joy", reviewNote: "looks good" },
      allowMockInputUsed: false,
    });
    expect(run.review.confirmedReviewed).toBe(false);
    expect(run.review.reviewedBy).toBe("Joy");
  });

  it("rejects an AssetBundle whose app.status is not draft (the AssetBundle contract itself pins app.status to the literal 'draft', so this is caught by validateAssetBundle before CMS Writer's own defense-in-depth check ever runs)", async () => {
    const run = fixtureAssetGenerationRun({ assetBundle: fixtureAssetBundle({ app: { ...fixtureAssetBundle().app, status: "published" as never } }) });
    await expect(
      runCmsWriter({ run, sourceFilename: "f.json", sourceSha256: "abc123", mode: "dry_run", review: { reviewedBy: null, reviewNote: null }, allowMockInputUsed: false })
    ).rejects.toThrow(AssetBundleValidationError);
  });

  it("throws for draft_write mode without a Sanity client instead of silently writing", async () => {
    await expect(
      runCmsWriter({
        run: fixtureAssetGenerationRun(),
        sourceFilename: "f.json",
        sourceSha256: "abc123",
        mode: "draft_write",
        review: { reviewedBy: "Joy", reviewNote: null },
        allowMockInputUsed: false,
      })
    ).rejects.toThrow(CmsWriterValidationError);
  });
});

describe("runCmsWriter — draft_write", () => {
  function fakeClient(): { client: SanityWriteClient; createOrReplace: ReturnType<typeof vi.fn> } {
    const createOrReplace = vi.fn(async (doc: Record<string, unknown>) => ({
      _id: doc._id as string,
      _rev: "rev1",
      _createdAt: "2026-07-20T00:00:00.000Z",
      _updatedAt: "2026-07-20T00:00:00.000Z",
    }));
    return { client: { createOrReplace }, createOrReplace };
  }

  it("writes exactly once, to the drafts.-prefixed id, and populates a sanitized receipt", async () => {
    const { client, createOrReplace } = fakeClient();
    const run = await runCmsWriter({
      run: fixtureAssetGenerationRun(),
      sourceFilename: "f.json",
      sourceSha256: "abc123",
      mode: "draft_write",
      dataset: "production",
      review: { reviewedBy: "Joy", reviewNote: "Reviewed content, ready for a draft." },
      allowMockInputUsed: false,
      sanityClient: client,
      projectId: "proj123",
      apiVersion: "2024-01-01",
    });

    expect(createOrReplace).toHaveBeenCalledTimes(1);
    expect(run.writeStatus).toBe("succeeded");
    expect(run.receipt).not.toBeNull();
    expect(run.receipt?.draftDocumentId).toBe("drafts.appTool-inventory-tracker");
    expect(run.receipt?.canonicalDocumentId).toBe("appTool-inventory-tracker");
    expect(run.review.confirmedReviewed).toBe(true);
    expect(run.review.reviewedBy).toBe("Joy");
  });

  it("never includes a token/credential field anywhere in the receipt", async () => {
    const { client } = fakeClient();
    const run = await runCmsWriter({
      run: fixtureAssetGenerationRun(),
      sourceFilename: "f.json",
      sourceSha256: "abc123",
      mode: "draft_write",
      dataset: "production",
      review: { reviewedBy: "Joy", reviewNote: null },
      allowMockInputUsed: false,
      sanityClient: client,
      projectId: "proj123",
      apiVersion: "2024-01-01",
    });
    const serialized = JSON.stringify(run);
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("authorization");
  });
});

describe("buildCmsWriteDryRunPreview", () => {
  it("derives a preview with the draft id, canonical id, and no network-request claim", async () => {
    const run = await runCmsWriter({
      run: fixtureAssetGenerationRun(),
      sourceFilename: "asset-generation-2026-07-08_to_2026-07-14-topic_abc.json",
      sourceSha256: "abc123",
      mode: "dry_run",
      review: { reviewedBy: null, reviewNote: null },
      allowMockInputUsed: false,
    });
    const preview = buildCmsWriteDryRunPreview(run, { allowMockInputUsed: false });

    expect(preview.source).toBe("cms_writer_dry_run");
    expect(preview.draftDocumentId).toBe("drafts.appTool-inventory-tracker");
    expect(preview.canonicalDocumentId).toBe("appTool-inventory-tracker");
    expect(preview.confirmation.toLowerCase()).toContain("no cms write");
    expect(preview.sourceExecutionPurpose).toBe("business_experiment");
  });

  it("surfaces sourceExecutionPurpose: integration_test on the dry-run preview when the source run was an integration test", async () => {
    const run = await runCmsWriter({
      run: fixtureAssetGenerationRun({ executionPurpose: "integration_test" }),
      sourceFilename: "f.json",
      sourceSha256: "abc123",
      mode: "dry_run",
      review: { reviewedBy: null, reviewNote: null },
      allowMockInputUsed: false,
    });
    const preview = buildCmsWriteDryRunPreview(run, { allowMockInputUsed: false });
    expect(preview.sourceExecutionPurpose).toBe("integration_test");
  });
});
