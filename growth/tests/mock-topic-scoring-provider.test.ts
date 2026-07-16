import { describe, expect, it } from "vitest";
import { MockTopicScoringProvider } from "../llm/mock-topic-scoring-provider";
import { getTopicScoringProfile } from "../scoring/topic-scoring-profile";
import type { TopicScoringContext, TopicScoringLLMRequest } from "../types/topic-scoring";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureContext(overrides: Partial<TopicScoringContext> = {}): TopicScoringContext {
  return {
    topicId: "topic_abc",
    canonicalName: "Inventory Tracker",
    slug: "inventory-tracker",
    problemStatement: "Small shops lose track of stock.",
    targetAudience: "Small retail shop owners",
    useCases: ["Track stock counts"],
    desiredOutcome: "Fewer stockouts.",
    status: "candidate",
    candidateConfidence: "medium",
    relationshipToExistingContent: { status: "new", relatedAppSlugs: [], relatedTopicIds: [] },
    signals: [{ id: "signal_1", title: "T", summary: "S", signalType: "search_query", confidence: "medium", freshness: "fresh", metrics: [], sourceRecordIds: ["sourcerecord_1"] }],
    citedSourceRecords: [{ id: "sourcerecord_1", title: "R", sourceType: "ga4", content: "C", metrics: [] }],
    signalCount: 1,
    sourceCount: 1,
    sourceTypes: ["ga4"],
    ...overrides,
  };
}

function fixtureRequest(overrides: Partial<TopicScoringLLMRequest> = {}): TopicScoringLLMRequest {
  const context = fixtureContext();
  return {
    purpose: "purpose",
    campaign: CAMPAIGN,
    period: PERIOD,
    language: "en",
    scoringProfile: getTopicScoringProfile(),
    topicContexts: [context],
    topicCatalog: [{ topicId: context.topicId, canonicalName: context.canonicalName, slug: context.slug, relatedAppSlugs: [], relationshipStatus: "new", signalCount: 1 }],
    dataQualityWarnings: [],
    sourceIsMock: false,
    sourceHumanReviewed: true,
    reportingRules: [],
    responseSchemaDescription: "desc",
    maxTokens: 8000,
    systemPrompt: "SYSTEM",
    userPrompt: "USER",
    ...overrides,
  };
}

