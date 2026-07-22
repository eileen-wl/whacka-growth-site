import { describe, expect, it } from "vitest";
import {
  AssetBundleToCmsWriteRequestValidationError,
  CMSWriteRequestValidationError,
  buildCmsWriteRequest,
  validateCmsWriteRequest,
} from "../contracts/cms-write-request";
import type { CMSWriteRequest } from "../contracts/cms-write-request";
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
    creativeBrief: { hook: "Never run out of stock again.", persona: "Small shop owner", scenario: null, steps: [] },
    seo: { title: "StockTrack — Inventory Tracker", metaDescription: "Track stock levels without a spreadsheet.", primaryKeyword: "inventory tracker", secondaryKeywords: [] },
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

describe("buildCmsWriteRequest", () => {
  it("builds a valid dry-run request from a valid AssetBundle", () => {
    const request = buildCmsWriteRequest(fixtureAssetBundle(), { generatedBy: "cms-writer" });
    expect(() => validateCmsWriteRequest(request)).not.toThrow();
    expect(request.mode).toBe("dry_run");
  });

  it("derives target.documentId as appTool-{slug}", () => {
    const request = buildCmsWriteRequest(fixtureAssetBundle(), { generatedBy: "cms-writer" });
    expect(request.target.documentId).toBe("appTool-stocktrack");
    expect(request.payload._id).toBe("appTool-stocktrack");
  });

  it("always forces payload.status to 'draft'", () => {
    const request = buildCmsWriteRequest(fixtureAssetBundle(), { generatedBy: "cms-writer" });
    expect(request.payload.status).toBe("draft");
  });

  it("always sets publishing.publishRequested and publishAllowed to false", () => {
    const request = buildCmsWriteRequest(fixtureAssetBundle(), { generatedBy: "cms-writer" });
    expect(request.publishing.publishRequested).toBe(false);
    expect(request.publishing.publishAllowed).toBe(false);
  });

  it("produces a stable, non-empty idempotencyKey", () => {
    const request = buildCmsWriteRequest(fixtureAssetBundle(), { generatedBy: "cms-writer" });
    expect(request.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("is deterministic: rebuilding from the same AssetBundle produces the same payload _key values", () => {
    const bundle = fixtureAssetBundle();
    const a = buildCmsWriteRequest(bundle, { generatedBy: "cms-writer" });
    const b = buildCmsWriteRequest(bundle, { generatedBy: "cms-writer" });
    expect(a.payload.screenshots[0]._key).toBe(b.payload.screenshots[0]._key);
    expect(a.payload.faq[0]._key).toBe(b.payload.faq[0]._key);
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });

  it("is valid without any CMS credentials or dataset in dry-run mode", () => {
    const request = buildCmsWriteRequest(fixtureAssetBundle(), { generatedBy: "cms-writer", mode: "dry_run" });
    expect(request.target.dataset).toBeNull();
  });

  it("rejects building from an invalid AssetBundle", () => {
    const invalidBundle = { ...fixtureAssetBundle(), app: { ...fixtureAssetBundle().app, appPrompt: "" } };
    expect(() => buildCmsWriteRequest(invalidBundle, { generatedBy: "cms-writer" })).toThrow(AssetBundleToCmsWriteRequestValidationError);
  });

  it("carries demoUrl/remixUrl/buildUrl/utmContent through from AssetBundle.cta", () => {
    const bundle = fixtureAssetBundle({ cta: { ...fixtureAssetBundle().cta, buildUrl: "https://whacka.example.com/build/stocktrack" } });
    const request = buildCmsWriteRequest(bundle, { generatedBy: "cms-writer" });
    expect(request.payload.buildUrl).toBe("https://whacka.example.com/build/stocktrack");
    expect(request.payload.utmContent).toBe("stocktrack_launch");
  });

  it("maps AssetBundle.seo onto payload.seo", () => {
    const request = buildCmsWriteRequest(fixtureAssetBundle(), { generatedBy: "cms-writer" });
    expect(request.payload.seo).toEqual({
      title: "StockTrack — Inventory Tracker",
      metaDescription: "Track stock levels without a spreadsheet.",
      primaryKeyword: "inventory tracker",
      secondaryKeywords: [],
    });
  });

  it("never includes social posts or the collection-level social strategy in the appTool payload, even when the source AssetBundle has them", () => {
    const bundle = fixtureAssetBundle({
      social: {
        posts: [{ channel: "linkedin", text: "This toolkit includes several small-business ideas." }],
        strategy: {
          scope: "collection",
          campaignId: "test_campaign",
          campaignName: "Test Campaign",
          featuredAppSlugs: ["stocktrack", "orderly", "bookly"],
          destinationUrl: "https://whacka-growth-site.vercel.app",
          utmContent: "collection_test_campaign",
        },
      },
    });
    const request = buildCmsWriteRequest(bundle, { generatedBy: "cms-writer" });
    const payloadKeys = Object.keys(request.payload);
    expect(payloadKeys).not.toContain("social");
    expect(payloadKeys).not.toContain("socialPosts");
    expect(payloadKeys).not.toContain("strategy");
    expect(payloadKeys).not.toContain("featuredAppSlugs");
    expect(JSON.stringify(request.payload).toLowerCase()).not.toContain("collection");
    expect(JSON.stringify(request.payload).toLowerCase()).not.toContain("linkedin");
  });
});

describe("cmsWriteRequestSchema", () => {
  function fixtureRequest(overrides: Partial<CMSWriteRequest> = {}): CMSWriteRequest {
    const base = buildCmsWriteRequest(fixtureAssetBundle(), { generatedBy: "cms-writer" });
    return { ...base, ...overrides };
  }

  it("rejects a request where publishRequested is true", () => {
    const request = { ...fixtureRequest(), publishing: { publishRequested: true as unknown as false, publishAllowed: false } };
    expect(() => validateCmsWriteRequest(request)).toThrow(CMSWriteRequestValidationError);
  });

  it("rejects a request where publishAllowed is true", () => {
    const request = { ...fixtureRequest(), publishing: { publishRequested: false, publishAllowed: true as unknown as false } };
    expect(() => validateCmsWriteRequest(request)).toThrow(CMSWriteRequestValidationError);
  });

  it("rejects a payload._id that doesn't match target.documentId", () => {
    const request = fixtureRequest();
    const mismatched = { ...request, payload: { ...request.payload, _id: "appTool-different-slug" } };
    expect(() => validateCmsWriteRequest(mismatched)).toThrow(CMSWriteRequestValidationError);
  });

  it("rejects a payload missing a required Sanity field (name)", () => {
    const request = fixtureRequest() as unknown as Record<string, unknown>;
    const payload = request.payload as Record<string, unknown>;
    delete payload.name;
    expect(() => validateCmsWriteRequest(request)).toThrow(CMSWriteRequestValidationError);
  });

  it("rejects a request that includes an auth token field", () => {
    const request = { ...fixtureRequest(), authToken: "sk-test" };
    expect(() => validateCmsWriteRequest(request)).toThrow(CMSWriteRequestValidationError);
  });

  it("rejects a payload missing the seo object", () => {
    const request = fixtureRequest() as unknown as Record<string, unknown>;
    const payload = request.payload as Record<string, unknown>;
    delete payload.seo;
    expect(() => validateCmsWriteRequest(request)).toThrow(CMSWriteRequestValidationError);
  });

  it("accepts a draft_write mode request with a dataset", () => {
    const request = buildCmsWriteRequest(fixtureAssetBundle(), { generatedBy: "cms-writer", mode: "draft_write", dataset: "production" });
    expect(() => validateCmsWriteRequest(request)).not.toThrow();
    expect(request.target.dataset).toBe("production");
  });

  it("throws on an unsupported major schema version", () => {
    expect(() => validateCmsWriteRequest(fixtureRequest({ schemaVersion: "99.0.0" }))).toThrow();
  });
});
