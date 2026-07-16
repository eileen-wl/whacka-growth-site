import { describe, expect, it } from "vitest";
import { LLMProviderConfigError as ReExportedConfigError, LLMProviderResponseError as ReExportedResponseError } from "../llm/signal-mining-provider";
import { LLMProviderConfigError, LLMProviderResponseError } from "../llm/provider";
import type { SignalMiningProvider } from "../llm/signal-mining-provider";
import type { SignalMiningAnalysis, SignalMiningLLMRequest } from "../types/signal-mining";
import type { LLMStructuredResult } from "../types/llm";

describe("signal-mining-provider module", () => {
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

function validAnalysis(): SignalMiningAnalysis {
  return {
    signalProposals: [],
    topicClusters: [],
    unresolvedSourceRecords: [],
    analysisNotes: { sourceCoverage: "No source records supplied.", majorLimitations: [], requiresHumanReview: true },
  };
}

describe("SignalMiningProvider interface", () => {
  it("can be implemented by a minimal class with just a name and generateStructuredSignals", async () => {
    class FakeProvider implements SignalMiningProvider {
      readonly name = "fake";
      async generateStructuredSignals(_request: SignalMiningLLMRequest): Promise<LLMStructuredResult<SignalMiningAnalysis>> {
        return { data: validAnalysis(), provider: this.name, model: "fake-model", requestId: null, stopReason: "end_turn", inputTokens: null, outputTokens: null };
      }
    }

    const provider = new FakeProvider();
    expect(provider.name).toBe("fake");

    const result = await provider.generateStructuredSignals({} as SignalMiningLLMRequest);
    expect(result.data.signalProposals).toEqual([]);
    expect(result.provider).toBe("fake");
  });
});
