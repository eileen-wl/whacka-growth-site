import { describe, expect, it } from "vitest";
import {
  AssetBundleValidationError,
  ScoredTopicToAssetBundleValidationError,
  assetSocialStrategySchema,
  buildAssetBundleId,
  validateAssetBundle,
  validateScoredTopicForAssetGeneration,
} from "../contracts/asset-bundle";
import type { AssetBundle, AssetSocialStrategy } from "../contracts/asset-bundle";
import { computeTotalScore, computeWeightedScore } from "../contracts/scored-topic";
import type { ScoredTopic } from "../contracts/scored-topic";

function fixtureScoredTopic(overrides: Partial<ScoredTopic> = {}): ScoredTopic {
  const dimensions: ScoredTopic["dimensions"] = [
    { key: "demand", label: "Demand", score: 80, weight: 1, weightedScore: computeWeightedScore(80, 1), rationale: "x", signalRefs: [], evidenceRefs: [], limitations: [] },
  ];
  return {
    schemaVersion: "1.0.0",
    id: "scoredtopic_abc",
    topicId: "topic_abc",
    campaignId: "test_campaign",
    scoredAt: "2026-07-15T00:00:00.000Z",
    scoringVersion: "v1",
    dimensions,
    totalScore: computeTotalScore(dimensions),
    ranking: null,
    confidence: "medium",
    recommendation: "advance",
    blockers: [],
    humanReviewRequired: true,
    provenance: { generatedBy: "topic-scoring-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: [], sourceDecisionId: null, provider: null, model: null, isMock: false, humanReviewed: false },
    ...overrides,
  };
}

function fixtureAssetBundle(overrides: Partial<AssetBundle> = {}): AssetBundle {
  return {
    schemaVersion: "1.0.0",
    id: buildAssetBundleId({ scoredTopicId: "scoredtopic_abc", promptVersion: "v1" }),
    scoredTopicId: "scoredtopic_abc",
    topicId: "topic_abc",
    campaignId: "test_campaign",
    generatedAt: "2026-07-15T00:00:00.000Z",
    app: {
      name: "StockTrack",
      slug: "stocktrack",
      tagline: "Simple inventory tracking",
      category: "Orders & Inventory",
      shortDescription: "Track stock levels without a spreadsheet.",
      image: "/images/stocktrack/cover.svg",
      screenshots: [{ image: "/images/stocktrack/screenshot-1.svg", caption: "Dashboard" }],
      problem: "Small shops lose track of stock.",
      solution: "StockTrack gives one place to log stock counts.",
      whoItsFor: ["Small retail shops"],
      appPrompt: "Build a mini app called StockTrack for a small shop to track stock levels.",
      ctaLabel: "Build StockTrack with Whacka",
      ctaHref: "#",
      relatedSlugs: ["orderly"],
      faq: [{ question: "Is this free?", answer: "Whacka mini apps are generated on demand." }],
      status: "draft",
    },
    creativeBrief: { hook: "Never run out of stock again.", persona: "Small shop owner", scenario: "Managing stock between customers", steps: ["Log stock", "Get low-stock alerts"] },
    seo: { title: "StockTrack — Inventory Tracker", metaDescription: "Track stock levels without a spreadsheet.", primaryKeyword: "inventory tracker", secondaryKeywords: ["stock tracker"] },
    cta: {
      primaryType: "build",
      demoUrl: null,
      remixUrl: null,
      buildUrl: null,
      labels: { viewDemo: null, remix: null, build: "Build StockTrack with Whacka", copyPrompt: null },
      utmContent: "stocktrack_launch",
    },
    social: { posts: [] },
    generation: { provider: "mock", model: null, isMock: true, promptVersion: "v1", evidenceRefs: [], signalRefs: [], findingRefs: [] },
    validation: { status: "needs_review", warnings: [], humanReviewRequired: true },
    provenance: { generatedBy: "asset-generation-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["scoredtopic_abc"], sourceDecisionId: null, provider: "mock", model: null, isMock: true, humanReviewed: false },
    ...overrides,
  };
}

describe("assetBundleSchema", () => {
  it("accepts a well-formed asset bundle", () => {
    expect(() => validateAssetBundle(fixtureAssetBundle())).not.toThrow();
  });

  it("requires app.slug to be routable kebab-case", () => {
    const bundle = fixtureAssetBundle();
    bundle.app.slug = "Stock Track";
    expect(() => validateAssetBundle(bundle)).toThrow(AssetBundleValidationError);
  });

  it("rejects an empty appPrompt", () => {
    const bundle = fixtureAssetBundle();
    bundle.app.appPrompt = "";
    expect(() => validateAssetBundle(bundle)).toThrow(AssetBundleValidationError);
  });

  it("rejects a missing required CMS field (shortDescription)", () => {
    const bundle = fixtureAssetBundle() as unknown as Record<string, unknown>;
    const app = bundle.app as Record<string, unknown>;
    delete app.shortDescription;
    expect(() => validateAssetBundle(bundle)).toThrow(AssetBundleValidationError);
  });

  it("requires app.status to be 'draft'", () => {
    const bundle = fixtureAssetBundle();
    (bundle.app as { status: string }).status = "published";
    expect(() => validateAssetBundle(bundle)).toThrow(AssetBundleValidationError);
  });

  it("allows cta URLs to be null", () => {
    const bundle = fixtureAssetBundle({ cta: { ...fixtureAssetBundle().cta, demoUrl: null, remixUrl: null, buildUrl: null } });
    expect(() => validateAssetBundle(bundle)).not.toThrow();
  });

  it("rejects a placeholder-looking non-URL string in a CTA URL field", () => {
    const bundle = fixtureAssetBundle();
    (bundle.cta as { demoUrl: string | null }).demoUrl = "coming-soon";
    expect(() => validateAssetBundle(bundle)).toThrow(AssetBundleValidationError);
  });

  it("allows faq to be empty", () => {
    const bundle = fixtureAssetBundle();
    bundle.app.faq = [];
    expect(() => validateAssetBundle(bundle)).not.toThrow();
  });

  it("allows social.posts to be empty", () => {
    const bundle = fixtureAssetBundle({ social: { posts: [] } });
    expect(() => validateAssetBundle(bundle)).not.toThrow();
  });

  it("always requires validation.humanReviewRequired to be true", () => {
    const bundle = { ...fixtureAssetBundle(), validation: { ...fixtureAssetBundle().validation, humanReviewRequired: false as unknown as true } };
    expect(() => validateAssetBundle(bundle)).toThrow(AssetBundleValidationError);
  });

  it("rejects validation.status of 'approved' (not a reachable value)", () => {
    const bundle = fixtureAssetBundle();
    (bundle.validation as { status: string }).status = "approved";
    expect(() => validateAssetBundle(bundle)).toThrow(AssetBundleValidationError);
  });

  it("throws on an unsupported major schema version", () => {
    expect(() => validateAssetBundle(fixtureAssetBundle({ schemaVersion: "2.0.0" }))).toThrow();
  });

  it("accepts a bundle with social.strategy present (collection scope)", () => {
    const strategy: AssetSocialStrategy = {
      scope: "collection",
      campaignId: "small_business_toolkit_v0",
      campaignName: "Small Business Mini App Toolkit",
      featuredAppSlugs: ["stocktrack", "orderly", "bookly"],
      destinationUrl: "https://whacka-growth-site.vercel.app",
      utmContent: "collection_small_business_toolkit_v0",
    };
    const bundle = fixtureAssetBundle({ social: { posts: [{ channel: "linkedin", text: "Toolkit post." }], strategy } });
    expect(() => validateAssetBundle(bundle)).not.toThrow();
  });

  it("accepts a bundle with social.strategy omitted (old-file backward compatibility)", () => {
    const bundle = fixtureAssetBundle({ social: { posts: [] } });
    expect(() => validateAssetBundle(bundle)).not.toThrow();
  });

  it("accepts a null destinationUrl on social.strategy", () => {
    const strategy: AssetSocialStrategy = {
      scope: "collection",
      campaignId: "small_business_toolkit_v0",
      campaignName: "Small Business Mini App Toolkit",
      featuredAppSlugs: ["stocktrack", "orderly"],
      destinationUrl: null,
      utmContent: "collection_small_business_toolkit_v0",
    };
    const bundle = fixtureAssetBundle({ social: { posts: [{ channel: "x", text: "Toolkit post." }], strategy } });
    expect(() => validateAssetBundle(bundle)).not.toThrow();
  });
});

describe("assetSocialStrategySchema", () => {
  const base: AssetSocialStrategy = {
    scope: "collection",
    campaignId: "small_business_toolkit_v0",
    campaignName: "Small Business Mini App Toolkit",
    featuredAppSlugs: ["stocktrack", "orderly"],
    destinationUrl: null,
    utmContent: "collection_small_business_toolkit_v0",
  };

  it("accepts a well-formed strategy", () => {
    expect(assetSocialStrategySchema.safeParse(base).success).toBe(true);
  });

  it("rejects a scope other than 'collection'", () => {
    expect(assetSocialStrategySchema.safeParse({ ...base, scope: "standalone" }).success).toBe(false);
  });

  it("requires at least one featured app slug", () => {
    expect(assetSocialStrategySchema.safeParse({ ...base, featuredAppSlugs: [] }).success).toBe(false);
  });

  it("rejects a non-kebab-case featured app slug", () => {
    expect(assetSocialStrategySchema.safeParse({ ...base, featuredAppSlugs: ["Stock Track"] }).success).toBe(false);
  });

  it("rejects an empty campaignId or campaignName", () => {
    expect(assetSocialStrategySchema.safeParse({ ...base, campaignId: "" }).success).toBe(false);
    expect(assetSocialStrategySchema.safeParse({ ...base, campaignName: "" }).success).toBe(false);
  });

  it("accepts a real https destinationUrl", () => {
    expect(assetSocialStrategySchema.safeParse({ ...base, destinationUrl: "https://whacka-growth-site.vercel.app" }).success).toBe(true);
  });

  it("rejects a placeholder-looking non-URL destinationUrl", () => {
    expect(assetSocialStrategySchema.safeParse({ ...base, destinationUrl: "coming-soon" }).success).toBe(false);
  });
});

describe("validateScoredTopicForAssetGeneration", () => {
  it("accepts an 'advance' recommendation", () => {
    expect(() => validateScoredTopicForAssetGeneration(fixtureScoredTopic({ recommendation: "advance" }))).not.toThrow();
  });

  it("rejects a 'reject' recommendation", () => {
    expect(() => validateScoredTopicForAssetGeneration(fixtureScoredTopic({ recommendation: "reject" }))).toThrow(ScoredTopicToAssetBundleValidationError);
  });
});

describe("buildAssetBundleId", () => {
  it("is deterministic for identical inputs", () => {
    const a = buildAssetBundleId({ scoredTopicId: "scoredtopic_abc", promptVersion: "v1" });
    const b = buildAssetBundleId({ scoredTopicId: "scoredtopic_abc", promptVersion: "v1" });
    expect(a).toBe(b);
  });

  it("differs across promptVersion", () => {
    const a = buildAssetBundleId({ scoredTopicId: "scoredtopic_abc", promptVersion: "v1" });
    const b = buildAssetBundleId({ scoredTopicId: "scoredtopic_abc", promptVersion: "v2" });
    expect(a).not.toBe(b);
  });
});
