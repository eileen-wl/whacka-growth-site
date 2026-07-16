import { describe, expect, it } from "vitest";
import {
  ScoredTopicValidationError,
  TopicToScoredTopicValidationError,
  buildScoredTopicId,
  computeTotalScore,
  computeWeightedScore,
  validateScoredTopic,
  validateTopicForScoring,
} from "../contracts/scored-topic";
import type { ScoredTopic } from "../contracts/scored-topic";
import { buildTopicCandidateId } from "../contracts/topic-candidate";
import type { TopicCandidate } from "../contracts/topic-candidate";

function fixtureDimension(overrides: Partial<ScoredTopic["dimensions"][number]> = {}) {
  const score = overrides.score ?? 80;
  const weight = overrides.weight ?? 0.5;
  return {
    key: "demand" as const,
    label: "Demand",
    score,
    weight,
    weightedScore: computeWeightedScore(score, weight),
    rationale: "High search volume observed in Search Console.",
    signalRefs: [],
    evidenceRefs: [],
    limitations: [],
    ...overrides,
  };
}

function fixtureScoredTopic(overrides: Partial<ScoredTopic> = {}): ScoredTopic {
  const dimensions = overrides.dimensions ?? [
    fixtureDimension({ key: "demand", score: 80, weight: 0.5 }),
    fixtureDimension({ key: "product_fit", score: 60, weight: 0.5 }),
  ];
  return {
    schemaVersion: "1.0.0",
    id: buildScoredTopicId({ topicId: "topic_x", scoringVersion: "v1" }),
    topicId: "topic_x",
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

function fixtureTopicCandidate(overrides: Partial<TopicCandidate> = {}): TopicCandidate {
  return {
    schemaVersion: "1.0.0",
    id: buildTopicCandidateId({ campaignId: "test_campaign", canonicalName: "Inventory Tracker" }),
    campaignId: "test_campaign",
    createdAt: "2026-07-15T00:00:00.000Z",
    canonicalName: "Inventory Tracker",
    slug: "inventory-tracker",
    aliases: [],
    problemStatement: "x",
    targetAudience: "x",
    useCases: [],
    desiredOutcome: "x",
    signalRefs: ["signal_1"],
    evidenceSummary: { signalCount: 1, sourceCount: 1, sourceTypes: ["search_console"], confidence: "medium", limitations: [] },
    relationshipToExistingContent: { status: "new", relatedTopicIds: [], relatedAppSlugs: [] },
    status: "candidate",
    rejection: null,
    provenance: { generatedBy: "topic-scoring-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: [], sourceDecisionId: null, provider: null, model: null, isMock: false, humanReviewed: false },
    ...overrides,
  };
}

describe("scoredTopicSchema", () => {
  it("accepts a well-formed scored topic", () => {
    expect(() => validateScoredTopic(fixtureScoredTopic())).not.toThrow();
  });

  it("rejects a weightedScore that doesn't equal score * weight", () => {
    const dimensions = [fixtureDimension({ score: 80, weight: 0.5, weightedScore: 999 })];
    expect(() => validateScoredTopic(fixtureScoredTopic({ dimensions, totalScore: 999 }))).toThrow(ScoredTopicValidationError);
  });

  it("rejects duplicate dimension keys", () => {
    const dimensions = [fixtureDimension({ key: "demand" }), fixtureDimension({ key: "demand" })];
    const totalScore = computeTotalScore(dimensions);
    expect(() => validateScoredTopic(fixtureScoredTopic({ dimensions, totalScore }))).toThrow(ScoredTopicValidationError);
  });

  it("rejects a totalScore inconsistent with the sum of weightedScores instead of silently recomputing it", () => {
    const dimensions = [fixtureDimension({ score: 80, weight: 0.5 }), fixtureDimension({ key: "product_fit", score: 60, weight: 0.5 })];
    const scoredTopic = fixtureScoredTopic({ dimensions, totalScore: 12.5 });
    expect(() => validateScoredTopic(scoredTopic)).toThrow(ScoredTopicValidationError);
  });

  it("accepts a null ranking (not yet scored against other topics)", () => {
    expect(() => validateScoredTopic(fixtureScoredTopic({ ranking: null }))).not.toThrow();
  });

  it("accepts a populated ranking", () => {
    expect(() => validateScoredTopic(fixtureScoredTopic({ ranking: { rank: 1, candidateCount: 3 } }))).not.toThrow();
  });

  it("rejects a score outside the 0-100 range", () => {
    const dimensions = [fixtureDimension({ score: 150, weight: 0.5, weightedScore: 75 })];
    expect(() => validateScoredTopic(fixtureScoredTopic({ dimensions, totalScore: 75 }))).toThrow(ScoredTopicValidationError);
  });

  it("rejects a weight outside the 0-1 range", () => {
    const dimensions = [fixtureDimension({ score: 50, weight: 1.5, weightedScore: 75 })];
    expect(() => validateScoredTopic(fixtureScoredTopic({ dimensions, totalScore: 75 }))).toThrow(ScoredTopicValidationError);
  });

  it("always requires humanReviewRequired to be true", () => {
    const scoredTopic = { ...fixtureScoredTopic(), humanReviewRequired: false as unknown as true };
    expect(() => validateScoredTopic(scoredTopic)).toThrow(ScoredTopicValidationError);
  });

  it("throws on an unsupported major schema version", () => {
    expect(() => validateScoredTopic(fixtureScoredTopic({ schemaVersion: "2.0.0" }))).toThrow();
  });
});

describe("computeWeightedScore / computeTotalScore", () => {
  it("computes score * weight", () => {
    expect(computeWeightedScore(80, 0.5)).toBe(40);
  });

  it("sums weightedScores across dimensions", () => {
    const dimensions = [{ weightedScore: 40 }, { weightedScore: 30 }];
    expect(computeTotalScore(dimensions)).toBe(70);
  });
});

describe("validateTopicForScoring", () => {
  it("accepts a candidate-status topic", () => {
    expect(() => validateTopicForScoring(fixtureTopicCandidate({ status: "candidate" }))).not.toThrow();
  });

  it("rejects a rejected topic", () => {
    expect(() => validateTopicForScoring(fixtureTopicCandidate({ status: "rejected" }))).toThrow(TopicToScoredTopicValidationError);
  });

  it("rejects an archived topic", () => {
    expect(() => validateTopicForScoring(fixtureTopicCandidate({ status: "archived" }))).toThrow(TopicToScoredTopicValidationError);
  });
});

describe("buildScoredTopicId", () => {
  it("is deterministic for identical inputs", () => {
    const a = buildScoredTopicId({ topicId: "topic_x", scoringVersion: "v1" });
    const b = buildScoredTopicId({ topicId: "topic_x", scoringVersion: "v1" });
    expect(a).toBe(b);
  });

  it("differs across scoringVersion", () => {
    const a = buildScoredTopicId({ topicId: "topic_x", scoringVersion: "v1" });
    const b = buildScoredTopicId({ topicId: "topic_x", scoringVersion: "v2" });
    expect(a).not.toBe(b);
  });
});
