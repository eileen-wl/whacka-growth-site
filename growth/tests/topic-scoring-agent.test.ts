import { describe, expect, it } from "vitest";
import {
  TopicScoringValidationError,
  assembleScoredTopics,
  buildTopicScoringContexts,
  runTopicScoringAgent,
  validateTopicScoringAnalysis,
} from "../agents/topic-scoring-agent";
import { getTopicScoringProfile } from "../scoring/topic-scoring-profile";
import type { TopicScoringProvider } from "../llm/topic-scoring-provider";
import type { FinalSignalMiningRun } from "../types/signal-mining";
import type { DimensionAssessment, TopicAssessment, TopicScoringAnalysis } from "../types/topic-scoring";
import type { LLMStructuredResult } from "../types/llm";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureSignalMiningRun(overrides: Partial<FinalSignalMiningRun> = {}): FinalSignalMiningRun {
  return {
    schemaVersion: "1.0.0",
    runType: "signal_mining",
    generatedAt: "2026-07-15T00:00:00.000Z",
    period: PERIOD,
    campaign: CAMPAIGN,
    provenance: {
      sourceSummaryFilename: "growth-summary-x.json",
      sourceSummarySha256: "hash",
      sourceFeedbackFilename: null,
      sourceFeedbackSha256: null,
      manualInputFilename: null,
      manualInputSha256: null,
      sourceFeedbackIsMock: false,
    },
    generation: { provider: "mock", model: "mock-v0", language: "en", isMock: true, requestId: null, stopReason: "end_turn", usage: { inputTokens: null, outputTokens: null } },
    sourceSummary: { recordsCollected: 1, recordsUsed: 1, recordsOmittedByLimit: 0, sourceTypes: ["ga4"], warnings: [] },
    sourceRecordCatalog: [
      {
        id: "sourcerecord_1",
        source: { type: "ga4", name: "GA4 traffic acquisition", recordId: "google/organic", url: null, publishedAt: null, retrievedAt: "2026-07-15T00:00:00.000Z", isInternal: true },
        title: "Traffic source: google / organic",
        content: "GA4 recorded 80 sessions.",
        entities: { keywords: [], topics: [], audiences: [], productsOrApps: ["orderly"], channels: [] },
        metrics: [{ name: "sessions", value: 80, unit: "count", measurementBasis: "x", period: null }],
        references: { evidenceRefs: [], findingRefs: [], limitationRefs: [] },
        quality: { confidence: "medium", limitations: [] },
      },
    ],
    signals: [
      {
        schemaVersion: "1.0.0",
        id: "signal_1",
        campaignId: CAMPAIGN.id,
        capturedAt: "2026-07-15T00:00:00.000Z",
        source: { type: "ga4", name: "GA4 traffic acquisition", recordId: "google/organic", url: null, publishedAt: null, retrievedAt: "2026-07-15T00:00:00.000Z", isInternal: true },
        signalType: "trending_topic",
        title: "Traffic source: google / organic",
        summary: "GA4 recorded 80 sessions.",
        evidenceExcerpt: null,
        entities: { keywords: [], topics: [], audiences: [], productsOrApps: ["orderly"], channels: [] },
        metrics: [{ name: "sessions", value: 80, unit: "count", measurementBasis: "x", period: null }],
        quality: { confidence: "medium", freshness: "fresh", duplicateStatus: "unique", limitations: [] },
        humanReviewRequired: true,
        provenance: { generatedBy: "signal-mining-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["sourcerecord_1"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
      },
    ],
    topicPool: [
      {
        schemaVersion: "1.0.0",
        id: "topic_1",
        campaignId: CAMPAIGN.id,
        createdAt: "2026-07-15T00:00:00.000Z",
        canonicalName: "Orderly traffic signals",
        slug: "orderly-traffic-signals",
        aliases: [],
        problemStatement: "Orderly is receiving organic traffic worth investigating.",
        targetAudience: "Small shop owners",
        useCases: ["Track stock levels"],
        desiredOutcome: "Understand traffic drivers.",
        signalRefs: ["signal_1"],
        evidenceSummary: { signalCount: 1, sourceCount: 1, sourceTypes: ["ga4"], confidence: "medium", limitations: [] },
        relationshipToExistingContent: { status: "related_to_existing_app", relatedTopicIds: [], relatedAppSlugs: ["orderly"] },
        status: "candidate",
        rejection: null,
        provenance: { generatedBy: "signal-mining-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["signal_1"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
      },
    ],
    unresolvedSourceRecords: [],
    deduplication: { inputSignalProposalCount: 1, finalSignalCount: 1, duplicatesRemoved: 0 },
    humanReview: { required: true, approved: false, approvedBy: null, approvedAt: null, note: "x" },
    dataQuality: { overallStatus: "partial", warnings: [], limitations: [] },
    ...overrides,
  };
}

function fixtureDimension(key: DimensionAssessment["key"], overrides: Partial<DimensionAssessment> = {}): DimensionAssessment {
  return {
    key,
    score: 60,
    scoreBasis: "evidence",
    rationale: "Grounded in the supplied signal.",
    signalRefs: ["signal_1"],
    sourceRecordRefs: [],
    limitations: [],
    ...overrides,
  };
}

function fixtureAssessment(topicId: string, overrides: Partial<TopicAssessment> = {}): TopicAssessment {
  const keys: DimensionAssessment["key"][] = ["demand", "audience_relevance", "product_fit", "competition", "feasibility", "novelty", "evidence_strength"];
  return {
    topicId,
    dimensions: keys.map((key) => fixtureDimension(key)),
    confidence: "high",
    blockers: [],
    reviewNotes: [],
    ...overrides,
  };
}

function fixtureAnalysis(topicIds: string[], overrides: Partial<TopicScoringAnalysis> = {}): TopicScoringAnalysis {
  return {
    topicAssessments: topicIds.map((id) => fixtureAssessment(id)),
    portfolioObservations: { topicCoverage: "1 of 1 topics assessed.", evidenceCoverage: "Grounded.", majorLimitations: [], requiresHumanReview: true },
    ...overrides,
  };
}

class FakeProvider implements TopicScoringProvider {
  readonly name: string;
  constructor(
    private readonly analysis: TopicScoringAnalysis,
    name = "fake"
  ) {
    this.name = name;
  }
  async generateStructuredScores(): Promise<LLMStructuredResult<TopicScoringAnalysis>> {
    return { data: this.analysis, provider: this.name, model: "fake-model", requestId: null, stopReason: "end_turn", inputTokens: null, outputTokens: null };
  }
}

describe("buildTopicScoringContexts", () => {
  it("builds one context per TopicCandidate, scoped to its own resolved signals and cited source records", () => {
    const { contexts, catalog } = buildTopicScoringContexts(fixtureSignalMiningRun());
    expect(contexts).toHaveLength(1);
    expect(contexts[0].topicId).toBe("topic_1");
    expect(contexts[0].signals.map((s) => s.id)).toEqual(["signal_1"]);
    expect(contexts[0].citedSourceRecords.map((r) => r.id)).toEqual(["sourcerecord_1"]);
    expect(contexts[0].signalCount).toBe(1);
    expect(contexts[0].sourceCount).toBe(1);
    expect(catalog).toHaveLength(1);
    expect(catalog[0].topicId).toBe("topic_1");
  });

  it("produces an empty context/catalog for a zero-topic run", () => {
    const { contexts, catalog } = buildTopicScoringContexts(fixtureSignalMiningRun({ topicPool: [] }));
    expect(contexts).toEqual([]);
    expect(catalog).toEqual([]);
  });

  it("does not mutate the input run", () => {
    const run = fixtureSignalMiningRun();
    const before = JSON.stringify(run);
    buildTopicScoringContexts(run);
    expect(JSON.stringify(run)).toBe(before);
  });
});

describe("validateTopicScoringAnalysis", () => {
  it("accepts a well-formed analysis matching the supplied contexts", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    expect(() => validateTopicScoringAnalysis(fixtureAnalysis(["topic_1"]), contexts)).not.toThrow();
  });

  it("rejects an assessment for an unknown topic", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    expect(() => validateTopicScoringAnalysis(fixtureAnalysis(["topic_unknown"]), contexts)).toThrow(TopicScoringValidationError);
  });

  it("rejects a duplicated topic assessment", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    const analysis = fixtureAnalysis(["topic_1"]);
    analysis.topicAssessments.push(fixtureAssessment("topic_1"));
    expect(() => validateTopicScoringAnalysis(analysis, contexts)).toThrow(/Duplicate topicAssessments/);
  });

  it("rejects a missing topic assessment", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    expect(() => validateTopicScoringAnalysis(fixtureAnalysis([]), contexts)).toThrow(/missing an assessment/);
  });

  it("rejects a dimension missing (fewer than 7)", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    const analysis = fixtureAnalysis(["topic_1"]);
    analysis.topicAssessments[0].dimensions = analysis.topicAssessments[0].dimensions.slice(0, 6);
    expect(() => validateTopicScoringAnalysis(analysis, contexts)).toThrow(TopicScoringValidationError);
  });

  it("rejects a duplicate dimension key", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    const analysis = fixtureAnalysis(["topic_1"]);
    analysis.topicAssessments[0].dimensions[6] = { ...analysis.topicAssessments[0].dimensions[0] };
    expect(() => validateTopicScoringAnalysis(analysis, contexts)).toThrow(TopicScoringValidationError);
  });

  it("rejects an out-of-range score", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    const analysis = fixtureAnalysis(["topic_1"]);
    analysis.topicAssessments[0].dimensions[0] = { ...analysis.topicAssessments[0].dimensions[0], score: 150 };
    expect(() => validateTopicScoringAnalysis(analysis, contexts)).toThrow(TopicScoringValidationError);
  });

  it("rejects evidence-based scoring with no signalRefs or sourceRecordRefs", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    const analysis = fixtureAnalysis(["topic_1"]);
    analysis.topicAssessments[0].dimensions[0] = { ...analysis.topicAssessments[0].dimensions[0], signalRefs: [], sourceRecordRefs: [] };
    expect(() => validateTopicScoringAnalysis(analysis, contexts)).toThrow(TopicScoringValidationError);
  });

  it("rejects policy_default scoring with no limitation", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    const analysis = fixtureAnalysis(["topic_1"]);
    analysis.topicAssessments[0].dimensions[0] = { ...analysis.topicAssessments[0].dimensions[0], scoreBasis: "policy_default", score: 50, limitations: [] };
    expect(() => validateTopicScoringAnalysis(analysis, contexts)).toThrow(TopicScoringValidationError);
  });

  it("rejects a policy_default score that isn't exactly the fixed fallback score", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    const analysis = fixtureAnalysis(["topic_1"]);
    analysis.topicAssessments[0].dimensions[0] = { ...analysis.topicAssessments[0].dimensions[0], scoreBasis: "policy_default", score: 45, limitations: ["No evidence."] };
    expect(() => validateTopicScoringAnalysis(analysis, contexts)).toThrow(TopicScoringValidationError);
  });

  it("rejects unknown top-level keys (e.g. a smuggled weight field)", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    const raw = { ...fixtureAnalysis(["topic_1"]), weight: 0.5 };
    expect(() => validateTopicScoringAnalysis(raw, contexts)).toThrow(TopicScoringValidationError);
  });

  it("rejects a signalRef outside that specific topic's own supplied signals", () => {
    const twoTopicRun = fixtureSignalMiningRun({
      topicPool: [
        fixtureSignalMiningRun().topicPool[0],
        { ...fixtureSignalMiningRun().topicPool[0], id: "topic_2", canonicalName: "Other topic", slug: "other-topic", signalRefs: ["signal_1"] },
      ],
    });
    const { contexts } = buildTopicScoringContexts(twoTopicRun);
    // topic_2's context has its own copy scoped the same way, but simulate a cross-topic ref by citing a nonexistent id.
    const analysis = fixtureAnalysis(["topic_1", "topic_2"]);
    analysis.topicAssessments[0].dimensions[0] = { ...analysis.topicAssessments[0].dimensions[0], signalRefs: ["signal_from_another_topic"] };
    expect(() => validateTopicScoringAnalysis(analysis, contexts)).toThrow(/outside its own supplied signals/);
  });

  it("rejects a blocker citing an unknown sourceRecordRef", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    const analysis = fixtureAnalysis(["topic_1"]);
    analysis.topicAssessments[0].blockers = [{ code: "other", description: "x", signalRefs: [], sourceRecordRefs: ["nonexistent"] }];
    expect(() => validateTopicScoringAnalysis(analysis, contexts)).toThrow(/blocker references unknown sourceRecordRef/);
  });
});

