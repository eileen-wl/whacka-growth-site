import { describe, expect, it } from "vitest";
import { LLMProviderConfigError as ReExportedConfigError, LLMProviderResponseError as ReExportedResponseError } from "../llm/experiment-decision-provider";
import { LLMProviderConfigError, LLMProviderResponseError } from "../llm/provider";
import type { ExperimentDecisionProvider } from "../llm/experiment-decision-provider";
import type { ExperimentDecisionAnalysis, ExperimentDecisionLLMRequest } from "../types/experiment-decision";
import type { LLMStructuredResult } from "../types/llm";

describe("experiment-decision-provider module", () => {
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

function validAnalysis(): ExperimentDecisionAnalysis {
  return {
    decisionSummary: { decisionStatus: "defer", headline: "H", rationale: "R", confidence: "low", recommendedExperimentId: null },
    rankedExperimentOptions: [],
    recommendedExperiment: null,
    deferDecision: {
      reason: "Not enough evidence.",
      missingEvidence: ["More data."],
      requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: [] }],
      earliestDecisionCondition: "Later.",
    },
    rejectedOrDeferredOptions: [],
    handoff: { forNextLoop: [], humanReviewRequired: true },
  };
}

describe("ExperimentDecisionProvider interface", () => {
  it("can be implemented by a minimal class with just a name and generateStructuredDecision", async () => {
    class FakeProvider implements ExperimentDecisionProvider {
      readonly name = "fake";
      async generateStructuredDecision(_request: ExperimentDecisionLLMRequest): Promise<LLMStructuredResult<ExperimentDecisionAnalysis>> {
        return {
          data: validAnalysis(),
          provider: this.name,
          model: "fake-model",
          requestId: null,
          stopReason: "end_turn",
          inputTokens: null,
          outputTokens: null,
        };
      }
    }

    const provider = new FakeProvider();
    expect(provider.name).toBe("fake");

    const result = await provider.generateStructuredDecision({} as ExperimentDecisionLLMRequest);
    expect(result.data.decisionSummary.decisionStatus).toBe("defer");
    expect(result.provider).toBe("fake");
  });
});