describe("MockTopicScoringProvider", () => {
  it("is named 'mock' and requires no API key or network call", async () => {
    const provider = new MockTopicScoringProvider();
    expect(provider.name).toBe("mock");
    await expect(provider.generateStructuredScores(fixtureRequest())).resolves.toBeDefined();
  });

  it("assesses exactly the supplied topics — one assessment per topic, no more, no fewer", async () => {
    const provider = new MockTopicScoringProvider();
    const result = await provider.generateStructuredScores(fixtureRequest());
    expect(result.data.topicAssessments.map((a) => a.topicId)).toEqual(["topic_abc"]);
  });

  it("returns all seven dimensions per topic", async () => {
    const provider = new MockTopicScoringProvider();
    const result = await provider.generateStructuredScores(fixtureRequest());
    const keys = result.data.topicAssessments[0].dimensions.map((d) => d.key).sort();
    expect(keys).toEqual(["audience_relevance", "competition", "demand", "evidence_strength", "feasibility", "novelty", "product_fit"]);
  });

  it("only cites real signal and source-record ids scoped to that topic", async () => {
    const provider = new MockTopicScoringProvider();
    const result = await provider.generateStructuredScores(fixtureRequest());
    const context = fixtureContext();
    const allowedSignals = new Set(context.signals.map((s) => s.id));
    const allowedSources = new Set(context.citedSourceRecords.map((r) => r.id));
    for (const dimension of result.data.topicAssessments[0].dimensions) {
      for (const ref of dimension.signalRefs) expect(allowedSignals.has(ref)).toBe(true);
      for (const ref of dimension.sourceRecordRefs) expect(allowedSources.has(ref)).toBe(true);
    }
  });

  it("uses scoreBasis = policy_default for feasibility (no real engineering-capacity signal)", async () => {
    const provider = new MockTopicScoringProvider();
    const result = await provider.generateStructuredScores(fixtureRequest());
    const feasibility = result.data.topicAssessments[0].dimensions.find((d) => d.key === "feasibility")!;
    expect(feasibility.scoreBasis).toBe("policy_default");
    expect(feasibility.score).toBe(50);
    expect(feasibility.limitations.length).toBeGreaterThan(0);
  });

  it("uses scoreBasis = policy_default for product_fit when no use cases are supplied", async () => {
    const provider = new MockTopicScoringProvider();
    const request = fixtureRequest({ topicContexts: [fixtureContext({ useCases: [] })] });
    const result = await provider.generateStructuredScores(request);
    const productFit = result.data.topicAssessments[0].dimensions.find((d) => d.key === "product_fit")!;
    expect(productFit.scoreBasis).toBe("policy_default");
  });

  it("uses scoreBasis = evidence for competition when relationship shows overlap", async () => {
    const provider = new MockTopicScoringProvider();
    const request = fixtureRequest({ topicContexts: [fixtureContext({ relationshipToExistingContent: { status: "related_to_existing_app", relatedAppSlugs: ["orderly"], relatedTopicIds: [] } })] });
    const result = await provider.generateStructuredScores(request);
    const competition = result.data.topicAssessments[0].dimensions.find((d) => d.key === "competition")!;
    expect(competition.scoreBasis).toBe("evidence");
    expect(competition.score).toBeLessThan(50);
  });

  it("uses scoreBasis = policy_default for competition with no observed overlap", async () => {
    const provider = new MockTopicScoringProvider();
    const result = await provider.generateStructuredScores(fixtureRequest());
    const competition = result.data.topicAssessments[0].dimensions.find((d) => d.key === "competition")!;
    expect(competition.scoreBasis).toBe("policy_default");
  });

  it("adds a duplicate_or_existing blocker when relationship status is 'duplicate'", async () => {
    const provider = new MockTopicScoringProvider();
    const request = fixtureRequest({ topicContexts: [fixtureContext({ relationshipToExistingContent: { status: "duplicate", relatedAppSlugs: ["orderly"], relatedTopicIds: [] } })] });
    const result = await provider.generateStructuredScores(request);
    expect(result.data.topicAssessments[0].blockers.some((b) => b.code === "duplicate_or_existing")).toBe(true);
  });

  it("returns no blockers for a non-duplicate topic", async () => {
    const provider = new MockTopicScoringProvider();
    const result = await provider.generateStructuredScores(fixtureRequest());
    expect(result.data.topicAssessments[0].blockers).toEqual([]);
  });

  it("adapts to zero topics — returns an empty, schema-valid analysis", async () => {
    const provider = new MockTopicScoringProvider();
    const result = await provider.generateStructuredScores(fixtureRequest({ topicContexts: [], topicCatalog: [] }));
    expect(result.data.topicAssessments).toEqual([]);
    expect(result.data.portfolioObservations.requiresHumanReview).toBe(true);
  });

  it("discloses mock-source input in portfolioObservations.majorLimitations", async () => {
    const provider = new MockTopicScoringProvider();
    const result = await provider.generateStructuredScores(fixtureRequest({ sourceIsMock: true }));
    expect(result.data.portfolioObservations.majorLimitations.some((l) => l.toLowerCase().includes("mock"))).toBe(true);
  });

  it("never produces a weight, weighted score, total score, rank, or recommendation field", async () => {
    const provider = new MockTopicScoringProvider();
    const result = await provider.generateStructuredScores(fixtureRequest());
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain("weightedScore");
    expect(serialized).not.toContain("totalScore");
    expect(serialized).not.toMatch(/"rank"/);
    expect(serialized).not.toContain("recommendation");
  });

  it("uses conservative scores — no dimension exceeds 75", async () => {
    const provider = new MockTopicScoringProvider();
    const result = await provider.generateStructuredScores(fixtureRequest());
    for (const dimension of result.data.topicAssessments[0].dimensions) {
      expect(dimension.score).toBeLessThanOrEqual(75);
    }
  });
});