describe("assembleScoredTopics", () => {
  const provenance = { sourceFileNames: ["signal-mining-x.json"], sourceHashes: ["hash"], provider: "fake", model: "fake-model", isMock: false };

  it("computes weightedScore and totalScore deterministically from the fixed profile weights", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    const analysis = fixtureAnalysis(["topic_1"]);
    const profile = getTopicScoringProfile();
    const { scoredTopics } = assembleScoredTopics({ analysis, contexts, profile, campaignId: CAMPAIGN.id, scoredAt: "2026-07-15T00:00:00.000Z", sourceIsMock: false, sourceHumanReviewed: true, provenance });
    expect(scoredTopics).toHaveLength(1);
    const demand = scoredTopics[0].dimensions.find((d) => d.key === "demand")!;
    expect(demand.weightedScore).toBeCloseTo(60 * 0.2, 5);
    expect(scoredTopics[0].totalScore).toBeCloseTo(60, 5); // every dimension scored 60 uniformly
  });

  it("every ScoredTopic validates against the existing contract", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    const analysis = fixtureAnalysis(["topic_1"]);
    const profile = getTopicScoringProfile();
    const { scoredTopics } = assembleScoredTopics({ analysis, contexts, profile, campaignId: CAMPAIGN.id, scoredAt: "2026-07-15T00:00:00.000Z", sourceIsMock: false, sourceHumanReviewed: true, provenance });
    expect(scoredTopics[0].schemaVersion).toBe("1.0.0");
    expect(scoredTopics[0].scoringVersion).toBe("small_business_topic_scoring@1.0.0");
  });

  it("records a confidenceAdjustment reason when a cap is binding", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    const analysis = fixtureAnalysis(["topic_1"], { topicAssessments: [fixtureAssessment("topic_1", { confidence: "high" })] });
    const profile = getTopicScoringProfile();
    const { confidenceAdjustments } = assembleScoredTopics({ analysis, contexts, profile, campaignId: CAMPAIGN.id, scoredAt: "2026-07-15T00:00:00.000Z", sourceIsMock: true, sourceHumanReviewed: true, provenance });
    expect(confidenceAdjustments).toHaveLength(1);
    expect(confidenceAdjustments[0].topicId).toBe("topic_1");
    expect(confidenceAdjustments[0].finalConfidence).toBe("low");
  });

  it("maps blockers into ScoredTopic.blockers as strings", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    const analysis = fixtureAnalysis(["topic_1"], {
      topicAssessments: [fixtureAssessment("topic_1", { blockers: [{ code: "duplicate_or_existing", description: "Overlaps with Orderly.", signalRefs: [], sourceRecordRefs: [] }] })],
    });
    const profile = getTopicScoringProfile();
    const { scoredTopics } = assembleScoredTopics({ analysis, contexts, profile, campaignId: CAMPAIGN.id, scoredAt: "2026-07-15T00:00:00.000Z", sourceIsMock: false, sourceHumanReviewed: true, provenance });
    expect(scoredTopics[0].blockers[0]).toContain("duplicate_or_existing");
    expect(scoredTopics[0].blockers[0]).toContain("Overlaps with Orderly.");
    expect(scoredTopics[0].recommendation).toBe("hold");
  });

  it("does not mutate the input analysis or contexts", () => {
    const { contexts } = buildTopicScoringContexts(fixtureSignalMiningRun());
    const analysis = fixtureAnalysis(["topic_1"]);
    const beforeAnalysis = JSON.stringify(analysis);
    const beforeContexts = JSON.stringify(contexts);
    assembleScoredTopics({ analysis, contexts, profile: getTopicScoringProfile(), campaignId: CAMPAIGN.id, scoredAt: "2026-07-15T00:00:00.000Z", sourceIsMock: false, sourceHumanReviewed: true, provenance });
    expect(JSON.stringify(analysis)).toBe(beforeAnalysis);
    expect(JSON.stringify(contexts)).toBe(beforeContexts);
  });
});

