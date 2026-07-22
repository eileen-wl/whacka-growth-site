import { describe, expect, it } from "vitest";
import { renderCmsWriteMarkdown } from "../renderers/cms-write-markdown";
import { buildCmsWriteRequestFromAssetBundle } from "../cms/asset-to-cms-request";
import { buildAssetBundleId } from "../contracts/asset-bundle";
import type { AssetBundle } from "../contracts/asset-bundle";
import type { FinalCmsWriterRun } from "../types/cms-writer";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureAssetBundle(): AssetBundle {
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
  };
}

function fixtureRun(overrides: Partial<FinalCmsWriterRun> = {}): FinalCmsWriterRun {
  const bundle = fixtureAssetBundle();
  const cmsWriteRequest = buildCmsWriteRequestFromAssetBundle(bundle, { mode: "dry_run", humanReviewed: false });

  return {
    schemaVersion: "1.0.0",
    runType: "cms_writer",
    generatedAt: "2026-07-21T00:00:00.000Z",
    mode: "dry_run",
    period: PERIOD,
    campaign: CAMPAIGN,
    provenance: {
      sourceAssetGenerationFilename: "asset-generation-2026-07-08_to_2026-07-14-topic_abc.json",
      sourceAssetGenerationSha256: "hash123",
      sourceAssetGenerationGeneratedAt: "2026-07-16T00:00:00.000Z",
      sourceAssetGenerationIsMock: true,
      sourceTopicScoringIsMock: true,
      sourceTopicsHumanReviewed: false,
      selectedTopicId: "topic_abc",
      selectedScoredTopicId: "scoredtopic_abc",
      assetBundleId: bundle.id,
      allowMockInputUsed: false,
    },
    assetBundle: bundle,
    cmsWriteRequest,
    target: { projectId: null, dataset: null, apiVersion: null },
    review: { confirmedReviewed: false, reviewedBy: null, reviewNote: null },
    compatibility: { sanityAppToolCompatible: true, astroAppDataCompatible: true, seoPersistenceAvailable: true, faqMappingAvailable: true, draftOnly: true, publishPerformed: false, siteModified: false, warnings: [] },
    writeStatus: "not_attempted",
    receipt: null,
    ...overrides,
  };
}

describe("renderCmsWriteMarkdown", () => {
  it("renders all required top-level sections", () => {
    const md = renderCmsWriteMarkdown(fixtureRun());
    for (const heading of [
      "# CMS Write Review",
      "## Mode",
      "## Source Asset",
      "## Human Review",
      "## Target Sanity Document",
      "## Content Summary",
      "## SEO Fields",
      "## CTA and UTM Mapping",
      "## Payload Compatibility",
      "## Draft Write Status",
      "## Remaining Manual Actions",
      "## Provenance",
      "## Security Notes",
    ]) {
      expect(md).toContain(heading);
    }
  });

  it("states no network request was made for a dry-run", () => {
    const md = renderCmsWriteMarkdown(fixtureRun());
    expect(md).toContain("No network request was made");
  });

  it("uses the drafts.-prefixed id as the actual write target, distinct from the canonical id", () => {
    const md = renderCmsWriteMarkdown(fixtureRun());
    expect(md).toContain("drafts.appTool-inventory-tracker");
    expect(md).toContain("appTool-inventory-tracker");
  });

  it("confirms SEO fields are persisted and no longer a mapping gap", () => {
    const md = renderCmsWriteMarkdown(fixtureRun());
    expect(md).toContain("no longer a mapping gap");
    expect(md).toContain("Inventory Tracker"); // seo.title fixture value
  });

  it("shows draft write status as not attempted for a dry-run", () => {
    const md = renderCmsWriteMarkdown(fixtureRun());
    expect(md).toContain("Not attempted (dry-run).");
  });

  it("shows a succeeded draft write with a revision id when a receipt is present", () => {
    const run = fixtureRun({
      mode: "draft_write",
      writeStatus: "succeeded",
      target: { projectId: "proj123", dataset: "production", apiVersion: "2024-01-01" },
      review: { confirmedReviewed: true, reviewedBy: "Joy", reviewNote: "Looks good." },
      receipt: {
        draftDocumentId: "drafts.appTool-inventory-tracker",
        canonicalDocumentId: "appTool-inventory-tracker",
        projectId: "proj123",
        dataset: "production",
        operation: "create_or_replace",
        revisionId: "rev1",
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
        writtenAt: "2026-07-21T00:00:00.000Z",
        assetBundleId: fixtureAssetBundle().id,
        cmsWriteRequestId: "cmswriterequest_abc",
        idempotencyKey: "idempotency_abc",
      },
    });
    const md = renderCmsWriteMarkdown(run);
    expect(md).toContain("Succeeded.");
    expect(md).toContain("rev1");
    expect(md).toContain("Joy");
    expect(md).toContain("was **not** modified automatically");
    expect(md).toContain("**Publish performed:** No");
  });

  it("never renders a token, authorization header, or credential path", () => {
    const md = renderCmsWriteMarkdown(fixtureRun());
    expect(md.toLowerCase()).not.toContain("bearer ");
    expect(md.toLowerCase()).not.toContain("sanity_api_token=");
  });

  it("shows a mock-generation warning prominently", () => {
    const md = renderCmsWriteMarkdown(fixtureRun());
    expect(md).toContain("Mock Provider");
  });

  it("shows the mock-input override notice when used", () => {
    const run = fixtureRun({ provenance: { ...fixtureRun().provenance, allowMockInputUsed: true } });
    const md = renderCmsWriteMarkdown(run);
    expect(md).toContain("--allow-mock-input");
  });

  it("does not throw for a run with no warnings and no receipt", () => {
    expect(() => renderCmsWriteMarkdown(fixtureRun())).not.toThrow();
  });
});
