import { describe, expect, it } from "vitest";
import { renderTopicScoringMarkdown } from "../renderers/topic-scoring-markdown";
import { buildTopicScoringProfileSummary, getTopicScoringProfile } from "../scoring/topic-scoring-profile";
import { computeTotalScore, computeWeightedScore } from "../contracts/scored-topic";
import type { FinalTopicScoringRun } from "../types/topic-scoring";
import type { ScoredTopic } from "../contracts/scored-topic";
import type { TopicCandidate } from "../contracts/topic-candidate";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureTopicCandidate(overrides: Partial<TopicCandidate> = {}): TopicCandidate {
  return {
    schemaVersion: "1.0.0",
    id: "topic_1",
    campaignId: CAMPAIGN.id,
    createdAt: "2026-07-15T00:00:00.000Z",
    canonicalName: "Inventory Tracker",
    slug: "inventory-tracker",
    aliases: [],
    problemStatement: "Small shops lose track of stock.",
    targetAudience: "Small retail shop owners",
    useCases: ["Track stock levels"],
    desiredOutcome: "Fewer stockouts.",
    signalRefs: ["signal_1"],
    evidenceSummary: { signalCount: 1, sourceCount: 1, sourceTypes: ["ga4"], confidence: "medium", limitations: [] },
    relationshipToExistingContent: { status: "related_to_existing_app", relatedTopicIds: [], relatedAppSlugs: ["orderly"] },
    status: "candidate",
    rejection: null,
    provenance: { generatedBy: "signal-mining-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["signal_1"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
    ...overrides,
  };
}

function fixtureScoredTopic(overrides: Partial<ScoredTopic> = {}): ScoredTopic {
  const dims = [
    { key: "demand" as const, label: "Demand", score: 60, weight: 0.2, weightedScore: computeWeightedScore(60, 0.2), rationale: "Grounded in signal.", signalRefs: ["signal_1"], evidenceRefs: [], limitations: [], scoreBasis: "evidence" as const },
    { key: "audience_relevance" as const, label: "Audience relevance", score: 55, weight: 0.15, weightedScore: computeWeightedScore(55, 0.15), rationale: "x", signalRefs: ["signal_1"], evidenceRefs: [], limitations: [], scoreBasis: "evidence" as const },
    { key: "product_fit" as const, label: "Product fit", score: 55, weight: 0.2, weightedScore: computeWeightedScore(55, 0.2), rationale: "x", signalRefs: ["signal_1"], evidenceRefs: [], limitations: [], scoreBasis: "evidence" as const },
    { key: "competition" as const, label: "Competition", score: 50, weight: 0.1, weightedScore: computeWeightedScore(50, 0.1), rationale: "No evidence.", signalRefs: [], evidenceRefs: [], limitations: ["No competitor evidence supplied."], scoreBasis: "policy_default" as const },
    { key: "feasibility" as const, label: "Feasibility", score: 50, weight: 0.15, weightedScore: computeWeightedScore(50, 0.15), rationale: "No evidence.", signalRefs: [], evidenceRefs: [], limitations: ["Not assessed."], scoreBasis: "policy_default" as const },
    { key: "novelty" as const, label: "Novelty", score: 60, weight: 0.1, weightedScore: computeWeightedScore(60, 0.1), rationale: "x", signalRefs: ["signal_1"], evidenceRefs: [], limitations: [], scoreBasis: "evidence" as const },
    { key: "evidence_strength" as const, label: "Evidence strength", score: 45, weight: 0.1, weightedScore: computeWeightedScore(45, 0.1), rationale: "x", signalRefs: ["signal_1"], evidenceRefs: [], limitations: [], scoreBasis: "evidence" as const },
  ];
  return {
    schemaVersion: "1.0.0",
    id: "scoredtopic_1",
    topicId: "topic_1",
    campaignId: CAMPAIGN.id,
    scoredAt: "2026-07-15T00:00:00.000Z",
    scoringVersion: "small_business_topic_scoring@1.0.0",
    dimensions: dims,
    totalScore: computeTotalScore(dims),
    ranking: { rank: 1, candidateCount: 1 },
    confidence: "medium",
    recommendation: "needs_human_review",
    blockers: [],
    humanReviewRequired: true,
    provenance: { generatedBy: "topic-scoring-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["topic_1"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
    ...overrides,
  };
}

function fixtureRun(overrides: Partial<FinalTopicScoringRun> = {}): FinalTopicScoringRun {
  return {
    schemaVersion: "1.0.0",
    runType: "topic_scoring",
    generatedAt: "2026-07-15T00:00:00.000Z",
    period: PERIOD,
    campaign: CAMPAIGN,
    provenance: {
      sourceSignalMiningFilename: "signal-mining-2026-07-08_to_2026-07-14.json",
      sourceSignalMiningSha256: "hash",
      sourceSignalMiningGeneratedAt: "2026-07-15T00:00:00.000Z",
      sourceSignalMiningProvider: "mock",
      sourceSignalMiningModel: "mock-v0",
      sourceSignalMiningIsMock: true,
      sourceSignalsHumanReviewed: false,
    },
    generation: { provider: "mock", model: "mock-v0", language: "en", isMock: true, requestId: null, stopReason: "end_turn", usage: { inputTokens: null, outputTokens: null } },
    scoringProfile: buildTopicScoringProfileSummary(),
    topicCatalog: [fixtureTopicCandidate()],
    scoredTopics: [fixtureScoredTopic()],
    ranking: { candidateCount: 1, rankedTopicIds: ["topic_1"], topTopicId: "topic_1", advanceCount: 0, needsHumanReviewCount: 1, holdCount: 0, rejectCount: 0 },
    portfolioObservations: { topicCoverage: "1 of 1 assessed.", evidenceCoverage: "Grounded.", majorLimitations: [], requiresHumanReview: true },
    confidenceAdjustments: [{ topicId: "topic_1", originalConfidence: "high", finalConfidence: "medium", reasons: ["Source signals/topics have not been human-approved."] }],
    humanReview: { required: true, approved: false, selectedTopicIds: [], approvedBy: null, approvedAt: null, note: "Topic scores and rankings require human review before Asset Generation." },
    dataQuality: { overallStatus: "partial", warnings: [], limitations: [] },
    ...overrides,
  };
}

describe("renderTopicScoringMarkdown", () => {
  it("renders all required top-level sections", () => {
    const md = renderTopicScoringMarkdown(fixtureRun());
    for (const heading of [
      "# Topic Scoring Review",
      "## Reporting Period",
      "## Campaign",
      "## Input Status",
      "## Scoring Rubric",
      "## Ranked Topics",
      "## Dimension Breakdown",
      "## Portfolio Observations",
      "## Data and Evidence Limitations",
      "## Human Review Required",
      "## Generation Metadata",
    ]) {
      expect(md).toContain(heading);
    }
  });

  it("prominently labels mock provider output, mock source input, and unreviewed source input", () => {
    const md = renderTopicScoringMarkdown(fixtureRun());
    expect(md).toContain("Mock Provider");
    expect(md).toContain("mock-generated");
    expect(md).toContain("not been human-approved");
  });

  it("states that advance is not approval", () => {
    const md = renderTopicScoringMarkdown(fixtureRun());
    expect(md.toLowerCase()).toContain("not approval");
  });

  it("labels policy-default dimensions distinctly from evidence-based ones", () => {
    const md = renderTopicScoringMarkdown(fixtureRun());
    expect(md).toContain("policy-default");
    expect(md).toContain("evidence-based");
  });

  it("shows the confidence adjustment reason for an adjusted topic", () => {
    const md = renderTopicScoringMarkdown(fixtureRun());
    expect(md).toContain("high → medium");
  });

  it("shows the rubric with weights and dimension meanings", () => {
    const md = renderTopicScoringMarkdown(fixtureRun());
    const profile = getTopicScoringProfile();
    for (const dimension of profile.dimensions) {
      expect(md).toContain(dimension.label);
    }
  });

  it("renders 'no topics were scored' when scoredTopics is empty", () => {
    const md = renderTopicScoringMarkdown(fixtureRun({ scoredTopics: [], ranking: { candidateCount: 0, rankedTopicIds: [], topTopicId: null, advanceCount: 0, needsHumanReviewCount: 0, holdCount: 0, rejectCount: 0 } }));
    expect(md).toContain("No topics were scored");
  });

  it("shows human review required/approved state", () => {
    const md = renderTopicScoringMarkdown(fixtureRun());
    expect(md).toMatch(/\*\*Required:\*\* Yes/);
    expect(md).toMatch(/\*\*Approved:\*\* No/);
  });

  it("displays null/unavailable data as 'Unavailable', never blank", () => {
    const md = renderTopicScoringMarkdown(fixtureRun());
    expect(md).toContain("Unavailable");
  });

  it("does not throw for a run with no mock/unreviewed warnings to show", () => {
    const run = fixtureRun({
      generation: { ...fixtureRun().generation, isMock: false },
      provenance: { ...fixtureRun().provenance, sourceSignalMiningIsMock: false, sourceSignalsHumanReviewed: true },
    });
    expect(() => renderTopicScoringMarkdown(run)).not.toThrow();
  });
});
