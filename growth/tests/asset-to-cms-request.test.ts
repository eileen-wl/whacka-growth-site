import { describe, expect, it } from "vitest";
import { buildCmsWriteRequestFromAssetBundle, buildDraftDocumentId } from "../cms/asset-to-cms-request";
import { buildAssetBundleId } from "../contracts/asset-bundle";
import type { AssetBundle } from "../contracts/asset-bundle";

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
      screenshots: [],
      problem: "Small shops lose track of stock.",
      solution: "StockTrack gives one place to log stock counts.",
      whoItsFor: ["Small retail shops"],
      appPrompt: "Build a mini app called StockTrack for a small shop to track stock levels.",
      ctaLabel: "Build StockTrack with Whacka",
      ctaHref: "#",
      relatedSlugs: [],
      faq: [{ question: "Is this free?", answer: "Whacka mini apps are generated on demand." }],
      status: "draft",
    },
    creativeBrief: { hook: "Never run out of stock again.", persona: "Small shop owner", scenario: null, steps: [] },
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

describe("buildDraftDocumentId", () => {
  it("prefixes the canonical id with 'drafts.'", () => {
    expect(buildDraftDocumentId("appTool-stocktrack")).toBe("drafts.appTool-stocktrack");
  });

  it("never returns the canonical (non-draft) id unmodified", () => {
    const draftId = buildDraftDocumentId("appTool-stocktrack");
    expect(draftId).not.toBe("appTool-stocktrack");
  });
});

describe("buildCmsWriteRequestFromAssetBundle", () => {
  it("reuses growth/contracts/cms-write-request.ts's builder — target.documentId stays the canonical id", () => {
    const request = buildCmsWriteRequestFromAssetBundle(fixtureAssetBundle(), { mode: "dry_run", humanReviewed: false });
    expect(request.target.documentId).toBe("appTool-stocktrack");
    expect(request.payload._id).toBe("appTool-stocktrack");
  });

  it("passes humanReviewed through into the request's validation and provenance", () => {
    const reviewed = buildCmsWriteRequestFromAssetBundle(fixtureAssetBundle(), { mode: "draft_write", humanReviewed: true, dataset: "production" });
    expect(reviewed.validation.humanReviewed).toBe(true);
    expect(reviewed.provenance.humanReviewed).toBe(true);
  });

  it("dry_run mode never carries a dataset", () => {
    const request = buildCmsWriteRequestFromAssetBundle(fixtureAssetBundle(), { mode: "dry_run", humanReviewed: false, dataset: "production" });
    expect(request.target.dataset).toBeNull();
  });

  it("carries the AssetBundle's seo content into the payload", () => {
    const request = buildCmsWriteRequestFromAssetBundle(fixtureAssetBundle(), { mode: "dry_run", humanReviewed: false });
    expect(request.payload.seo).toEqual({
      title: "StockTrack — Inventory Tracker",
      metaDescription: "Track stock levels without a spreadsheet.",
      primaryKeyword: "inventory tracker",
      secondaryKeywords: ["stock tracker"],
    });
  });

  it("never mutates the source AssetBundle", () => {
    const bundle = fixtureAssetBundle();
    const before = JSON.stringify(bundle);
    buildCmsWriteRequestFromAssetBundle(bundle, { mode: "dry_run", humanReviewed: false });
    expect(JSON.stringify(bundle)).toBe(before);
  });
});
