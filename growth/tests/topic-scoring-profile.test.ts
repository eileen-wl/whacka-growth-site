import { describe, expect, it } from "vitest";
import {
  INSUFFICIENT_EVIDENCE_FALLBACK_SCORE,
  TOPIC_SCORING_PROFILE_ID,
  TOPIC_SCORING_PROFILE_VERSION,
  buildTopicScoringProfileSummary,
  getRecommendationRulesSummary,
  getTopicScoringProfile,
} from "../scoring/topic-scoring-profile";

const REQUIRED_DIMENSION_KEYS = ["demand", "audience_relevance", "product_fit", "competition", "feasibility", "novelty", "evidence_strength"];

describe("getTopicScoringProfile", () => {
  it("has the fixed v1 profile id and version", () => {
    expect(TOPIC_SCORING_PROFILE_ID).toBe("small_business_topic_scoring");
    expect(TOPIC_SCORING_PROFILE_VERSION).toBe("1.0.0");
    const profile = getTopicScoringProfile();
    expect(profile.id).toBe("small_business_topic_scoring");
    expect(profile.version).toBe("1.0.0");
  });

  it("has exactly the seven required dimensions", () => {
    const profile = getTopicScoringProfile();
    expect(profile.dimensions.map((d) => d.key).sort()).toEqual([...REQUIRED_DIMENSION_KEYS].sort());
    expect(profile.dimensions).toHaveLength(7);
  });

  it("has the exact specified weights", () => {
    const profile = getTopicScoringProfile();
    const weights = Object.fromEntries(profile.dimensions.map((d) => [d.key, d.weight]));
    expect(weights).toEqual({
      demand: 0.2,
      audience_relevance: 0.15,
      product_fit: 0.2,
      competition: 0.1,
      feasibility: 0.15,
      novelty: 0.1,
      evidence_strength: 0.1,
    });
  });

  it("weights sum to exactly 1 within floating-point tolerance", () => {
    const profile = getTopicScoringProfile();
    const sum = profile.dimensions.reduce((total, d) => total + d.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.0001);
  });

  it("the insufficient-evidence fallback score is 50", () => {
    expect(INSUFFICIENT_EVIDENCE_FALLBACK_SCORE).toBe(50);
    expect(getTopicScoringProfile().insufficientEvidenceFallbackScore).toBe(50);
  });

  it("returns a fresh copy each call (callers cannot mutate the shared constant)", () => {
    const a = getTopicScoringProfile();
    a.dimensions[0].weight = 999;
    const b = getTopicScoringProfile();
    expect(b.dimensions[0].weight).not.toBe(999);
  });

  it("every dimension has a non-empty label and description", () => {
    for (const dimension of getTopicScoringProfile().dimensions) {
      expect(dimension.label.length).toBeGreaterThan(0);
      expect(dimension.description.length).toBeGreaterThan(0);
    }
  });
});

describe("getRecommendationRulesSummary / buildTopicScoringProfileSummary", () => {
  it("documents all four recommendation branches, including that reject is never automatic", () => {
    const rules = getRecommendationRulesSummary();
    expect(rules.advance).toContain("70");
    expect(rules.needsHumanReview.length).toBeGreaterThan(0);
    expect(rules.hold).toContain("50");
    expect(rules.reject.toLowerCase()).toContain("never assigned automatically");
  });

  it("buildTopicScoringProfileSummary embeds dimensions, rules, and the fallback score together", () => {
    const summary = buildTopicScoringProfileSummary();
    expect(summary.id).toBe("small_business_topic_scoring");
    expect(summary.dimensions).toHaveLength(7);
    expect(summary.insufficientEvidenceFallbackScore).toBe(50);
    expect(summary.recommendationRules.reject).toBeDefined();
  });
});
