import { describe, expect, it, vi } from "vitest";
import { SanityConfigError, SanityWriteError, writeSanityDraft } from "../cms/sanity-draft-writer";
import { buildCmsWriteRequestFromAssetBundle, buildDraftDocumentId } from "../cms/asset-to-cms-request";
import { buildAssetBundleId } from "../contracts/asset-bundle";
import type { SanityWriteClient } from "../cms/sanity-draft-writer";
import type { AssetBundle } from "../contracts/asset-bundle";

/**
 * `@sanity/client` is never imported or constructed for real here — every
 * test injects a fake SanityWriteClient. No real Sanity project is ever
 * contacted by this test file.
 */

function fixtureAssetBundle(): AssetBundle {
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
      faq: [],
      status: "draft",
    },
    creativeBrief: { hook: "Never run out of stock again.", persona: "Small shop owner", scenario: null, steps: [] },
    seo: { title: "StockTrack", metaDescription: "Track stock levels without a spreadsheet.", primaryKeyword: "inventory tracker", secondaryKeywords: [] },
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
  };
}

function fixtureRequest() {
  return buildCmsWriteRequestFromAssetBundle(fixtureAssetBundle(), { mode: "draft_write", humanReviewed: true, dataset: "production" });
}

describe("writeSanityDraft", () => {
  it("sends a document whose _id is the drafts.-prefixed id, never the canonical id", async () => {
    const createOrReplace = vi.fn(async (doc: Record<string, unknown>) => ({ _id: doc._id as string, _rev: "rev1", _createdAt: "2026-07-20T00:00:00.000Z", _updatedAt: "2026-07-20T00:00:00.000Z" }));
    const client: SanityWriteClient = { createOrReplace };
    const request = fixtureRequest();
    const draftDocumentId = buildDraftDocumentId(request.target.documentId);

    await writeSanityDraft({ client, request, draftDocumentId });

    expect(createOrReplace).toHaveBeenCalledTimes(1);
    const sentDoc = createOrReplace.mock.calls[0][0] as Record<string, unknown>;
    expect(sentDoc._id).toBe("drafts.appTool-stocktrack");
    expect(sentDoc._id).not.toBe(request.target.documentId);
  });

  it("never calls anything named publish", async () => {
    const client: SanityWriteClient & { publish?: unknown } = {
      createOrReplace: vi.fn(async (doc: Record<string, unknown>) => ({ _id: doc._id as string })),
    };
    const request = fixtureRequest();
    await writeSanityDraft({ client, request, draftDocumentId: buildDraftDocumentId(request.target.documentId) });
    expect(client.publish).toBeUndefined();
  });

  it("returns a sanitized result with both the draft and canonical ids", async () => {
    const client: SanityWriteClient = {
      createOrReplace: vi.fn(async (doc: Record<string, unknown>) => ({ _id: doc._id as string, _rev: "rev1", _createdAt: "2026-07-20T00:00:00.000Z", _updatedAt: "2026-07-20T00:00:00.000Z" })),
    };
    const request = fixtureRequest();
    const result = await writeSanityDraft({ client, request, draftDocumentId: buildDraftDocumentId(request.target.documentId) });
    expect(result).toEqual({
      draftDocumentId: "drafts.appTool-stocktrack",
      canonicalDocumentId: "appTool-stocktrack",
      revisionId: "rev1",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    });
  });

  it("refuses to write a document id that is not drafts.-prefixed", async () => {
    const client: SanityWriteClient = { createOrReplace: vi.fn(async (doc: Record<string, unknown>) => ({ _id: doc._id as string })) };
    const request = fixtureRequest();
    await expect(writeSanityDraft({ client, request, draftDocumentId: request.target.documentId })).rejects.toThrow(SanityConfigError);
    expect(client.createOrReplace).not.toHaveBeenCalled();
  });

  it("sanitizes an authentication failure (401) without leaking a token", async () => {
    const client: SanityWriteClient = {
      createOrReplace: vi.fn(async () => {
        const err = new Error("Unauthorized: Bearer sk-secret-token-xyz was rejected") as Error & { statusCode: number };
        err.statusCode = 401;
        throw err;
      }),
    };
    const request = fixtureRequest();
    try {
      await writeSanityDraft({ client, request, draftDocumentId: buildDraftDocumentId(request.target.documentId) });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SanityWriteError);
      expect((err as SanityWriteError).reason).toBe("authentication_error");
      expect((err as Error).message).not.toContain("sk-secret-token-xyz");
      expect((err as Error).message.toLowerCase()).not.toContain("bearer sk-secret-token-xyz".toLowerCase());
    }
  });

  it("sanitizes a permission failure (403)", async () => {
    const client: SanityWriteClient = {
      createOrReplace: vi.fn(async () => {
        const err = new Error("Insufficient permissions") as Error & { statusCode: number };
        err.statusCode = 403;
        throw err;
      }),
    };
    const request = fixtureRequest();
    await expect(writeSanityDraft({ client, request, draftDocumentId: buildDraftDocumentId(request.target.documentId) })).rejects.toMatchObject({ reason: "permission_denied" });
  });

  it("sanitizes an invalid dataset/project failure (404)", async () => {
    const client: SanityWriteClient = {
      createOrReplace: vi.fn(async () => {
        const err = new Error("Not found") as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      }),
    };
    const request = fixtureRequest();
    await expect(writeSanityDraft({ client, request, draftDocumentId: buildDraftDocumentId(request.target.documentId) })).rejects.toMatchObject({ reason: "invalid_dataset" });
  });

  it("treats a status-less failure as a network error", async () => {
    const client: SanityWriteClient = {
      createOrReplace: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    };
    const request = fixtureRequest();
    await expect(writeSanityDraft({ client, request, draftDocumentId: buildDraftDocumentId(request.target.documentId) })).rejects.toMatchObject({ reason: "network_error" });
  });
});
