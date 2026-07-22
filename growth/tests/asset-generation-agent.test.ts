import { describe, expect, it } from "vitest";
import {
  AssetGenerationInputError,
  AssetGenerationSlugError,
  AssetGenerationValidationError,
  assembleAssetBundle,
  buildAssetGenerationContext,
  buildExistingAppCatalog,
  buildFinalAssetBundleId,
  computeValidationStatus,
  resolveCtaAndUrls,
  resolveFinalSlug,
  resolveSelectedTopic,
  runAssetGenerationAgent,
  validateAssetGenerationAnalysis,
} from "../agents/asset-generation-agent";
import type { AssetGenerationProvider } from "../llm/asset-generation-provider";
import type { AssetGenerationAnalysis } from "../types/asset-generation";
import type { ScoringDimensionKey } from "../types/topic-scoring";
import type { FinalTopicScoringRun } from "../types/topic-scoring";
import type { LLMStructuredResult } from "../types/llm";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureDimension(key: ScoringDimensionKey, overrides: Record<string, unknown> = {}) {
  return {
    key,
    label: key,
    score: 60,
    weight: 0.1,
    weightedScore: 6,
    rationale: "x",
    signalRefs: ["signal_1"],
    evidenceRefs: [],
    limitations: [],
    scoreBasis: "evidence" as const,
    ...overrides,
  };
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

  const scoredTopic = {
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
    totalScore: 72,
    ranking: { rank: 1, candidateCount: 1 },
    confidence: "high" as const,
    recommendation: "advance" as const,
    blockers: [] as string[],
    humanReviewRequired: true as const,
    provenance: { generatedBy: "topic-scoring-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["topic_abc"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
  };

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
    scoredTopics: [scoredTopic],
    ranking: { candidateCount: 1, rankedTopicIds: ["topic_abc"], topTopicId: "topic_abc", advanceCount: 1, needsHumanReviewCount: 0, holdCount: 0, rejectCount: 0 },
    portfolioObservations: { topicCoverage: "1 of 1 assessed.", evidenceCoverage: "Grounded.", majorLimitations: [], requiresHumanReview: true },
    confidenceAdjustments: [],
    humanReview: { required: true, approved: false, selectedTopicIds: [], approvedBy: null, approvedAt: null, note: "x" },
    dataQuality: { overallStatus: "partial", warnings: [], limitations: [] },
    ...overrides,
  };
}

function fixtureAnalysis(overrides: Partial<AssetGenerationAnalysis> = {}): AssetGenerationAnalysis {
  return {
    appConcept: {
      name: "Inventory Tracker",
      slugSuggestion: "inventory-tracker",
      category: "Mini App Concept",
      tagline: "Track stock without a spreadsheet.",
      shortDescription: "A focused tool for small shops to track stock.",
      problem: "Small shops lose track of stock.",
      solution: "Log stock counts in one place.",
      whoItsFor: ["Small retail shop owners"],
      steps: [{ title: "Log stock", description: "Enter stock counts per product." }],
      appPrompt: "Build a mini app called Inventory Tracker for a small shop to track stock levels.",
      creativeBrief: { hook: "Never run out of stock again.", persona: "Small shop owner", scenario: "Managing stock between customers.", assumptions: [], limitations: [] },
    },
    seo: { title: "Inventory Tracker", metaDescription: "Track stock levels without a spreadsheet.", primaryKeyword: "inventory tracker", secondaryKeywords: ["stock tracker"], faq: [] },
    cta: {
      primaryType: "build",
      labels: { primary: "Build Inventory Tracker with Whacka", viewDemo: null, remix: null, build: "Build Inventory Tracker with Whacka", copyPrompt: null },
      rationale: "Build is the safest, always-available CTA.",
    },
    socialPosts: [],
    generationNotes: { topicAlignment: "Directly addresses the stated problem.", differentiationFromExistingApps: "No existing app covers this.", assumptions: [], limitations: [], requiresHumanReview: true },
    ...overrides,
  };
}

