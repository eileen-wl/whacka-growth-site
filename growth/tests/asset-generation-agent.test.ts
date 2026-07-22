import { describe, expect, it } from "vitest";
import {
  AssetGenerationInputError,
  AssetGenerationSlugError,
  AssetGenerationValidationError,
  assembleAssetBundle,
  buildAssetGenerationContext,
  buildExistingAppCatalog,
  buildFinalAssetBundleId,
  buildSocialStrategy,
  computeValidationStatus,
  dedupeNearIdenticalText,
  resolveCtaAndUrls,
  resolveFinalSlug,
  resolveSelectedTopic,
  runAssetGenerationAgent,
  validateAssetGenerationAnalysis,
} from "../agents/asset-generation-agent";
import { HOMEPAGE_DASHBOARD_URL } from "../../src/lib/utm";
import type { AssetGenerationProvider } from "../llm/asset-generation-provider";
import type { AssetGenerationAnalysis, AssetGenerationExistingAppCatalogEntry } from "../types/asset-generation";
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
    socialFeaturedExistingAppSlugs: [],
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

describe("validateAssetGenerationAnalysis — collection-scoped social content", () => {
  const CATALOG: AssetGenerationExistingAppCatalogEntry[] = [
    { name: "Orderly", slug: "orderly", hook: "Order tracker", status: "unknown" },
    { name: "Bookly", slug: "bookly", hook: "Booking form", status: "unknown" },
    { name: "QuoteWave", slug: "quotewave", hook: "Quote calculator", status: "unknown" },
  ];

  function socialAnalysis(overrides: Partial<AssetGenerationAnalysis> = {}): AssetGenerationAnalysis {
    return fixtureAnalysis({
      socialPosts: [{ channel: "linkedin", variant: "toolkit", copy: "Small business owners juggle a lot — here's a useful toolkit of ideas, including Inventory Tracker." }],
      socialFeaturedExistingAppSlugs: ["orderly", "bookly"],
      ...overrides,
    });
  }

  it("accepts collection-level copy featuring >= 2 existing apps when the catalog has >= 2 and a channel is requested", () => {
    expect(() => validateAssetGenerationAnalysis(socialAnalysis(), ["linkedin"], CATALOG)).not.toThrow();
  });

  it("rejects standalone-launch language ('Introducing <AppName>')", () => {
    const analysis = socialAnalysis({ socialPosts: [{ channel: "linkedin", variant: "toolkit", copy: "Introducing Inventory Tracker — the app you've been waiting for!" }] });
    expect(() => validateAssetGenerationAnalysis(analysis, ["linkedin"], CATALOG)).toThrow(AssetGenerationValidationError);
  });

  it("rejects standalone-launch language ('Launching <AppName>')", () => {
    const analysis = socialAnalysis({ socialPosts: [{ channel: "linkedin", variant: "toolkit", copy: "Launching Inventory Tracker today for small businesses everywhere." }] });
    expect(() => validateAssetGenerationAnalysis(analysis, ["linkedin"], CATALOG)).toThrow(AssetGenerationValidationError);
  });

  it("rejects standalone-launch language ('X is the solution')", () => {
    const analysis = socialAnalysis({ socialPosts: [{ channel: "linkedin", variant: "toolkit", copy: "Inventory Tracker is the solution small shops need." }] });
    expect(() => validateAssetGenerationAnalysis(analysis, ["linkedin"], CATALOG)).toThrow(AssetGenerationValidationError);
  });

  it("rejects the generic 'build this one app now' pattern regardless of app name", () => {
    const analysis = socialAnalysis({ socialPosts: [{ channel: "linkedin", variant: "toolkit", copy: "Stop juggling spreadsheets — build this one app now and get organized." }] });
    expect(() => validateAssetGenerationAnalysis(analysis, ["linkedin"], CATALOG)).toThrow(AssetGenerationValidationError);
  });

  it("does not false-positive on ordinary collection copy that just happens to mention the app name", () => {
    const analysis = socialAnalysis({
      socialPosts: [{ channel: "linkedin", variant: "toolkit", copy: "This toolkit includes ideas like Orderly and Bookly, and a new concept we're exploring: Inventory Tracker." }],
    });
    expect(() => validateAssetGenerationAnalysis(analysis, ["linkedin"], CATALOG)).not.toThrow();
  });

  it.each(["proven demand", "validated opportunity", "confirmed user need", "market-leading", "top-performing product"])(
    "rejects the overclaim phrase %j",
    (phrase) => {
      const analysis = socialAnalysis({ socialPosts: [{ channel: "linkedin", variant: "toolkit", copy: `This toolkit reflects ${phrase} across small businesses.` }] });
      expect(() => validateAssetGenerationAnalysis(analysis, ["linkedin"], CATALOG)).toThrow(AssetGenerationValidationError);
    }
  );

  it("rejects a featured slug that does not exist in the supplied existing-app catalog", () => {
    const analysis = socialAnalysis({ socialFeaturedExistingAppSlugs: ["orderly", "not-a-real-app"] });
    expect(() => validateAssetGenerationAnalysis(analysis, ["linkedin"], CATALOG)).toThrow(AssetGenerationValidationError);
  });

  it("rejects fewer than 2 featured existing apps when the catalog has >= 2 and a channel is requested", () => {
    const analysis = socialAnalysis({ socialFeaturedExistingAppSlugs: ["orderly"] });
    expect(() => validateAssetGenerationAnalysis(analysis, ["linkedin"], CATALOG)).toThrow(AssetGenerationValidationError);
  });

  it("rejects zero featured existing apps (the selected app as sole subject) when the catalog has >= 2 and a channel is requested", () => {
    const analysis = socialAnalysis({ socialFeaturedExistingAppSlugs: [] });
    expect(() => validateAssetGenerationAnalysis(analysis, ["linkedin"], CATALOG)).toThrow(AssetGenerationValidationError);
  });

  it("does not require any featured existing app when zero social channels were requested, even with a rich catalog", () => {
    const analysis = fixtureAnalysis({ socialPosts: [], socialFeaturedExistingAppSlugs: [] });
    expect(() => validateAssetGenerationAnalysis(analysis, [], CATALOG)).not.toThrow();
  });

  it("relaxes the '>= 2' requirement to the catalog's actual size when fewer than 2 existing apps exist", () => {
    const oneAppCatalog = CATALOG.slice(0, 1);
    const analysis = socialAnalysis({ socialFeaturedExistingAppSlugs: ["orderly"] });
    expect(() => validateAssetGenerationAnalysis(analysis, ["linkedin"], oneAppCatalog)).not.toThrow();
  });

  it("does not require any featured existing app when the catalog is entirely empty", () => {
    const analysis = socialAnalysis({ socialFeaturedExistingAppSlugs: [] });
    expect(() => validateAssetGenerationAnalysis(analysis, ["linkedin"], [])).not.toThrow();
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

  it("sets ctaHref to the existing '#' no-target convention for copy_prompt (not a navigation CTA, no URL is ever expected)", () => {
    const result = resolveCtaAndUrls({ ...cta, primaryType: "copy_prompt" }, "inventory-tracker");
    expect(result.ctaHref).toBe("#");
    expect(result.cta.primaryType).toBe("copy_prompt");
    expect(result.fallbackApplied).toBe(false);
  });

  it("sets utmContent to the final slug deterministically", () => {
    const result = resolveCtaAndUrls(cta, "inventory-tracker");
    expect(result.cta.utmContent).toBe("inventory-tracker");
  });

  it("falls back to build when the requested primary type is view_demo (no real URL exists in v1)", () => {
    const result = resolveCtaAndUrls({ ...cta, primaryType: "view_demo" }, "inventory-tracker");
    expect(result.fallbackApplied).toBe(true);
    expect(result.requestedPrimaryType).toBe("view_demo");
    expect(result.cta.primaryType).toBe("build");
    expect(result.ctaHref).toBe("https://whacka.app/dashboard");
  });

  it("falls back to build when the requested primary type is remix (no real URL exists in v1)", () => {
    const result = resolveCtaAndUrls({ ...cta, primaryType: "remix" }, "inventory-tracker");
    expect(result.fallbackApplied).toBe(true);
    expect(result.requestedPrimaryType).toBe("remix");
    expect(result.cta.primaryType).toBe("build");
    expect(result.ctaHref).toBe("https://whacka.app/dashboard");
  });

  it("does not fall back when the requested primary type is already build", () => {
    const result = resolveCtaAndUrls(cta, "inventory-tracker");
    expect(result.fallbackApplied).toBe(false);
    expect(result.requestedPrimaryType).toBe("build");
  });

  it("never fabricates a demo or remix URL, with or without a fallback", () => {
    for (const primaryType of ["build", "view_demo", "remix", "copy_prompt"] as const) {
      const result = resolveCtaAndUrls({ ...cta, primaryType }, "inventory-tracker");
      expect(result.cta.demoUrl).toBeNull();
      expect(result.cta.remixUrl).toBeNull();
    }
  });

  it("falls back to the build label when the effective type is build, else the primary label", () => {
    const result = resolveCtaAndUrls({ ...cta, primaryType: "remix", labels: { ...cta.labels, build: "Custom build label", primary: "Fallback primary label" } }, "inventory-tracker");
    expect(result.ctaLabel).toBe("Custom build label");
  });
});

describe("buildSocialStrategy", () => {
  function buildAppCta(overrides: Partial<ReturnType<typeof resolveCtaAndUrls>["cta"]> = {}) {
    return { primaryType: "build" as const, demoUrl: null, remixUrl: null, buildUrl: HOMEPAGE_DASHBOARD_URL, labels: { viewDemo: null, remix: null, build: "Build it", copyPrompt: null }, utmContent: "inventory-tracker", ...overrides };
  }

  function baseParams(overrides: Partial<Parameters<typeof buildSocialStrategy>[0]> = {}) {
    const context = buildAssetGenerationContext({
      run: fixtureTopicScoringRun(),
      topic: resolveSelectedTopic(fixtureTopicScoringRun(), "topic_abc").topic,
      scoredTopic: resolveSelectedTopic(fixtureTopicScoringRun(), "topic_abc").scoredTopic,
      language: "en",
      requestedSocialChannels: ["linkedin"],
      existingAppCatalog: [],
    });
    return {
      analysis: fixtureAnalysis({ socialFeaturedExistingAppSlugs: ["orderly", "bookly"] }),
      context,
      finalSlug: "inventory-tracker",
      campaignId: CAMPAIGN.id,
      destinationUrl: null,
      cta: buildAppCta(),
      ...overrides,
    };
  }

  it("always includes the new app's own final slug alongside the model-chosen existing apps, deduped", () => {
    const strategy = buildSocialStrategy(baseParams());
    expect(strategy.featuredAppSlugs).toEqual(["inventory-tracker", "orderly", "bookly"]);
  });

  it("dedupes if the model happens to reference the new app's slug redundantly", () => {
    const strategy = buildSocialStrategy(baseParams({ analysis: fixtureAnalysis({ socialFeaturedExistingAppSlugs: ["inventory-tracker", "orderly"] }) }));
    expect(strategy.featuredAppSlugs).toEqual(["inventory-tracker", "orderly"]);
  });

  it("sets scope to 'collection' and preserves campaign identity from context", () => {
    const strategy = buildSocialStrategy(baseParams());
    expect(strategy.scope).toBe("collection");
    expect(strategy.campaignId).toBe(CAMPAIGN.id);
    expect(strategy.campaignName).toBe(CAMPAIGN.name);
  });

  it("utmContent differs from the app's own final slug", () => {
    const strategy = buildSocialStrategy(baseParams());
    expect(strategy.utmContent).not.toBe("inventory-tracker");
    expect(strategy.utmContent).toContain(CAMPAIGN.id);
  });

  it("passes a real destinationUrl through unchanged", () => {
    const strategy = buildSocialStrategy(baseParams({ destinationUrl: "https://whacka-growth-site.vercel.app" }));
    expect(strategy.destinationUrl).toBe("https://whacka-growth-site.vercel.app");
  });

  it("passes a null destinationUrl through as null (never fabricates one)", () => {
    const strategy = buildSocialStrategy(baseParams({ destinationUrl: null }));
    expect(strategy.destinationUrl).toBeNull();
  });

  it("throws if destinationUrl would collide with the Whacka dashboard URL", () => {
    expect(() => buildSocialStrategy(baseParams({ destinationUrl: HOMEPAGE_DASHBOARD_URL }))).toThrow(AssetGenerationValidationError);
  });

  it("throws if destinationUrl would collide with the app's own buildUrl", () => {
    const cta = buildAppCta({ buildUrl: "https://example.com/app-specific-build" });
    expect(() => buildSocialStrategy(baseParams({ destinationUrl: "https://example.com/app-specific-build", cta }))).toThrow(AssetGenerationValidationError);
  });

  it("throws if destinationUrl would collide with the app's own demoUrl or remixUrl", () => {
    const cta = buildAppCta({ demoUrl: "https://example.com/demo" });
    expect(() => buildSocialStrategy(baseParams({ destinationUrl: "https://example.com/demo", cta }))).toThrow(AssetGenerationValidationError);
  });
});

describe("dedupeNearIdenticalText", () => {
  it("keeps the first occurrence and drops a close paraphrase (high token overlap)", () => {
    const result = dedupeNearIdenticalText([
      "Assumes small business owners currently handle bookings through informal channels like phone or text.",
      "Owners currently handle bookings via informal channels.",
    ]);
    expect(result).toEqual(["Assumes small business owners currently handle bookings through informal channels like phone or text."]);
  });

  it("keeps two genuinely distinct entries (low token overlap) — never removes a distinct limitation", () => {
    const result = dedupeNearIdenticalText([
      "Early CTA engagement is not the same as confirmed, repeatable demand.",
      "Engagement signal lacks a denominator, unique-user counts, and connected product outcomes, so demand is unconfirmed.",
    ]);
    expect(result).toHaveLength(2);
  });

  it("returns an empty array for an empty input", () => {
    expect(dedupeNearIdenticalText([])).toEqual([]);
  });

  it("keeps a single item unchanged", () => {
    expect(dedupeNearIdenticalText(["A single distinct assumption."])).toEqual(["A single distinct assumption."]);
  });

  it("is order-preserving and keeps the earliest of a duplicate group", () => {
    const result = dedupeNearIdenticalText([
      "The topic overlaps the existing Bookly app and carries low novelty per the assessment.",
      "This concept overlaps with the existing Bookly app's booking form category and must be positioned distinctly.",
      "A completely unrelated limitation about a different aspect entirely.",
    ]);
    expect(result[0]).toBe("The topic overlaps the existing Bookly app and carries low novelty per the assessment.");
    expect(result).toContain("A completely unrelated limitation about a different aspect entirely.");
  });

  it("respects a custom threshold", () => {
    const items = ["Small business owners lose track of stock.", "Owners lose track of inventory counts."];
    expect(dedupeNearIdenticalText(items, 0.99)).toHaveLength(2); // near-impossible overlap requirement — both kept
    expect(dedupeNearIdenticalText(items, 0.01)).toHaveLength(1); // near-zero overlap requirement — treated as duplicates
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

  it("records a CTA-fallback warning and never leaves the primary CTA pointed at a missing URL", () => {
    const context = buildContext();
    const analysis = fixtureAnalysis({ cta: { ...fixtureAnalysis().cta, primaryType: "remix" } });
    const bundle = assembleAssetBundle({
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
    expect(bundle.cta.primaryType).toBe("build");
    expect(bundle.app.ctaHref).toBe("https://whacka.app/dashboard");
    expect(bundle.validation.warnings.some((w) => w.includes("CTA fallback") && w.includes("remix"))).toBe(true);
  });

  it("does not record a CTA-fallback warning when the requested primary type already has a real URL", () => {
    const context = buildContext();
    const bundle = assembleAssetBundle({
      analysis: fixtureAnalysis(), // default cta.primaryType is "build"
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
    expect(bundle.validation.warnings.some((w) => w.includes("CTA fallback"))).toBe(false);
  });

  it("deduplicates near-identical assumptions/limitations across creativeBrief and generationNotes, but keeps distinct ones", () => {
    const context = buildContext();
    const analysis = fixtureAnalysis({
      appConcept: {
        ...fixtureAnalysis().appConcept,
        creativeBrief: {
          ...fixtureAnalysis().appConcept.creativeBrief,
          assumptions: ["Assumes small business owners currently handle bookings through informal channels like phone or text."],
          limitations: ["Early CTA engagement is not the same as confirmed, repeatable demand."],
        },
      },
      generationNotes: {
        ...fixtureAnalysis().generationNotes,
        assumptions: ["Owners currently handle bookings via informal channels."], // near-duplicate of the creativeBrief assumption above
        limitations: ["Engagement signal lacks a denominator, unique-user counts, and connected product outcomes, so demand is unconfirmed."], // distinct
      },
    });
    const bundle = assembleAssetBundle({
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
    const assumptionWarnings = bundle.validation.warnings.filter((w) => w.startsWith("Assumption:"));
    const limitationWarnings = bundle.validation.warnings.filter((w) => w.startsWith("Limitation:"));
    expect(assumptionWarnings).toHaveLength(1); // the near-duplicate was dropped
    expect(limitationWarnings).toHaveLength(2); // both distinct limitations kept
  });

  it("never mechanically truncates seo.title or seo.metaDescription — passes them through verbatim regardless of length", () => {
    const context = buildContext();
    const longTitle = "A".repeat(120);
    const longMeta = "B".repeat(250);
    const analysis = fixtureAnalysis({ seo: { ...fixtureAnalysis().seo, title: longTitle, metaDescription: longMeta } });
    const bundle = assembleAssetBundle({
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
    expect(bundle.seo.title).toBe(longTitle);
    expect(bundle.seo.metaDescription).toBe(longMeta);
  });

  it("omits social.strategy entirely when there are zero social posts", () => {
    const context = buildContext();
    const bundle = assembleAssetBundle({
      analysis: fixtureAnalysis({ socialPosts: [], socialFeaturedExistingAppSlugs: [] }),
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
    expect(bundle.social.strategy).toBeUndefined();
  });

  it("includes a deterministic social.strategy when at least one social post exists", () => {
    const context = buildContext();
    const analysis = fixtureAnalysis({
      socialPosts: [{ channel: "linkedin", variant: "toolkit", copy: "This toolkit includes several small-business ideas." }],
      socialFeaturedExistingAppSlugs: ["orderly", "bookly"],
    });
    const bundle = assembleAssetBundle({
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
      collectionDestinationUrl: "https://whacka-growth-site.vercel.app",
    });
    expect(bundle.social.strategy).toEqual({
      scope: "collection",
      campaignId: CAMPAIGN.id,
      campaignName: CAMPAIGN.name,
      featuredAppSlugs: ["inventory-tracker", "orderly", "bookly"],
      destinationUrl: "https://whacka-growth-site.vercel.app",
      utmContent: expect.stringContaining(CAMPAIGN.id),
    });
  });

  it("adds the not-configured warning and keeps destinationUrl null when no collection URL is supplied", () => {
    const context = buildContext();
    const analysis = fixtureAnalysis({
      socialPosts: [{ channel: "linkedin", variant: "toolkit", copy: "This toolkit includes several small-business ideas." }],
      socialFeaturedExistingAppSlugs: ["orderly", "bookly"],
    });
    const bundle = assembleAssetBundle({
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
      collectionDestinationUrl: null,
    });
    expect(bundle.social.strategy?.destinationUrl).toBeNull();
    expect(bundle.validation.warnings.some((w) => w.includes("No public collection landing page URL is configured"))).toBe(true);
  });

  it("does not add the not-configured warning when a real collection URL is supplied", () => {
    const context = buildContext();
    const analysis = fixtureAnalysis({
      socialPosts: [{ channel: "linkedin", variant: "toolkit", copy: "This toolkit includes several small-business ideas." }],
      socialFeaturedExistingAppSlugs: ["orderly", "bookly"],
    });
    const bundle = assembleAssetBundle({
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
      collectionDestinationUrl: "https://whacka-growth-site.vercel.app",
    });
    expect(bundle.validation.warnings.some((w) => w.includes("No public collection landing page URL is configured"))).toBe(false);
  });

  it("rejects (via validateAssetBundle) an empty campaignId — campaign identity can never be missing", () => {
    const context = buildContext();
    const analysis = fixtureAnalysis({
      socialPosts: [{ channel: "linkedin", variant: "toolkit", copy: "This toolkit includes several small-business ideas." }],
      socialFeaturedExistingAppSlugs: ["orderly", "bookly"],
    });
    expect(() =>
      assembleAssetBundle({
        analysis,
        context,
        finalSlug: "inventory-tracker",
        slugConflicted: false,
        slugOriginalSuggestion: "inventory-tracker",
        campaignId: "",
        generatedAt: "2026-07-16T00:00:00.000Z",
        promptVersion: "1.0.0",
        provenance,
        allowUnapprovedTopicUsed: false,
        allowHoldTopicUsed: false,
      })
    ).toThrow();
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

  it("threads collectionDestinationUrl through into social.strategy.destinationUrl", async () => {
    const run = fixtureTopicScoringRun();
    const analysis = fixtureAnalysis({
      socialPosts: [{ channel: "linkedin", variant: "toolkit", copy: "This toolkit includes a few small-business ideas worth exploring." }],
      socialFeaturedExistingAppSlugs: ["orderly", "bookly"],
    });
    const result = await runAssetGenerationAgent({
      ...baseParams,
      run,
      requestedSocialChannels: ["linkedin"],
      provider: new FakeProvider(analysis),
      collectionDestinationUrl: "https://example.com/collection",
    });
    expect(result.assetBundle.social.strategy?.destinationUrl).toBe("https://example.com/collection");
    expect(result.assetBundle.social.strategy?.scope).toBe("collection");
    expect(result.assetBundle.social.strategy?.featuredAppSlugs).toContain("orderly");
    expect(result.assetBundle.social.strategy?.featuredAppSlugs).toContain("bookly");
  });

  it("keeps app-level content (problem, solution, appPrompt, SEO, CTA) entirely app-specific regardless of the new collection-level social scope", async () => {
    const run = fixtureTopicScoringRun();
    const analysis = fixtureAnalysis({
      socialPosts: [{ channel: "linkedin", variant: "toolkit", copy: "This toolkit includes a few small-business ideas worth exploring." }],
      socialFeaturedExistingAppSlugs: ["orderly", "bookly"],
    });
    const result = await runAssetGenerationAgent({
      ...baseParams,
      run,
      requestedSocialChannels: ["linkedin"],
      provider: new FakeProvider(analysis),
      collectionDestinationUrl: "https://example.com/collection",
    });
    expect(result.assetBundle.app.problem).toBe(analysis.appConcept.problem);
    expect(result.assetBundle.app.solution).toBe(analysis.appConcept.solution);
    expect(result.assetBundle.app.appPrompt).toBe(analysis.appConcept.appPrompt);
    expect(result.assetBundle.seo.title).toBe(analysis.seo.title);
    expect(result.assetBundle.seo.metaDescription).toBe(analysis.seo.metaDescription);
    expect(result.assetBundle.app.faq).toEqual(analysis.seo.faq);
    expect(result.assetBundle.cta.primaryType).toBe(analysis.cta.primaryType);
  });
});
