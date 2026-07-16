import { describe, expect, it } from "vitest";
import { LLMProviderConfigError as ReExportedConfigError, LLMProviderResponseError as ReExportedResponseError } from "../llm/topic-scoring-provider";
import { LLMProviderConfigError, LLMProviderResponseError } from "../llm/provider";
import type { TopicScoringProvider } from "../llm/topic-scoring-provider";
import type { TopicScoringAnalysis, TopicScoringLLMRequest } from "../types/topic-scoring";
import type { LLMStructuredResult } from "../types/llm";

describe("topic-scoring-provider module", () => {
  it("re-exports the same LLMProviderConfigError class as llm/provider.ts, not a duplicate", () => {
    expect(ReExportedConfigError).toBe(LLMProviderConfigError);
  });

  it("re-exports the same LLMProviderResponseError class as llm/provider.ts, not a duplicate", () => {
    expect(ReExportedResponseError).toBe(LLMProviderResponseError);
  });

  it("LLMProviderResponseError still carries a machine-readable reason", () => {
    const err = new ReExportedResponseError("message", "refusal");
    expect(err.reason).toBe("refusal");
    expect(err).toBeInstanceOf(Error);
  });
});

function validAnalysis(): TopicScoringAnalysis {
  return {
    topicAssessments: [],
    portfolioObservations: { topicCoverage: "No topics supplied.", evidenceCoverage: "N/A", majorLimitations: [], requiresHumanReview: true },
  };
}

describe("TopicScoringProvider interface", () => {
  it("can be implemented by a minimal class with just a name and generateStructuredScores", async () => {
    class FakeProvider implements TopicScoringProvider {
      readonly name = "fake";
      async generateStructuredScores(_request: TopicScoringLLMRequest): Promise<LLMStructuredResult<TopicScoringAnalysis>> {
        return { data: validAnalysis(), provider: this.name, model: "fake-model", requestId: null, stopReason: "end_turn", inputTokens: null, outputTokens: null };
      }
    }

    const provider = new FakeProvider();
    expect(provider.name).toBe("fake");

    const result = await provider.generateStructuredScores({} as TopicScoringLLMRequest);
    expect(result.data.topicAssessments).toEqual([]);
    expect(result.provider).toBe("fake");
  });
});
