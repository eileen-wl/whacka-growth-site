import { describe, expect, it } from "vitest";
import {
  applyConfidenceCaps,
  assignRanking,
  computeRecommendation,
  computeTotalScore,
  computeWeightedScore,
  sortTopicsForRanking,
} from "../scoring/topic-scoring-engine";
import type { ScoredTopic, ScoringDimension } from "../contracts/scored-topic";

function fixtureDimension(key: ScoringDimension["key"], score: number, weight = 0.1): ScoringDimension {
  return {
    key,
    label: key,
    score,
    weight,
    weightedScore: computeWeightedScore(score, weight),
    rationale: "x",
    signalRefs: [],
    evidenceRefs: [],
    limitations: [],
  };
}

function fixtureScoredTopic(overrides: Partial<ScoredTopic> = {}): ScoredTopic {
  const dimensions = overrides.dimensions ?? [fixtureDimension("demand", 50, 1)];
  return {
    schemaVersion: "1.0.0",
    id: "scoredtopic_x",
    topicId: "topic_x",
    campaignId: "test_campaign",
    scoredAt: "2026-07-15T00:00:00.000Z",
    scoringVersion: "small_business_topic_scoring@1.0.0",
    dimensions,
    totalScore: computeTotalScore(dimensions),
    ranking: null,
    confidence: "medium",
    recommendation: "hold",
    blockers: [],
    humanReviewRequired: true,
    provenance: { generatedBy: "topic-scoring-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: [], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
    ...overrides,
  };
}

describe("computeWeightedScore / computeTotalScore (reused from contracts/scored-topic.ts)", () => {
  it("computes score * weight", () => {
    expect(computeWeightedScore(80, 0.2)).toBe(16);
  });

  it("sums weightedScores", () => {
    expect(computeTotalScore([{ weightedScore: 10 }, { weightedScore: 20 }])).toBe(30);
  });
});

describe("sortTopicsForRanking / assignRanking", () => {
  it("ranks by totalScore descending", () => {
    const low = fixtureScoredTopic({ topicId: "topic_low", dimensions: [fixtureDimension("demand", 30, 1)] });
    const high = fixtureScoredTopic({ topicId: "topic_high", dimensions: [fixtureDimension("demand", 90, 1)] });
    const sorted = sortTopicsForRanking([low, high]);
    expect(sorted.map((t) => t.topicId)).toEqual(["topic_high", "topic_low"]);
  });

  it("breaks totalScore ties by evidence_strength score descending", () => {
    const a = fixtureScoredTopic({
      topicId: "topic_a",
      dimensions: [fixtureDimension("demand", 50, 0.5), fixtureDimension("evidence_strength", 40, 0.5)],
    });
    const b = fixtureScoredTopic({
      topicId: "topic_b",
      dimensions: [fixtureDimension("demand", 50, 0.5), fixtureDimension("evidence_strength", 60, 0.5)],
    });
    // Equalize totalScore by construction below is tricky since demand differs; instead build equal totals directly.
    const equalTotalA = { ...a, totalScore: 50, dimensions: [fixtureDimension("demand", 60, 0.5), fixtureDimension("evidence_strength", 40, 0.5)] };
    const equalTotalB = { ...b, totalScore: 50, dimensions: [fixtureDimension("demand", 40, 0.5), fixtureDimension("evidence_strength", 60, 0.5)] };
    const sorted = sortTopicsForRanking([equalTotalA, equalTotalB]);
    expect(sorted.map((t) => t.topicId)).toEqual(["topic_b", "topic_a"]);
  });

  it("breaks evidence_strength ties by demand score descending", () => {
    const a = fixtureScoredTopic({
      topicId: "topic_a",
      totalScore: 50,
      dimensions: [fixtureDimension("demand", 30, 0.5), fixtureDimension("evidence_strength", 50, 0.5)],
    });
    const b = fixtureScoredTopic({
      topicId: "topic_b",
      totalScore: 50,
      dimensions: [fixtureDimension("demand", 70, 0.5), fixtureDimension("evidence_strength", 50, 0.5)],
    });
    const sorted = sortTopicsForRanking([a, b]);
    expect(sorted.map((t) => t.topicId)).toEqual(["topic_b", "topic_a"]);
  });

  it("breaks a fully tied score with topicId ascending as the final, stable tie-breaker", () => {
    const a = fixtureScoredTopic({ topicId: "topic_b", totalScore: 50 });
    const b = fixtureScoredTopic({ topicId: "topic_a", totalScore: 50 });
    const sorted = sortTopicsForRanking([a, b]);
    expect(sorted.map((t) => t.topicId)).toEqual(["topic_a", "topic_b"]);
  });

  it("does not mutate the input array", () => {
    const topics = [fixtureScoredTopic({ topicId: "b", totalScore: 10 }), fixtureScoredTopic({ topicId: "a", totalScore: 90 })];
    const before = topics.map((t) => t.topicId);
    sortTopicsForRanking(topics);
    expect(topics.map((t) => t.topicId)).toEqual(before);
  });

  it("assigns sequential ranks starting at 1 with a shared candidateCount", () => {
    const topics = [fixtureScoredTopic({ topicId: "a", totalScore: 90 }), fixtureScoredTopic({ topicId: "b", totalScore: 50 }), fixtureScoredTopic({ topicId: "c", totalScore: 10 })];
    const ranked = assignRanking(topics);
    expect(ranked.map((t) => t.ranking)).toEqual([
      { rank: 1, candidateCount: 3 },
      { rank: 2, candidateCount: 3 },
      { rank: 3, candidateCount: 3 },
    ]);
  });

  it("returns [] for a zero-topic input — no error", () => {
    expect(assignRanking([])).toEqual([]);
  });
});

describe("applyConfidenceCaps", () => {
  const baseContext = { sourceIsMock: false, sourceHumanReviewed: true, policyDefaultCount: 0, signalCount: 3 };

  it("leaves confidence unchanged with an empty reasons array when no cap applies", () => {
    const result = applyConfidenceCaps("high", baseContext);
    expect(result).toEqual({ finalConfidence: "high", reasons: [] });
  });

  it("caps to 'low' when the source Signal Mining run was mock-generated", () => {
    const result = applyConfidenceCaps("high", { ...baseContext, sourceIsMock: true });
    expect(result.finalConfidence).toBe("low");
    expect(result.reasons.some((r) => r.toLowerCase().includes("mock"))).toBe(true);
  });

  it("caps to 'medium' when source topics are not human-approved", () => {
    const result = applyConfidenceCaps("high", { ...baseContext, sourceHumanReviewed: false });
    expect(result.finalConfidence).toBe("medium");
    expect(result.reasons.some((r) => r.toLowerCase().includes("human-approved"))).toBe(true);
  });

  it("caps to 'low' when more than three dimensions used the policy-default fallback", () => {
    const result = applyConfidenceCaps("high", { ...baseContext, policyDefaultCount: 4 });
    expect(result.finalConfidence).toBe("low");
  });

  it("does not cap at exactly three policy-default dimensions", () => {
    const result = applyConfidenceCaps("high", { ...baseContext, policyDefaultCount: 3 });
    expect(result.finalConfidence).toBe("high");
  });

  it("caps to 'low' when the topic has zero or one supporting signal", () => {
    expect(applyConfidenceCaps("high", { ...baseContext, signalCount: 1 }).finalConfidence).toBe("low");
    expect(applyConfidenceCaps("high", { ...baseContext, signalCount: 0 }).finalConfidence).toBe("low");
  });

  it("never raises confidence above the provider's own value", () => {
    const result = applyConfidenceCaps("low", baseContext);
    expect(result.finalConfidence).toBe("low");
    expect(result.reasons).toEqual([]);
  });

  it("applies the strictest of multiple applicable caps and records every binding reason", () => {
    const result = applyConfidenceCaps("high", { sourceIsMock: true, sourceHumanReviewed: false, policyDefaultCount: 4, signalCount: 1 });
    expect(result.finalConfidence).toBe("low");
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("only records reasons for caps stricter than the provider's original confidence", () => {
    // provider already said "low" — the mock cap (also "low") doesn't need a reason since nothing changed.
    const result = applyConfidenceCaps("low", { ...baseContext, sourceIsMock: true });
    expect(result.finalConfidence).toBe("low");
    expect(result.reasons).toEqual([]);
  });
});

describe("computeRecommendation", () => {
  const baseContext = { totalScore: 80, evidenceStrengthScore: 70, blockersCount: 0, finalConfidence: "high" as const, sourceIsMock: false, sourceHumanReviewed: true };

  it("advances when every condition is met", () => {
    expect(computeRecommendation(baseContext)).toBe("advance");
  });

  it("holds when totalScore is below 50, regardless of other factors", () => {
    expect(computeRecommendation({ ...baseContext, totalScore: 49 })).toBe("hold");
  });

  it("blockers force hold regardless of score", () => {
    expect(computeRecommendation({ ...baseContext, totalScore: 95, blockersCount: 1 })).toBe("hold");
  });

  it("needs_human_review when totalScore is in [50, 70)", () => {
    expect(computeRecommendation({ ...baseContext, totalScore: 60 })).toBe("needs_human_review");
  });

  it("needs_human_review when totalScore >= 70 but evidence_strength is below 60", () => {
    expect(computeRecommendation({ ...baseContext, evidenceStrengthScore: 59 })).toBe("needs_human_review");
  });

  it("needs_human_review when totalScore >= 70 but confidence is low", () => {
    expect(computeRecommendation({ ...baseContext, finalConfidence: "low" })).toBe("needs_human_review");
  });

  it("needs_human_review when the topic would otherwise advance but the source run is mock-generated", () => {
    expect(computeRecommendation({ ...baseContext, sourceIsMock: true })).toBe("needs_human_review");
  });

  it("needs_human_review when the topic would otherwise advance but source topics are not human-approved", () => {
    expect(computeRecommendation({ ...baseContext, sourceHumanReviewed: false })).toBe("needs_human_review");
  });

  it("never returns 'reject' automatically", () => {
    const scenarios = [
      { ...baseContext, totalScore: 10 },
      { ...baseContext, blockersCount: 5 },
      { ...baseContext, totalScore: 60 },
      { ...baseContext, sourceIsMock: true },
    ];
    for (const scenario of scenarios) {
      expect(computeRecommendation(scenario)).not.toBe("reject");
    }
  });

  it("advance requires confidence high or medium", () => {
    expect(computeRecommendation({ ...baseContext, finalConfidence: "medium" })).toBe("advance");
  });
});
