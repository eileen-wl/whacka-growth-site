import { describe, expect, it } from "vitest";
import { MockAssetGenerationProvider } from "../llm/mock-asset-generation-provider";
import type { AssetGenerationContext, AssetGenerationLLMRequest } from "../types/asset-generation";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureContext(overrides: Partial<AssetGenerationContext> = {}): AssetGenerationContext {
  return {
    period: PERIOD,
    campaign: CAMPAIGN,
    topicId: "topic_abc",
    scoredTopicId: "scoredtopic_abc",
    canonicalName: "Inventory Tracker",
    slug: "inventory-tracker",
    problemStatement: "Small shops lose track of stock.",
    targetAudience: "Small retail shop owners",
    useCases: ["Track stock counts"],
    desiredOutcome: "Fewer stockouts.",
    rank: 1,
    candidateCount: 3,
    totalScore: 72,
    recommendation: "advance",
    confidence: "high",
    dimensions: [],
    blockers: [],
    relationshipToExistingContent: { status: "new", relatedAppSlugs: [], relatedTopicIds: [] },
    sourceScoringIsMock: false,
    sourceTopicsHumanReviewed: true,
    dataQualityWarnings: [],
    dataQualityLimitations: [],
    language: "en",
    allowedCtaTypes: ["view_demo", "remix", "build", "copy_prompt"],
    requestedSocialChannels: [],
    existingAppCatalog: [{ name: "Orderly", slug: "orderly", hook: "Order tracker", status: "unknown" }],
    cmsFieldRequirements: ["app.name is required."],
    ...overrides,
  };
}

function fixtureRequest(overrides: Partial<AssetGenerationLLMRequest> = {}): AssetGenerationLLMRequest {
  const context = fixtureContext(overrides.context ?? {});
  return {
    purpose: "purpose",
    period: PERIOD,
    campaign: CAMPAIGN,
    language: "en",
    context,
    allowedCtaTypes: ["view_demo", "remix", "build", "copy_prompt"],
    requestedSocialChannels: [],
    reportingRules: [],
    responseSchemaDescription: "desc",
    maxTokens: 10000,
    systemPrompt: "SYSTEM",
    userPrompt: "USER",
    ...overrides,
  };
}

