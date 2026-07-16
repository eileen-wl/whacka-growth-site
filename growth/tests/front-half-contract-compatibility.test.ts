import { describe, expect, it } from "vitest";
import { buildSignalCandidateId, validateSignalCandidate } from "../contracts/signal-candidate";
import type { SignalCandidate } from "../contracts/signal-candidate";
import { buildTopicCandidateId, validateSignalsForTopic, validateTopicCandidate } from "../contracts/topic-candidate";
import type { TopicCandidate } from "../contracts/topic-candidate";
import { buildScoredTopicId, computeTotalScore, computeWeightedScore, validateScoredTopic, validateTopicForScoring } from "../contracts/scored-topic";
import type { ScoredTopic } from "../contracts/scored-topic";
import { buildAssetBundleId, validateAssetBundle, validateScoredTopicForAssetGeneration } from "../contracts/asset-bundle";
import type { AssetBundle } from "../contracts/asset-bundle";
import { buildCmsWriteRequest, validateCmsWriteRequest } from "../contracts/cms-write-request";
import { buildGrowthLoopFeedback, validateGrowthLoopFeedback } from "../contracts/loop-feedback";
import type { FinalExperimentDecision } from "../types/experiment-decision";

const CAMPAIGN_ID = "test_campaign";

describe("front-half contract compatibility chain", () => {
  it("SignalCandidate[] -> TopicCandidate -> ScoredTopic -> AssetBundle -> CMSWriteRequest", () => {
    // Step 1: two independent SignalCandidates observed by Signal Mining.
    const signalA: SignalCandidate = {
      schemaVersion: "1.0.0",
      id: buildSignalCandidateId({ sourceType: "search_console", sourceName: "Google Search Console", sourceRecordId: "q1", title: "inventory tracker for small shop" }),
      campaignId: CAMPAIGN_ID,
      capturedAt: "2026-07-15T00:00:00.000Z",
      source: { type: "search_console", name: "Google Search Console", recordId: "q1", url: null, publishedAt: null, retrievedAt: "2026-07-15T00:00:00.000Z", isInternal: true },
      signalType: "search_query",
      title: "inventory tracker for small shop",
      summary: "Recurring search query for a small-shop inventory tracker.",
      evidenceExcerpt: null,
      entities: { keywords: ["inventory tracker"], topics: [], audiences: ["small shop owners"], productsOrApps: [], channels: [] },
      metrics: [{ name: "impressions", value: 340, unit: "count", measurementBasis: "GSC queries report sum", period: "2026-07-08_to_2026-07-14" }],
      quality: { confidence: "medium", freshness: "fresh", duplicateStatus: "unique", limitations: [] },
      humanReviewRequired: true,
      provenance: { generatedBy: "signal-mining-agent", sourceFileNames: ["gsc-queries-2026-07-08_to_2026-07-14.json"], sourceHashes: ["hash-a"], sourceRecordIds: ["q1"], sourceDecisionId: null, provider: null, model: null, isMock: false, humanReviewed: false },
    };
    const signalB: SignalCandidate = {
      ...signalA,
      id: buildSignalCandidateId({ sourceType: "user_feedback", sourceName: "Support inbox", sourceRecordId: "ticket-9", title: "need a way to track stock" }),
      source: { type: "user_feedback", name: "Support inbox", recordId: "ticket-9", url: null, publishedAt: null, retrievedAt: "2026-07-15T00:00:00.000Z", isInternal: true },
      signalType: "feature_request",
      title: "need a way to track stock",
      summary: "A customer asked for a simple way to track stock levels.",
      metrics: [],
      provenance: { generatedBy: "signal-mining-agent", sourceFileNames: ["support-export.json"], sourceHashes: ["hash-b"], sourceRecordIds: ["ticket-9"], sourceDecisionId: null, provider: null, model: null, isMock: false, humanReviewed: false },
    };
    validateSignalCandidate(signalA);
    validateSignalCandidate(signalB);
    const signalsBeforeSnapshot = JSON.stringify([signalA, signalB]);

    const validatedSignals = validateSignalsForTopic([signalA, signalB]);
    expect(validatedSignals).toHaveLength(2);

    // Step 2: normalize into one TopicCandidate, citing both signals.
    const topic: TopicCandidate = {
      schemaVersion: "1.0.0",
      id: buildTopicCandidateId({ campaignId: CAMPAIGN_ID, canonicalName: "Inventory Tracker" }),
      campaignId: CAMPAIGN_ID,
      createdAt: "2026-07-15T01:00:00.000Z",
      canonicalName: "Inventory Tracker",
      slug: "inventory-tracker",
      aliases: ["Stock Tracker"],
      problemStatement: "Small shop owners lose track of stock levels across notebooks and texts.",
      targetAudience: "Small retail shop owners",
      useCases: ["Log stock counts per product", "Get low-stock alerts"],
      desiredOutcome: "Fewer missed orders and stockouts.",
      signalRefs: [signalA.id, signalB.id],
      evidenceSummary: { signalCount: 2, sourceCount: 2, sourceTypes: ["search_console", "user_feedback"], confidence: "medium", limitations: [] },
      relationshipToExistingContent: { status: "related_to_existing_app", relatedTopicIds: [], relatedAppSlugs: ["orderly"] },
      status: "candidate",
      rejection: null,
      provenance: { generatedBy: "topic-scoring-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: [signalA.id, signalB.id], sourceDecisionId: null, provider: null, model: null, isMock: false, humanReviewed: false },
    };
    validateTopicCandidate(topic);
    expect(JSON.stringify([signalA, signalB])).toBe(signalsBeforeSnapshot);

    const topicForScoring = validateTopicForScoring(topic);
    const topicBeforeSnapshot = JSON.stringify(topicForScoring);

    // Step 3: score the topic.
    const dimensions: ScoredTopic["dimensions"] = [
      { key: "demand", label: "Demand", score: 75, weight: 0.4, weightedScore: computeWeightedScore(75, 0.4), rationale: "Two independent signals corroborate demand.", signalRefs: [signalA.id, signalB.id], evidenceRefs: [], limitations: [] },
      { key: "product_fit", label: "Product fit", score: 80, weight: 0.6, weightedScore: computeWeightedScore(80, 0.6), rationale: "Matches the existing Orderly app category.", signalRefs: [], evidenceRefs: [], limitations: [] },
    ];
    const scoredTopic: ScoredTopic = {
      schemaVersion: "1.0.0",
      id: buildScoredTopicId({ topicId: topic.id, scoringVersion: "v1" }),
      topicId: topic.id,
      campaignId: CAMPAIGN_ID,
      scoredAt: "2026-07-15T02:00:00.000Z",
      scoringVersion: "v1",
      dimensions,
      totalScore: computeTotalScore(dimensions),
      ranking: { rank: 1, candidateCount: 1 },
      confidence: "medium",
      recommendation: "advance",
      blockers: [],
      humanReviewRequired: true,
      provenance: { generatedBy: "topic-scoring-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: [topic.id], sourceDecisionId: null, provider: null, model: null, isMock: false, humanReviewed: false },
    };
    validateScoredTopic(scoredTopic);
    expect(JSON.stringify(topicForScoring)).toBe(topicBeforeSnapshot);

    const scoredTopicForGeneration = validateScoredTopicForAssetGeneration(scoredTopic);
    const scoredTopicBeforeSnapshot = JSON.stringify(scoredTopicForGeneration);

    // Step 4: generate the asset bundle for the approved, scored topic.
    const assetBundle: AssetBundle = {
      schemaVersion: "1.0.0",
      id: buildAssetBundleId({ scoredTopicId: scoredTopic.id, promptVersion: "v1" }),
      scoredTopicId: scoredTopic.id,
      topicId: topic.id,
      campaignId: CAMPAIGN_ID,
      generatedAt: "2026-07-15T03:00:00.000Z",
      app: {
        name: "StockTrack",
        slug: "stocktrack",
        tagline: "Simple inventory tracking",
        category: "Orders & Inventory",
        shortDescription: "Track stock levels without a spreadsheet.",
        image: "/images/stocktrack/cover.svg",
        screenshots: [{ image: "/images/stocktrack/screenshot-1.svg", caption: "Dashboard" }],
        problem: topic.problemStatement,
        solution: "StockTrack gives one place to log stock counts and get low-stock alerts.",
        whoItsFor: [topic.targetAudience],
        appPrompt: "Build a mini app called StockTrack for a small shop to track stock levels and get low-stock alerts.",
        ctaLabel: "Build StockTrack with Whacka",
        ctaHref: "#",
        relatedSlugs: ["orderly"],
        faq: [{ question: "Is this free?", answer: "Whacka mini apps are generated on demand." }],
        status: "draft",
      },
      creativeBrief: { hook: "Never run out of stock again.", persona: topic.targetAudience, scenario: null, steps: topic.useCases },
      seo: { title: "StockTrack — Inventory Tracker", metaDescription: "Track stock levels without a spreadsheet.", primaryKeyword: "inventory tracker", secondaryKeywords: ["stock tracker"] },
      cta: { primaryType: "build", demoUrl: null, remixUrl: null, buildUrl: null, labels: { viewDemo: null, remix: null, build: "Build StockTrack with Whacka", copyPrompt: null }, utmContent: "stocktrack_launch" },
      social: { posts: [] },
      generation: { provider: "mock", model: null, isMock: true, promptVersion: "v1", evidenceRefs: [], signalRefs: [signalA.id, signalB.id], findingRefs: [] },
      validation: { status: "needs_review", warnings: [], humanReviewRequired: true },
      provenance: { generatedBy: "asset-generation-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: [scoredTopic.id], sourceDecisionId: null, provider: "mock", model: null, isMock: true, humanReviewed: false },
    };
    validateAssetBundle(assetBundle);
    expect(JSON.stringify(scoredTopicForGeneration)).toBe(scoredTopicBeforeSnapshot);

    const assetBundleBeforeSnapshot = JSON.stringify(assetBundle);

    // Step 5 (input side only): build the CMSWriteRequest.
    const cmsWriteRequest = buildCmsWriteRequest(assetBundle, { generatedBy: "cms-writer" });
    validateCmsWriteRequest(cmsWriteRequest);
    expect(JSON.stringify(assetBundle)).toBe(assetBundleBeforeSnapshot);

    // Traceability: the CMSWriteRequest can be traced back through the whole chain.
    expect(cmsWriteRequest.assetBundleId).toBe(assetBundle.id);
    expect(assetBundle.scoredTopicId).toBe(scoredTopic.id);
    expect(scoredTopic.topicId).toBe(topic.id);
    expect(topic.signalRefs).toEqual([signalA.id, signalB.id]);

    // Draft-only guarantees survive the whole chain.
    expect(cmsWriteRequest.payload.status).toBe("draft");
    expect(cmsWriteRequest.publishing.publishRequested).toBe(false);
    expect(cmsWriteRequest.publishing.publishAllowed).toBe(false);
  });

  it("rejects a rejected TopicCandidate from proceeding to scoring", () => {
    const topic: TopicCandidate = {
      schemaVersion: "1.0.0",
      id: buildTopicCandidateId({ campaignId: CAMPAIGN_ID, canonicalName: "Dead End Topic" }),
      campaignId: CAMPAIGN_ID,
      createdAt: "2026-07-15T01:00:00.000Z",
      canonicalName: "Dead End Topic",
      slug: "dead-end-topic",
      aliases: [],
      problemStatement: "x",
      targetAudience: "x",
      useCases: [],
      desiredOutcome: "x",
      signalRefs: ["signal_x"],
      evidenceSummary: { signalCount: 1, sourceCount: 1, sourceTypes: ["manual"], confidence: "low", limitations: [] },
      relationshipToExistingContent: { status: "new", relatedTopicIds: [], relatedAppSlugs: [] },
      status: "rejected",
      rejection: { reason: "Not a fit for the current audience.", rejectedAt: "2026-07-15T01:30:00.000Z" },
      provenance: { generatedBy: "topic-scoring-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: [], sourceDecisionId: null, provider: null, model: null, isMock: false, humanReviewed: false },
    };
    validateTopicCandidate(topic);
    expect(() => validateTopicForScoring(topic)).toThrow();
  });

  it("rejects a 'reject'-recommended ScoredTopic from proceeding to asset generation", () => {
    const dimensions: ScoredTopic["dimensions"] = [
      { key: "demand", label: "Demand", score: 10, weight: 1, weightedScore: computeWeightedScore(10, 1), rationale: "Very low demand observed.", signalRefs: [], evidenceRefs: [], limitations: [] },
    ];
    const scoredTopic: ScoredTopic = {
      schemaVersion: "1.0.0",
      id: buildScoredTopicId({ topicId: "topic_low", scoringVersion: "v1" }),
      topicId: "topic_low",
      campaignId: CAMPAIGN_ID,
      scoredAt: "2026-07-15T02:00:00.000Z",
      scoringVersion: "v1",
      dimensions,
      totalScore: computeTotalScore(dimensions),
      ranking: null,
      confidence: "low",
      recommendation: "reject",
      blockers: ["Insufficient demand evidence."],
      humanReviewRequired: true,
      provenance: { generatedBy: "topic-scoring-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: [], sourceDecisionId: null, provider: null, model: null, isMock: false, humanReviewed: false },
    };
    validateScoredTopic(scoredTopic);
    expect(() => validateScoredTopicForAssetGeneration(scoredTopic)).toThrow();
  });
});

describe("FinalExperimentDecision -> GrowthLoopFeedback compatibility", () => {
  function fixtureDecision(): FinalExperimentDecision {
    return {
      schemaVersion: "1.0.0",
      decisionType: "experiment_decision",
      generatedAt: "2026-07-15T04:00:00.000Z",
      period: { start: "2026-07-08", end: "2026-07-14" },
      campaign: { id: CAMPAIGN_ID, name: "Test Campaign" },
      provenance: {
        sourceGrowthReportFilename: "growth-report-2026-07-08_to_2026-07-14.json",
        sourceGrowthReportSha256: "report-hash",
        sourceGrowthReportGeneratedAt: "2026-07-14T23:00:00.000Z",
        sourceGrowthReportProvider: "mock",
        sourceGrowthReportModel: "mock-model",
        sourceGrowthReportIsMock: true,
        sourceDataQualityStatus: "partial",
      },
      generation: { provider: "mock", model: "mock-model", language: "en", isMock: true, requestId: null, stopReason: null, usage: { inputTokens: null, outputTokens: null } },
      decisionScope: { availableTopics: ["inventory tracking"], availableCtaTypes: ["build"], availableChannels: ["organic_search"] },
      evidenceCatalog: [{ id: "traffic.sessions", label: "GA4 sessions", value: 200, source: "GA4", measurementBasis: "sum" }],
      findingCatalog: [{ id: "finding.growth", title: "Growth observed", observation: "Sessions grew week over week.", interpretation: "Demand is increasing.", evidenceRefs: ["traffic.sessions"], confidence: "medium" }],
      limitationCatalog: [{ id: "data_limit.partial_data_quality", title: "Partial data quality", impact: "Some sources incomplete.", relatedEvidenceRefs: [] }],
      decision: {
        decisionSummary: { decisionStatus: "proceed", headline: "Test a build CTA.", rationale: "Growth trend supports a CTA experiment.", confidence: "medium", recommendedExperimentId: "exp_1" },
        rankedExperimentOptions: [
          {
            id: "exp_1",
            rank: 1,
            lever: "cta",
            title: "Swap to build CTA",
            target: { topicOrApp: "inventory tracking", ctaType: "build", channel: "organic_search" },
            hypothesis: "Build CTA converts better.",
            proposedChange: "Change CTA type to build.",
            controlDescription: "Current CTA.",
            variantDescription: "New build CTA.",
            measurementPlan: { primaryMetricRef: "traffic.sessions", expectedDirection: "increase", successCriterion: "10% lift in build clicks.", guardrailMetricRefs: [], measurementCaveats: [] },
            evidenceRefs: ["traffic.sessions"],
            findingRefs: ["finding.growth"],
            limitationRefs: [],
            confidence: "medium",
            dependencies: [],
            risks: [],
            whyNotHigherRanked: null,
          },
        ],
        recommendedExperiment: {
          experimentId: "exp_1",
          objective: "Increase build-CTA engagement for inventory tracking.",
          hypothesis: "Build CTA converts better.",
          implementationBrief: { change: "Swap CTA to build.", unchangedElements: [], targetPagesOrApps: ["orderly"], targetCta: "build", targetChannel: "organic_search" },
          measurementPlan: { primaryMetricRef: "traffic.sessions", secondaryMetricRefs: [], guardrailMetricRefs: [], successCriterion: "10% lift.", failureCriterion: "No lift within 30 days.", minimumObservationRequirement: "30 days.", knownMeasurementLimitations: [] },
          evidenceRefs: ["traffic.sessions"],
          findingRefs: ["finding.growth"],
          confidence: "medium",
        },
        deferDecision: null,
        rejectedOrDeferredOptions: [],
        handoff: { forNextLoop: [{ item: "Update topic pool once the CTA test concludes.", destination: "topic_pool", reason: "Feeds next scoring cycle." }], humanReviewRequired: true },
      },
      humanReview: { required: true, approved: false, approvedBy: null, approvedAt: null, note: "Awaiting human review." },
      dataQuality: {
        overallStatus: "partial",
        dateRangeMatch: true,
        missingSources: [],
        emptySources: [],
        warnings: [],
        measurementNotes: [],
      },
    };
  }

  it("builds valid GrowthLoopFeedback that provides a valid input context for the next Signal Mining / Topic Pool cycle", () => {
    const decision = fixtureDecision();
    const before = JSON.stringify(decision);

    const feedback = buildGrowthLoopFeedback(decision, { sourceDecisionFilename: "experiment-decision-2026-07-08_to_2026-07-14.json", sourceDecisionSha256: "decision-hash" });
    validateGrowthLoopFeedback(feedback);

    expect(JSON.stringify(decision)).toBe(before);
    expect(feedback.campaignId).toBe(decision.campaign.id);
    expect(feedback.constraints.allowedTopics).toEqual(decision.decisionScope.availableTopics);
    expect(feedback.instructions.length).toBeGreaterThan(0);
    for (const instruction of feedback.instructions) {
      for (const ref of instruction.evidenceRefs) {
        expect(decision.evidenceCatalog.map((e) => e.id)).toContain(ref);
      }
      for (const ref of instruction.findingRefs) {
        expect(decision.findingCatalog.map((f) => f.id)).toContain(ref);
      }
    }
  });
});