describe("runTopicScoringAgent — end to end", () => {
  const baseParams = { language: "en" as const, maxTokens: 8000, sourceFilename: "signal-mining-x.json", sourceSha256: "hash", generatedAt: "2026-07-15T00:00:00.000Z" };

  it("produces a valid FinalTopicScoringRun with valid ScoredTopic contracts", async () => {
    const run = fixtureSignalMiningRun();
    const analysis = fixtureAnalysis(["topic_1"]);
    const result = await runTopicScoringAgent({ ...baseParams, run, provider: new FakeProvider(analysis) });
    expect(result.schemaVersion).toBe("1.0.0");
    expect(result.runType).toBe("topic_scoring");
    expect(result.scoredTopics).toHaveLength(1);
    expect(result.topicCatalog).toEqual(run.topicPool);
  });

  it("every topic is scored exactly once", async () => {
    const run = fixtureSignalMiningRun();
    const result = await runTopicScoringAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis(["topic_1"])) });
    expect(result.scoredTopics.map((t) => t.topicId)).toEqual(["topic_1"]);
  });

  it("always requires human review, defaults approved false, and selectedTopicIds empty", async () => {
    const run = fixtureSignalMiningRun();
    const result = await runTopicScoringAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis(["topic_1"])) });
    expect(result.humanReview).toEqual({ required: true, approved: false, selectedTopicIds: [], approvedBy: null, approvedAt: null, note: expect.any(String) });
  });

  it("preserves source mock and generation mock metadata", async () => {
    const run = fixtureSignalMiningRun({ generation: { ...fixtureSignalMiningRun().generation, isMock: true } });
    const mockResult = await runTopicScoringAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis(["topic_1"]), "mock") });
    expect(mockResult.provenance.sourceSignalMiningIsMock).toBe(true);
    expect(mockResult.generation.isMock).toBe(true);

    const liveRun = fixtureSignalMiningRun({ generation: { ...fixtureSignalMiningRun().generation, isMock: false } });
    const liveResult = await runTopicScoringAgent({ ...baseParams, run: liveRun, provider: new FakeProvider(fixtureAnalysis(["topic_1"]), "anthropic") });
    expect(liveResult.provenance.sourceSignalMiningIsMock).toBe(false);
    expect(liveResult.generation.isMock).toBe(false);
  });

  it("is valid with zero scored topics when the source topic pool is empty", async () => {
    const run = fixtureSignalMiningRun({ topicPool: [] });
    const result = await runTopicScoringAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis([])) });
    expect(result.scoredTopics).toEqual([]);
    expect(result.ranking).toEqual({ candidateCount: 0, rankedTopicIds: [], topTopicId: null, advanceCount: 0, needsHumanReviewCount: 0, holdCount: 0, rejectCount: 0 });
  });

  it("ranking.topTopicId matches the highest-ranked scored topic", async () => {
    const run = fixtureSignalMiningRun();
    const result = await runTopicScoringAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis(["topic_1"])) });
    expect(result.ranking.topTopicId).toBe(result.scoredTopics[0]?.topicId ?? null);
  });

  it("does not mutate the input FinalSignalMiningRun", async () => {
    const run = fixtureSignalMiningRun();
    const before = JSON.stringify(run);
    await runTopicScoringAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis(["topic_1"])) });
    expect(JSON.stringify(run)).toBe(before);
  });

  it("no AssetBundle-shaped fields appear anywhere in the output", async () => {
    const run = fixtureSignalMiningRun();
    const result = await runTopicScoringAgent({ ...baseParams, run, provider: new FakeProvider(fixtureAnalysis(["topic_1"])) });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("appprompt");
    expect(serialized).not.toContain("ctahref");
    expect(serialized).not.toContain("metadescription");
  });

  it("throws TopicScoringValidationError and produces no run when the provider response is invalid", async () => {
    const run = fixtureSignalMiningRun();
    const invalidAnalysis = { ...fixtureAnalysis(["topic_1"]), rank: 1 } as unknown as TopicScoringAnalysis;
    await expect(runTopicScoringAgent({ ...baseParams, run, provider: new FakeProvider(invalidAnalysis) })).rejects.toThrow(TopicScoringValidationError);
  });
});