describe("MockAssetGenerationProvider", () => {
  it("is named 'mock' and requires no API key or network call", async () => {
    const provider = new MockAssetGenerationProvider();
    expect(provider.name).toBe("mock");
    await expect(provider.generateStructuredAssets(fixtureRequest())).resolves.toBeDefined();
  });

  it("uses the actual selected topic's problem/audience/use cases", async () => {
    const provider = new MockAssetGenerationProvider();
    const result = await provider.generateStructuredAssets(fixtureRequest());
    expect(result.data.appConcept.problem).toContain("Small shops lose track of stock.");
    expect(result.data.appConcept.whoItsFor).toContain("Small retail shop owners");
  });

  it("never includes a URL anywhere in the generated content", async () => {
    const provider = new MockAssetGenerationProvider();
    const result = await provider.generateStructuredAssets(fixtureRequest());
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toMatch(/https?:\/\//);
  });

  it("does not claim a live demo or publication", async () => {
    const provider = new MockAssetGenerationProvider();
    const result = await provider.generateStructuredAssets(fixtureRequest());
    const serialized = JSON.stringify(result.data).toLowerCase();
    expect(serialized).not.toContain("live demo");
    expect(serialized).not.toContain("now available");
    expect(serialized).not.toContain("published");
  });

  it("adapts to mock scoring input without crashing and records it in generationNotes", async () => {
    const provider = new MockAssetGenerationProvider();
    const result = await provider.generateStructuredAssets(fixtureRequest({ context: fixtureContext({ sourceScoringIsMock: true }) }));
    expect(result.data.generationNotes.assumptions.some((a) => a.includes("mock status: true"))).toBe(true);
  });

  it("adapts to unapproved input without crashing", async () => {
    const provider = new MockAssetGenerationProvider();
    const result = await provider.generateStructuredAssets(fixtureRequest({ context: fixtureContext({ sourceTopicsHumanReviewed: false }) }));
    expect(result.data.generationNotes.assumptions.some((a) => a.includes("human-reviewed: false"))).toBe(true);
  });

  it("produces zero social posts when zero channels are requested", async () => {
    const provider = new MockAssetGenerationProvider();
    const result = await provider.generateStructuredAssets(fixtureRequest({ requestedSocialChannels: [] }));
    expect(result.data.socialPosts).toEqual([]);
  });

  it("only produces posts for explicitly requested channels", async () => {
    const provider = new MockAssetGenerationProvider();
    const result = await provider.generateStructuredAssets(fixtureRequest({ requestedSocialChannels: ["linkedin", "x"] }));
    expect(result.data.socialPosts.map((p) => p.channel).sort()).toEqual(["linkedin", "x"]);
  });

  it("creates a narrow, single mini-app concept (exactly one appConcept)", async () => {
    const provider = new MockAssetGenerationProvider();
    const result = await provider.generateStructuredAssets(fixtureRequest());
    expect(result.data.appConcept.name.length).toBeGreaterThan(0);
    expect(typeof result.data.appConcept).toBe("object");
  });

  it("clearly marks generation as mock via metadata", async () => {
    const provider = new MockAssetGenerationProvider();
    const result = await provider.generateStructuredAssets(fixtureRequest());
    expect(result.provider).toBe("mock");
    expect(result.model).toBe("mock-v0");
  });

  it("returns a schema-valid analysis with all required top-level keys", async () => {
    const provider = new MockAssetGenerationProvider();
    const result = await provider.generateStructuredAssets(fixtureRequest());
    expect(result.data).toHaveProperty("appConcept");
    expect(result.data).toHaveProperty("seo");
    expect(result.data).toHaveProperty("cta");
    expect(result.data).toHaveProperty("socialPosts");
    expect(result.data).toHaveProperty("socialFeaturedExistingAppSlugs");
    expect(result.data).toHaveProperty("generationNotes");
  });

  it("produces an empty socialFeaturedExistingAppSlugs when zero channels are requested", async () => {
    const provider = new MockAssetGenerationProvider();
    const result = await provider.generateStructuredAssets(fixtureRequest({ requestedSocialChannels: [] }));
    expect(result.data.socialFeaturedExistingAppSlugs).toEqual([]);
  });

  it("features up to two existing catalog apps when at least one channel is requested", async () => {
    const provider = new MockAssetGenerationProvider();
    const catalog = [
      { name: "Orderly", slug: "orderly", hook: "Order tracker", status: "unknown" },
      { name: "Bookly", slug: "bookly", hook: "Booking form", status: "unknown" },
      { name: "QuoteWave", slug: "quotewave", hook: "Quote calculator", status: "unknown" },
    ];
    const result = await provider.generateStructuredAssets(
      fixtureRequest({ requestedSocialChannels: ["linkedin"], context: fixtureContext({ existingAppCatalog: catalog }) })
    );
    expect(result.data.socialFeaturedExistingAppSlugs).toEqual(["orderly", "bookly"]);
  });

  it("features every available existing app when the catalog has fewer than two entries", async () => {
    const provider = new MockAssetGenerationProvider();
    const catalog = [{ name: "Orderly", slug: "orderly", hook: "Order tracker", status: "unknown" }];
    const result = await provider.generateStructuredAssets(
      fixtureRequest({ requestedSocialChannels: ["linkedin"], context: fixtureContext({ existingAppCatalog: catalog }) })
    );
    expect(result.data.socialFeaturedExistingAppSlugs).toEqual(["orderly"]);
  });

  it("produces collection-level social copy, never a standalone-launch pattern", async () => {
    const provider = new MockAssetGenerationProvider();
    const catalog = [
      { name: "Orderly", slug: "orderly", hook: "Order tracker", status: "unknown" },
      { name: "Bookly", slug: "bookly", hook: "Booking form", status: "unknown" },
    ];
    const result = await provider.generateStructuredAssets(
      fixtureRequest({ requestedSocialChannels: ["linkedin"], context: fixtureContext({ existingAppCatalog: catalog }) })
    );
    const copy = result.data.socialPosts[0].copy.toLowerCase();
    expect(copy).not.toMatch(/introducing /);
    expect(copy).not.toMatch(/launching /);
    expect(copy).toContain("orderly");
    expect(copy).toContain("bookly");
  });

  it("its own output passes the full validateAssetGenerationAnalysis collection-scope checks", async () => {
    const provider = new MockAssetGenerationProvider();
    const catalog = [
      { name: "Orderly", slug: "orderly", hook: "Order tracker", status: "unknown" },
      { name: "Bookly", slug: "bookly", hook: "Booking form", status: "unknown" },
    ];
    const request = fixtureRequest({ requestedSocialChannels: ["linkedin", "x"], context: fixtureContext({ existingAppCatalog: catalog, requestedSocialChannels: ["linkedin", "x"] }) });
    const result = await provider.generateStructuredAssets(request);
    const { validateAssetGenerationAnalysis } = await import("../agents/asset-generation-agent");
    expect(() => validateAssetGenerationAnalysis(result.data, ["linkedin", "x"], catalog)).not.toThrow();
  });
});
