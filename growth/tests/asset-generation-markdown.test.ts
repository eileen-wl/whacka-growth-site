import { describe, expect, it } from "vitest";
import { renderAssetGenerationMarkdown } from "../renderers/asset-generation-markdown";
import type { FinalAssetGenerationRun } from "../types/asset-generation";
import type { TopicCandidate } from "../contracts/topic-candidate";
import type { ScoredTopic } from "../contracts/scored-topic";
import type { AssetBundle } from "../contracts/asset-bundle";

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

function fixtureAssetBundle(): AssetBundle {
  return {
    schemaVersion: "1.0.0",
    id: "assetbundle_abc",
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
    validation: {
      status: "needs_review",
      warnings: ["Source Topic Scoring run was mock-generated (generation.isMock = true)."],
      humanReviewRequired: true,
    },
    provenance: { generatedBy: "asset-generation-agent", sourceFileNames: ["topic-scoring-x.json"], sourceHashes: ["hash"], sourceRecordIds: ["scoredtopic_abc"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
  };
}

function fixtureRun(overrides: Partial<FinalAssetGenerationRun> = {}): FinalAssetGenerationRun {
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

describe("renderAssetGenerationMarkdown", () => {
  it("renders all required top-level sections", () => {
    const md = renderAssetGenerationMarkdown(fixtureRun());
    for (const heading of [
      "# Asset Generation Review",
      "## Reporting Period",
      "## Campaign",
      "## Selected Topic",
      "## Proposed App",
      "## SEO Assets",
      "## CTA Configuration",
      "## Social Assets",
      "## Generation Assumptions and Limitations",
      "## Compatibility Status",
      "## Human Review Required",
      "## Generation Metadata",
    ]) {
      expect(md).toContain(heading);
    }
  });

  it("shows the topic score and recommendation", () => {
    const md = renderAssetGenerationMarkdown(fixtureRun());
    expect(md).toContain("72 / 100");
    expect(md).toContain("advance");
  });

  it("shows the app prompt", () => {
    const md = renderAssetGenerationMarkdown(fixtureRun());
    expect(md).toContain("Build a mini app called Inventory Tracker.");
  });

  it("confirms SEO fields are persisted by the current Sanity appTool schema", () => {
    const md = renderAssetGenerationMarkdown(fixtureRun());
    expect(md).toContain("SEO fields are persisted by the current Sanity `appTool` schema");
  });

  it("displays a null CTA URL as Unavailable, never blank or a placeholder", () => {
    const md = renderAssetGenerationMarkdown(fixtureRun());
    expect(md).toContain("**Demo URL:** Unavailable");
    expect(md).toContain("**Remix URL:** Unavailable");
    expect(md).not.toContain("**Demo URL:** \n");
  });

  it("shows a real build URL when available", () => {
    const md = renderAssetGenerationMarkdown(fixtureRun());
    expect(md).toContain("**Build URL:** https://whacka.app/dashboard");
  });

  it("states 'No social channels were requested' when social.posts is empty", () => {
    const md = renderAssetGenerationMarkdown(fixtureRun());
    expect(md).toContain("No social channels were requested.");
  });

  it("renders requested-channel posts when present", () => {
    const bundle = fixtureAssetBundle();
    bundle.social.posts = [{ channel: "linkedin", text: "Proposed concept: Inventory Tracker." }];
    const md = renderAssetGenerationMarkdown(fixtureRun({ assetBundle: bundle }));
    expect(md).toContain("### linkedin");
    expect(md).toContain("Proposed concept: Inventory Tracker.");
  });

  it("shows the collection social strategy — scope, campaign, featured apps, destination — prominently, distinct from this one app", () => {
    const bundle = {
      ...fixtureAssetBundle(),
      social: {
        posts: [{ channel: "linkedin", text: "This toolkit includes several small-business ideas." }],
        strategy: {
          scope: "collection" as const,
          campaignId: CAMPAIGN.id,
          campaignName: CAMPAIGN.name,
          featuredAppSlugs: ["inventory-tracker", "orderly", "bookly"],
          destinationUrl: "https://whacka-growth-site.vercel.app",
          utmContent: `collection_${CAMPAIGN.id}`,
        },
      },
    };
    const md = renderAssetGenerationMarkdown(fixtureRun({ assetBundle: bundle }));
    expect(md).toContain("promotes the **collection/campaign**");
    expect(md).toContain("**Scope:** collection");
    expect(md).toContain("orderly");
    expect(md).toContain("bookly");
    expect(md).toContain("https://whacka-growth-site.vercel.app");
  });

  it("shows a not-configured warning when destinationUrl is null", () => {
    const bundle = {
      ...fixtureAssetBundle(),
      social: {
        posts: [{ channel: "linkedin", text: "This toolkit includes several small-business ideas." }],
        strategy: {
          scope: "collection" as const,
          campaignId: CAMPAIGN.id,
          campaignName: CAMPAIGN.name,
          featuredAppSlugs: ["inventory-tracker", "orderly", "bookly"],
          destinationUrl: null,
          utmContent: `collection_${CAMPAIGN.id}`,
        },
      },
    };
    const md = renderAssetGenerationMarkdown(fixtureRun({ assetBundle: bundle }));
    expect(md).toContain("No public collection landing page URL is configured");
  });

  it("does not render a strategy section when social.strategy is absent (zero posts)", () => {
    const bundle = { ...fixtureAssetBundle(), social: { posts: [] } };
    const md = renderAssetGenerationMarkdown(fixtureRun({ assetBundle: bundle }));
    expect(md).not.toContain("**Scope:** collection");
  });

  it("shows a mock-generation warning prominently", () => {
    const md = renderAssetGenerationMarkdown(fixtureRun());
    expect(md).toContain("Mock Provider");
  });

  it("shows an unapproved-topic warning when the topic was not automatically approved", () => {
    const md = renderAssetGenerationMarkdown(fixtureRun());
    expect(md).toContain("not automatically approved");
  });

  it("confirms no CMS write happened", () => {
    const md = renderAssetGenerationMarkdown(fixtureRun());
    expect(md).toContain("did **not** write to Sanity");
  });

  it("shows the human-review requirement", () => {
    const md = renderAssetGenerationMarkdown(fixtureRun());
    expect(md).toMatch(/\*\*Required:\*\* Yes/);
    expect(md).toMatch(/\*\*Approved:\*\* No/);
  });

  it("shows override flags when used", () => {
    const md = renderAssetGenerationMarkdown(fixtureRun({ provenance: { ...fixtureRun().provenance, allowUnapprovedTopicUsed: true } }));
    expect(md).toContain("--allow-unapproved-topic");
  });

  it("does not throw for a run with no overrides and no warnings", () => {
    const bundle = fixtureAssetBundle();
    bundle.validation.warnings = [];
    expect(() => renderAssetGenerationMarkdown(fixtureRun({ assetBundle: bundle }))).not.toThrow();
  });

  it("shows a prominent integration-test banner with source recommendation and reviewer, and never claims business approval", () => {
    const md = renderAssetGenerationMarkdown(
      fixtureRun({
        executionPurpose: "integration_test",
        integrationTestReview: { confirmed: true, reviewedBy: "Joy", reviewNote: "Engineering check only.", sourceRecommendation: "hold", businessApprovalGranted: false },
      })
    );
    expect(md).toContain("ENGINEERING INTEGRATION TEST");
    expect(md).toContain("**hold**");
    expect(md).toContain("Joy");
    expect(md).toContain("Engineering check only.");
    expect(md).toContain("Business approval: **not granted**");
    expect(md).toContain(`- **Execution purpose:** integration_test`);
  });

  it("does not show the integration-test banner for a normal business_experiment run", () => {
    const md = renderAssetGenerationMarkdown(fixtureRun());
    expect(md).not.toContain("ENGINEERING INTEGRATION TEST");
    expect(md).toContain(`- **Execution purpose:** business_experiment`);
  });
});