class FakeProvider implements AssetGenerationProvider {
  readonly name: string;
  constructor(
    private readonly analysis: AssetGenerationAnalysis,
    name = "fake"
  ) {
    this.name = name;
  }
  async generateStructuredAssets(): Promise<LLMStructuredResult<AssetGenerationAnalysis>> {
    return { data: this.analysis, provider: this.name, model: "fake-model", requestId: null, stopReason: "end_turn", inputTokens: null, outputTokens: null };
  }
}

describe("buildExistingAppCatalog", () => {
  it("uses actual current app data, includes the real 5 apps", () => {
    const catalog = buildExistingAppCatalog();
    expect(catalog.map((a) => a.slug).sort()).toEqual(["bookly", "cardsnap", "clientflow", "orderly", "quotewave"]);
  });

  it("has no duplicate slugs", () => {
    const catalog = buildExistingAppCatalog();
    const slugs = catalog.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("resolveSelectedTopic", () => {
  it("resolves the topic and scored topic together", () => {
    const run = fixtureTopicScoringRun();
    const { topic, scoredTopic } = resolveSelectedTopic(run, "topic_abc");
    expect(topic.id).toBe("topic_abc");
    expect(scoredTopic.topicId).toBe("topic_abc");
  });

  it("throws AssetGenerationInputError for an unknown topic ID", () => {
    const run = fixtureTopicScoringRun();
    expect(() => resolveSelectedTopic(run, "topic_unknown")).toThrow(AssetGenerationInputError);
  });

  it("throws AssetGenerationInputError when the topic exists but has no ScoredTopic", () => {
    const run = fixtureTopicScoringRun({ scoredTopics: [] });
    expect(() => resolveSelectedTopic(run, "topic_abc")).toThrow(AssetGenerationInputError);
  });

  it("throws for a zero-topic run when a topic is requested", () => {
    const run = fixtureTopicScoringRun({ topicCatalog: [], scoredTopics: [] });
    expect(() => resolveSelectedTopic(run, "topic_abc")).toThrow(AssetGenerationInputError);
  });
});

describe("buildAssetGenerationContext", () => {
  it("includes only the selected topic's own content, score, rank, and dimensions", () => {
    const run = fixtureTopicScoringRun();
    const { topic, scoredTopic } = resolveSelectedTopic(run, "topic_abc");
    const context = buildAssetGenerationContext({ run, topic, scoredTopic, language: "en", requestedSocialChannels: [], existingAppCatalog: [] });
    expect(context.topicId).toBe("topic_abc");
    expect(context.totalScore).toBe(72);
    expect(context.rank).toBe(1);
    expect(context.dimensions).toHaveLength(7);
  });

  it("preserves source mock/human-review status from the run", () => {
    const run = fixtureTopicScoringRun();
    const { topic, scoredTopic } = resolveSelectedTopic(run, "topic_abc");
    const context = buildAssetGenerationContext({ run, topic, scoredTopic, language: "en", requestedSocialChannels: [], existingAppCatalog: [] });
    expect(context.sourceScoringIsMock).toBe(true);
    expect(context.sourceTopicsHumanReviewed).toBe(false);
  });

  it("carries the exact requested social channels through", () => {
    const run = fixtureTopicScoringRun();
    const { topic, scoredTopic } = resolveSelectedTopic(run, "topic_abc");
    const context = buildAssetGenerationContext({ run, topic, scoredTopic, language: "en", requestedSocialChannels: ["linkedin"], existingAppCatalog: [] });
    expect(context.requestedSocialChannels).toEqual(["linkedin"]);
  });
});

describe("validateAssetGenerationAnalysis", () => {
  it("accepts a well-formed analysis with zero requested channels and zero posts", () => {
    expect(() => validateAssetGenerationAnalysis(fixtureAnalysis(), [])).not.toThrow();
  });

  it("rejects a social post for a channel that was not requested", () => {
    const analysis = fixtureAnalysis({ socialPosts: [{ channel: "linkedin", variant: "v1", copy: "Post copy." }] });
    expect(() => validateAssetGenerationAnalysis(analysis, [])).toThrow(AssetGenerationValidationError);
  });

  it("accepts a social post for a requested channel", () => {
    const analysis = fixtureAnalysis({ socialPosts: [{ channel: "linkedin", variant: "v1", copy: "Post copy." }] });
    expect(() => validateAssetGenerationAnalysis(analysis, ["linkedin"])).not.toThrow();
  });

  it("rejects an unknown top-level key (e.g. a smuggled URL field)", () => {
    const raw = { ...fixtureAnalysis(), demoUrl: "https://example.com" };
    expect(() => validateAssetGenerationAnalysis(raw, [])).toThrow(AssetGenerationValidationError);
  });

  it("rejects a missing appPrompt", () => {
    const raw = { ...fixtureAnalysis() };
    // @ts-expect-error intentional malformed input
    delete raw.appConcept.appPrompt;
    expect(() => validateAssetGenerationAnalysis(raw, [])).toThrow(AssetGenerationValidationError);
  });
});

describe("resolveFinalSlug", () => {
  it("normalizes uppercase and spaces into lowercase kebab-case", () => {
    const result = resolveFinalSlug("Inventory Tracker Pro", "topic_abc", new Set());
    expect(result.slug).toBe("inventory-tracker-pro");
    expect(result.conflicted).toBe(false);
  });

  it("resolves a conflict with an existing app slug deterministically", () => {
    const existing = new Set(["orderly"]);
    const result = resolveFinalSlug("Orderly", "topic_abc", existing);
    expect(result.conflicted).toBe(true);
    expect(result.slug).not.toBe("orderly");
    expect(result.slug.startsWith("orderly-")).toBe(true);
    expect(result.originalSuggestion).toBe("Orderly");
  });

  it("is deterministic — same topic ID and suggestion always produce the same alternative", () => {
    const existing = new Set(["orderly"]);
    const a = resolveFinalSlug("Orderly", "topic_abc", existing);
    const b = resolveFinalSlug("Orderly", "topic_abc", existing);
    expect(a.slug).toBe(b.slug);
  });

  it("throws AssetGenerationSlugError when the suggestion normalizes to empty", () => {
    expect(() => resolveFinalSlug("!!!", "topic_abc", new Set())).toThrow(AssetGenerationSlugError);
  });

  it("does not mutate the existingSlugs set", () => {
    const existing = new Set(["orderly"]);
    resolveFinalSlug("Orderly", "topic_abc", existing);
    expect(existing).toEqual(new Set(["orderly"]));
  });
});

describe("buildFinalAssetBundleId", () => {
  it("is deterministic for identical inputs", () => {
    const a = buildFinalAssetBundleId({ campaignId: "c", topicId: "t", finalSlug: "s", language: "en", promptVersion: "1.0.0" });
    const b = buildFinalAssetBundleId({ campaignId: "c", topicId: "t", finalSlug: "s", language: "en", promptVersion: "1.0.0" });
    expect(a).toBe(b);
  });

  it("differs across language, so regenerating in a different language never collides", () => {
    const en = buildFinalAssetBundleId({ campaignId: "c", topicId: "t", finalSlug: "s", language: "en", promptVersion: "1.0.0" });
    const zh = buildFinalAssetBundleId({ campaignId: "c", topicId: "t", finalSlug: "s", language: "zh-CN", promptVersion: "1.0.0" });
    expect(en).not.toBe(zh);
  });
});

describe("resolveCtaAndUrls", () => {
  const cta = fixtureAnalysis().cta;

  it("resolves buildUrl to the real shared dashboard destination, always", () => {
    const result = resolveCtaAndUrls(cta, "inventory-tracker");
    expect(result.cta.buildUrl).toBe("https://whacka.app/dashboard");
  });

  it("never generates a demoUrl or remixUrl", () => {
    const result = resolveCtaAndUrls(cta, "inventory-tracker");
    expect(result.cta.demoUrl).toBeNull();
    expect(result.cta.remixUrl).toBeNull();
  });

  it("sets ctaHref to the real buildUrl when primaryType is 'build'", () => {
    const result = resolveCtaAndUrls(cta, "inventory-tracker");
    expect(result.ctaHref).toBe("https://whacka.app/dashboard");
  });

  it("sets ctaHref to the existing '#' no-target convention when primaryType is not 'build'", () => {
    const result = resolveCtaAndUrls({ ...cta, primaryType: "view_demo" }, "inventory-tracker");
    expect(result.ctaHref).toBe("#");
  });

  it("sets utmContent to the final slug deterministically", () => {
    const result = resolveCtaAndUrls(cta, "inventory-tracker");
    expect(result.cta.utmContent).toBe("inventory-tracker");
  });
});

describe("computeValidationStatus", () => {
  const baseCtx = {
    sourceIsMock: false,
    topicHumanReviewed: true,
    allowUnapprovedTopicUsed: false,
    allowHoldTopicUsed: false,
    recommendation: "advance",
    hasAssumptionsOrLimitations: false,
    primaryCtaUrlAvailable: true,
    generationIsMock: false,
  };

  it("returns valid when every review trigger is clean (SEO persistence is no longer a blocker)", () => {
    expect(computeValidationStatus(baseCtx).status).toBe("valid");
    expect(computeValidationStatus(baseCtx).reasons).toEqual([]);
  });

  it("includes a reason for mock source input", () => {
    const result = computeValidationStatus({ ...baseCtx, sourceIsMock: true });
    expect(result.reasons.some((r) => r.toLowerCase().includes("mock-generated"))).toBe(true);
  });

  it("includes a reason for unapproved topics", () => {
    const result = computeValidationStatus({ ...baseCtx, topicHumanReviewed: false });
    expect(result.reasons.some((r) => r.toLowerCase().includes("human-approved"))).toBe(true);
  });

  it("includes a reason when the primary CTA has no real URL", () => {
    const result = computeValidationStatus({ ...baseCtx, primaryCtaUrlAvailable: false });
    expect(result.reasons.some((r) => r.toLowerCase().includes("no real url"))).toBe(true);
  });

  it("forces needs_review when integrationTestActive is true, even if every other trigger is clean", () => {
    const result = computeValidationStatus({ ...baseCtx, integrationTestActive: true });
    expect(result.status).toBe("needs_review");
    expect(result.reasons.some((r) => r.toLowerCase().includes("integration-test"))).toBe(true);
  });

  it("defaults integrationTestActive to false when omitted (unchanged existing behavior)", () => {
    expect(computeValidationStatus(baseCtx).status).toBe("valid");
  });
});

describe("assembleAssetBundle", () => {
  const provenance = { sourceFileNames: ["topic-scoring-x.json"], sourceHashes: ["hash"], provider: "fake", model: "fake-model", isMock: false };

  function buildContext() {
    const run = fixtureTopicScoringRun();
    const { topic, scoredTopic } = resolveSelectedTopic(run, "topic_abc");
    return buildAssetGenerationContext({ run, topic, scoredTopic, language: "en", requestedSocialChannels: [], existingAppCatalog: [] });
  }

  it("produces a contract-valid AssetBundle", () => {
    const context = buildContext();
    const bundle = assembleAssetBundle({
      analysis: fixtureAnalysis(),
      context,
      finalSlug: "inventory-tracker",
      slugConflicted: false,
      slugOriginalSuggestion: "inventory-tracker",
      campaignId: CAMPAIGN.id,
      generatedAt: "2026-07-16T00:00:00.000Z",
      promptVersion: "1.0.0",
      provenance,
      allowUnapprovedTopicUsed: false,
      allowHoldTopicUsed: false,
    });
    expect(bundle.schemaVersion).toBe("1.0.0");
    expect(bundle.topicId).toBe("topic_abc");
    expect(bundle.scoredTopicId).toBe("scoredtopic_abc");
    expect(bundle.app.status).toBe("draft");
  });

  it("does not include the obsolete SEO persistence warning", () => {
    const context = buildContext();
    const bundle = assembleAssetBundle({
      analysis: fixtureAnalysis(),
      context,
      finalSlug: "inventory-tracker",
      slugConflicted: false,
      slugOriginalSuggestion: "inventory-tracker",
      campaignId: CAMPAIGN.id,
      generatedAt: "2026-07-16T00:00:00.000Z",
      promptVersion: "1.0.0",
      provenance,
      allowUnapprovedTopicUsed: false,
      allowHoldTopicUsed: false,
    });
    expect(bundle.validation.warnings.some((w) => w.includes("does not yet persist"))).toBe(false);
  });

  it("sets validation.status to needs_review when the source Topic Scoring run was mock-generated and unapproved", () => {
    const context = buildContext();
    const bundle = assembleAssetBundle({
      analysis: fixtureAnalysis(),
      context,
      finalSlug: "inventory-tracker",
      slugConflicted: false,
      slugOriginalSuggestion: "inventory-tracker",
      campaignId: CAMPAIGN.id,
      generatedAt: "2026-07-16T00:00:00.000Z",
      promptVersion: "1.0.0",
      provenance,
      allowUnapprovedTopicUsed: false,
      allowHoldTopicUsed: false,
    });
    expect(bundle.validation.status).toBe("needs_review");
  });

  it("always requires human review regardless of recommendation", () => {
    const context = buildContext();
    const bundle = assembleAssetBundle({
      analysis: fixtureAnalysis(),
      context,
      finalSlug: "inventory-tracker",
      slugConflicted: false,
      slugOriginalSuggestion: "inventory-tracker",
      campaignId: CAMPAIGN.id,
      generatedAt: "2026-07-16T00:00:00.000Z",
      promptVersion: "1.0.0",
      provenance,
      allowUnapprovedTopicUsed: false,
      allowHoldTopicUsed: false,
    });
    expect(bundle.validation.humanReviewRequired).toBe(true);
  });

  it("preserves signalRefs/evidenceRefs from the selected topic's dimensions", () => {
    const context = buildContext();
    const bundle = assembleAssetBundle({
      analysis: fixtureAnalysis(),
      context,
      finalSlug: "inventory-tracker",
      slugConflicted: false,
      slugOriginalSuggestion: "inventory-tracker",
      campaignId: CAMPAIGN.id,
      generatedAt: "2026-07-16T00:00:00.000Z",
      promptVersion: "1.0.0",
      provenance,
      allowUnapprovedTopicUsed: false,
      allowHoldTopicUsed: false,
    });
    expect(bundle.generation.signalRefs).toContain("signal_1");
  });

  it("records a slug-conflict warning when the slug was resolved via conflict", () => {
    const context = buildContext();
    const bundle = assembleAssetBundle({
      analysis: fixtureAnalysis(),
      context,
      finalSlug: "orderly-abc123",
      slugConflicted: true,
      slugOriginalSuggestion: "orderly",
      campaignId: CAMPAIGN.id,
      generatedAt: "2026-07-16T00:00:00.000Z",
      promptVersion: "1.0.0",
      provenance,
      allowUnapprovedTopicUsed: false,
      allowHoldTopicUsed: false,
    });
    expect(bundle.validation.warnings.some((w) => w.includes("conflicts with an existing app"))).toBe(true);
  });

  it("adds the four required integration-test warnings and forces needs_review when integrationTestActive is true", () => {
    const context = buildContext();
    const bundle = assembleAssetBundle({
      analysis: fixtureAnalysis(),
      context,
      finalSlug: "inventory-tracker",
      slugConflicted: false,
      slugOriginalSuggestion: "inventory-tracker",
      campaignId: CAMPAIGN.id,
      generatedAt: "2026-07-16T00:00:00.000Z",
      promptVersion: "1.0.0",
      provenance,
      allowUnapprovedTopicUsed: false,
      allowHoldTopicUsed: false,
      integrationTestActive: true,
    });
    expect(bundle.validation.status).toBe("needs_review");
    expect(bundle.validation.warnings).toEqual(
      expect.arrayContaining([
        "Generated under explicit engineering integration-test override.",
        'Source topic recommendation is "advance".',
        "This output is not approved as a business experiment.",
        "Human content review is required before any CMS draft write.",
      ])
    );
  });

  it("omits the integration-test warnings when integrationTestActive is false or omitted", () => {
    const context = buildContext();
    const bundle = assembleAssetBundle({
      analysis: fixtureAnalysis(),
      context,
      finalSlug: "inventory-tracker",
      slugConflicted: false,
      slugOriginalSuggestion: "inventory-tracker",
      campaignId: CAMPAIGN.id,
      generatedAt: "2026-07-16T00:00:00.000Z",
      promptVersion: "1.0.0",
      provenance,
      allowUnapprovedTopicUsed: false,
      allowHoldTopicUsed: false,
    });
    expect(bundle.validation.warnings.some((w) => w.includes("integration-test override"))).toBe(false);
  });

  it("does not mutate the input analysis or context", () => {
    const context = buildContext();
    const analysis = fixtureAnalysis();
    const beforeAnalysis = JSON.stringify(analysis);
    const beforeContext = JSON.stringify(context);
    assembleAssetBundle({
      analysis,
      context,
      finalSlug: "inventory-tracker",
      slugConflicted: false,
      slugOriginalSuggestion: "inventory-tracker",
      campaignId: CAMPAIGN.id,
      generatedAt: "2026-07-16T00:00:00.000Z",
      promptVersion: "1.0.0",
      provenance,
      allowUnapprovedTopicUsed: false,
      allowHoldTopicUsed: false,
    });
    expect(JSON.stringify(analysis)).toBe(beforeAnalysis);
    expect(JSON.stringify(context)).toBe(beforeContext);
  });
});

describe("runAssetGenerationAgent — end to end", () => {
  const baseParams = {
    topicId: "topic_abc",
    sourceFilename: "topic-scoring-x.json",
    sourceSha256: "hash",
    language: "en" as const,
    maxTokens: 10000,
    promptVersion: "1.0.0",
    requestedSocialChannels: [] as string[],
    allowMockInputUsed: false,
    allowUnapprovedTopicUsed: false,
    allowHoldTopicUsed: false,
    generatedAt: "2026-07-16T00:00:00.000Z",
  };

  it("produces a valid FinalAssetGenerationRun with a contract-valid AssetBundle", async () => {
    const run = fixtureTopicScoringRun();
    const result = await runAssetGenerationAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis()) });
    expect(result.schemaVersion).toBe("1.0.0");
    expect(result.runType).toBe("asset_generation");
    expect(result.assetBundle.topicId).toBe("topic_abc");
    expect(result.assetBundle.scoredTopicId).toBe("scoredtopic_abc");
  });

  it("always requires human review and defaults approved to false", async () => {
    const run = fixtureTopicScoringRun();
    const result = await runAssetGenerationAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis()) });
    expect(result.humanReview).toEqual({ required: true, approved: false, approvedBy: null, approvedAt: null, note: expect.any(String) });
  });

  it("never performs a CMS write or site modification", async () => {
    const run = fixtureTopicScoringRun();
    const result = await runAssetGenerationAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis()) });
    expect(result.compatibility.cmsWritePerformed).toBe(false);
    expect(result.compatibility.siteModified).toBe(false);
  });

  it("preserves source and generation mock metadata", async () => {
    const run = fixtureTopicScoringRun();
    const mockResult = await runAssetGenerationAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis()) });
    expect(mockResult.provenance.sourceTopicScoringIsMock).toBe(true);
    expect(mockResult.generation.isMock).toBe(false); // FakeProvider's default name is "fake", not "mock"

    const trueMock = await runAssetGenerationAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis(), "mock") });
    expect(trueMock.generation.isMock).toBe(true);
  });

  it("records the selected topic ID and scoredTopic ID explicitly in provenance", async () => {
    const run = fixtureTopicScoringRun();
    const result = await runAssetGenerationAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis()) });
    expect(result.provenance.selectedTopicId).toBe("topic_abc");
    expect(result.provenance.selectedScoredTopicId).toBe("scoredtopic_abc");
  });

  it("does not mutate the input FinalTopicScoringRun", async () => {
    const run = fixtureTopicScoringRun();
    const before = JSON.stringify(run);
    await runAssetGenerationAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis()) });
    expect(JSON.stringify(run)).toBe(before);
  });

  it("no CMSWriteRequest-shaped fields appear anywhere in the output", async () => {
    const run = fixtureTopicScoringRun();
    const result = await runAssetGenerationAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis()) });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("publishrequested");
    expect(serialized).not.toContain("idempotencykey");
    expect(serialized).not.toContain("createorreplace");
  });

  it("throws AssetGenerationValidationError and produces no run when the provider response is invalid", async () => {
    const run = fixtureTopicScoringRun();
    const invalidAnalysis = { ...fixtureAnalysis(), rank: 1 } as unknown as AssetGenerationAnalysis;
    await expect(runAssetGenerationAgent({ ...baseParams, run, provider: new FakeProvider(invalidAnalysis) })).rejects.toThrow(AssetGenerationValidationError);
  });

  it("throws AssetGenerationInputError for an unknown selected topic ID", async () => {
    const run = fixtureTopicScoringRun();
    await expect(runAssetGenerationAgent({ ...baseParams, topicId: "topic_unknown", run, provider: new FakeProvider(fixtureAnalysis()) })).rejects.toThrow(AssetGenerationInputError);
  });

  it("defaults executionPurpose to business_experiment and integrationTestReview to null when integrationTest is not supplied", async () => {
    const run = fixtureTopicScoringRun();
    const result = await runAssetGenerationAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis()) });
    expect(result.executionPurpose).toBe("business_experiment");
    expect(result.integrationTestReview).toBeNull();
  });

  it("sets executionPurpose to integration_test and populates integrationTestReview when integrationTest is supplied", async () => {
    const run = fixtureTopicScoringRun({
      scoredTopics: [{ ...fixtureTopicScoringRun().scoredTopics[0], recommendation: "hold", blockers: ["insufficient_evidence: not enough signal"] }],
    });
    const result = await runAssetGenerationAgent({
      ...baseParams,
      run,
      provider: new FakeProvider(fixtureAnalysis()),
      integrationTest: { reviewedBy: "Joy", reviewNote: "Engineering check." },
    });
    expect(result.executionPurpose).toBe("integration_test");
    expect(result.integrationTestReview).toEqual({
      confirmed: true,
      reviewedBy: "Joy",
      reviewNote: "Engineering check.",
      sourceRecommendation: "hold",
      businessApprovalGranted: false,
    });
    expect(result.assetBundle.validation.status).toBe("needs_review");
    expect(result.humanReview.required).toBe(true);
    expect(result.humanReview.approved).toBe(false);
    expect(result.compatibility.cmsWritePerformed).toBe(false);
    expect(result.compatibility.siteModified).toBe(false);
  });

  it("does not mutate the source ScoredTopic's recommendation/blockers under integration-test", async () => {
    const run = fixtureTopicScoringRun({
      scoredTopics: [{ ...fixtureTopicScoringRun().scoredTopics[0], recommendation: "hold", blockers: ["insufficient_evidence: not enough signal"] }],
    });
    const before = JSON.stringify(run.scoredTopics);
    const result = await runAssetGenerationAgent({
      ...baseParams,
      run,
      provider: new FakeProvider(fixtureAnalysis()),
      integrationTest: { reviewedBy: "Joy", reviewNote: null },
    });
    expect(JSON.stringify(run.scoredTopics)).toBe(before);
    expect(result.selectedScoredTopic.recommendation).toBe("hold");
    expect(result.selectedScoredTopic.blockers).toEqual(["insufficient_evidence: not enough signal"]);
  });
});
