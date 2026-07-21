import { describe, expect, it } from "vitest";
import { LLMProviderConfigError as ReExportedConfigError, LLMProviderResponseError as ReExportedResponseError } from "../llm/asset-generation-provider";
import { LLMProviderConfigError, LLMProviderResponseError } from "../llm/provider";
import type { AssetGenerationProvider } from "../llm/asset-generation-provider";
import type { AssetGenerationAnalysis, AssetGenerationLLMRequest } from "../types/asset-generation";
import type { LLMStructuredResult } from "../types/llm";

describe("asset-generation-provider module", () => {
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

function validAnalysis(): AssetGenerationAnalysis {
  return {
    appConcept: {
      name: "Test App",
      slugSuggestion: "test-app",
      category: "Mini App Concept",
      tagline: "A test app.",
      shortDescription: "A short description.",
      problem: "The problem.",
      solution: "The solution.",
      whoItsFor: ["Small shop owners"],
      steps: [{ title: "Step 1", description: "Do the thing." }],
      appPrompt: "Build a mini app.",
      creativeBrief: { hook: "Never worry again.", persona: "Owner", scenario: "A scenario.", assumptions: [], limitations: [] },
    },
    seo: { title: "Test App", metaDescription: "A meta description.", primaryKeyword: "test app", secondaryKeywords: [], faq: [] },
    cta: { primaryType: "build", labels: { primary: "Build with Whacka", viewDemo: null, remix: null, build: "Build with Whacka", copyPrompt: null }, rationale: "Build is the safest CTA." },
    socialPosts: [],
    generationNotes: { topicAlignment: "Aligned.", differentiationFromExistingApps: "Distinct.", assumptions: [], limitations: [], requiresHumanReview: true },
  };
}

describe("AssetGenerationProvider interface", () => {
  it("can be implemented by a minimal class with just a name and generateStructuredAssets", async () => {
    class FakeProvider implements AssetGenerationProvider {
      readonly name = "fake";
      async generateStructuredAssets(_request: AssetGenerationLLMRequest): Promise<LLMStructuredResult<AssetGenerationAnalysis>> {
        return { data: validAnalysis(), provider: this.name, model: "fake-model", requestId: null, stopReason: "end_turn", inputTokens: null, outputTokens: null };
      }
    }

    const provider = new FakeProvider();
    expect(provider.name).toBe("fake");

    const result = await provider.generateStructuredAssets({} as AssetGenerationLLMRequest);
    expect(result.data.appConcept.name).toBe("Test App");
    expect(result.provider).toBe("fake");
  });
});
