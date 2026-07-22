import { AuthenticationError, InternalServerError, RateLimitError } from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { AnthropicAssetGenerationProvider } from "../llm/anthropic-asset-generation-provider";
import { LLMProviderConfigError, LLMProviderResponseError } from "../llm/provider";
import type { AnthropicMessagesClient } from "../llm/anthropic-asset-generation-provider";
import type { AssetGenerationAnalysis, AssetGenerationContext, AssetGenerationLLMRequest } from "../types/asset-generation";

const FAKE_API_KEY = "sk-ant-test-fake-key-do-not-use-654321";

const CONTEXT: AssetGenerationContext = {
  period: { start: "2026-07-08", end: "2026-07-14" },
  campaign: { id: "test_campaign", name: "Test Campaign" },
  topicId: "topic_abc",
  scoredTopicId: "scoredtopic_abc",
  canonicalName: "Inventory Tracker",
  slug: "inventory-tracker",
  problemStatement: "Small shops lose track of stock.",
  targetAudience: "Small retail shop owners",
  useCases: ["Track stock counts"],
  desiredOutcome: "Fewer stockouts.",
  rank: 1,
  candidateCount: 3,
  totalScore: 72,
  recommendation: "advance",
  confidence: "high",
  dimensions: [],
  blockers: [],
  relationshipToExistingContent: { status: "new", relatedAppSlugs: [], relatedTopicIds: [] },
  sourceScoringIsMock: false,
  sourceTopicsHumanReviewed: true,
  dataQualityWarnings: [],
  dataQualityLimitations: [],
  language: "en",
  allowedCtaTypes: ["view_demo", "remix", "build", "copy_prompt"],
  requestedSocialChannels: [],
  existingAppCatalog: [],
  cmsFieldRequirements: [],
};

const REQUEST: AssetGenerationLLMRequest = {
  purpose: "purpose",
  period: CONTEXT.period,
  campaign: CONTEXT.campaign,
  language: "en",
  context: CONTEXT,
  allowedCtaTypes: CONTEXT.allowedCtaTypes,
  requestedSocialChannels: [],
  reportingRules: [],
  responseSchemaDescription: "desc",
  maxTokens: 10000,
  systemPrompt: "SYSTEM_PROMPT_TEXT",
  userPrompt: "USER_PROMPT_TEXT",
};

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
    socialFeaturedExistingAppSlugs: [],
    generationNotes: { topicAlignment: "Aligned.", differentiationFromExistingApps: "Distinct.", assumptions: [], limitations: [], requiresHumanReview: true },
  };
}

function baseMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_123",
    model: "claude-test-model",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "..." }],
    parsed_output: validAnalysis(),
    usage: { input_tokens: 100, output_tokens: 50 },
    _request_id: "req_abc123",
    ...overrides,
  };
}

function fakeClient(parseImpl: (params: Record<string, unknown>) => Promise<unknown>): { client: AnthropicMessagesClient; parse: ReturnType<typeof vi.fn> } {
  const parse = vi.fn(parseImpl);
  return { client: { messages: { parse } } as unknown as AnthropicMessagesClient, parse };
}

describe("AnthropicAssetGenerationProvider — configuration", () => {
  it("is named 'anthropic'", () => {
    expect(new AnthropicAssetGenerationProvider({ apiKey: "x", model: "m" }).name).toBe("anthropic");
  });

  it("does not require a real API key or model just to construct", () => {
    expect(() => new AnthropicAssetGenerationProvider()).not.toThrow();
  });

  it("fails with LLMProviderConfigError only when actually generating, if no API key and no injected client", async () => {
    const provider = new AnthropicAssetGenerationProvider({ model: "claude-test-model" });
    await expect(provider.generateStructuredAssets(REQUEST)).rejects.toThrow(LLMProviderConfigError);
  });

  it("fails with LLMProviderConfigError when no model is configured, even with a client injected", async () => {
    const { client } = fakeClient(async () => baseMessage());
    const provider = new AnthropicAssetGenerationProvider({ apiKey: FAKE_API_KEY, client });
    await expect(provider.generateStructuredAssets(REQUEST)).rejects.toThrow(LLMProviderConfigError);
  });

  it("does not require an API key when a client is injected", async () => {
    const { client } = fakeClient(async () => baseMessage());
    const provider = new AnthropicAssetGenerationProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredAssets(REQUEST)).resolves.toBeDefined();
  });
});

describe("AnthropicAssetGenerationProvider — request construction", () => {
  it("passes the configured model", async () => {
    const { client, parse } = fakeClient(async () => baseMessage());
    const provider = new AnthropicAssetGenerationProvider({ model: "claude-test-model", client });
    await provider.generateStructuredAssets(REQUEST);
    expect(parse).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-test-model" }));
  });

  it("passes the system prompt and a single user message with the user prompt", async () => {
    const { client, parse } = fakeClient(async () => baseMessage());
    const provider = new AnthropicAssetGenerationProvider({ model: "claude-test-model", client });
    await provider.generateStructuredAssets(REQUEST);
    const params = parse.mock.calls[0][0] as Record<string, unknown>;
    expect(params.system).toBe("SYSTEM_PROMPT_TEXT");
    expect(params.messages).toEqual([{ role: "user", content: "USER_PROMPT_TEXT" }]);
  });

  it("passes a structured output_config.format", async () => {
    const { client, parse } = fakeClient(async () => baseMessage());
    const provider = new AnthropicAssetGenerationProvider({ model: "claude-test-model", client });
    await provider.generateStructuredAssets(REQUEST);
    const params = parse.mock.calls[0][0] as { output_config?: { format?: unknown } };
    expect(params.output_config?.format).toBeDefined();
  });
});

describe("AnthropicAssetGenerationProvider — successful response handling", () => {
  it("returns the parsed output as data with safe metadata", async () => {
    const { client } = fakeClient(async () => baseMessage());
    const provider = new AnthropicAssetGenerationProvider({ model: "claude-test-model", client });
    const result = await provider.generateStructuredAssets(REQUEST);
    expect(result.data).toEqual(validAnalysis());
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-test-model");
    expect(result.requestId).toBe("req_abc123");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });
});

describe("AnthropicAssetGenerationProvider — response failure handling", () => {
  it("rejects an empty content response", async () => {
    const { client } = fakeClient(async () => baseMessage({ content: [] }));
    const provider = new AnthropicAssetGenerationProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredAssets(REQUEST)).rejects.toMatchObject({ reason: "empty_content" });
  });

  it("rejects a response with no parsed output", async () => {
    const { client } = fakeClient(async () => baseMessage({ parsed_output: null }));
    const provider = new AnthropicAssetGenerationProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredAssets(REQUEST)).rejects.toMatchObject({ reason: "missing_parsed_output" });
  });

  it("clearly rejects a refusal stop reason", async () => {
    const { client } = fakeClient(async () => baseMessage({ stop_reason: "refusal" }));
    const provider = new AnthropicAssetGenerationProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredAssets(REQUEST)).rejects.toMatchObject({ reason: "refusal" });
  });

  it("clearly rejects a max_tokens truncation", async () => {
    const { client } = fakeClient(async () => baseMessage({ stop_reason: "max_tokens" }));
    const provider = new AnthropicAssetGenerationProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredAssets(REQUEST)).rejects.toMatchObject({ reason: "truncated" });
  });
});

describe("AnthropicAssetGenerationProvider — API error sanitization", () => {
  it("sanitizes an authentication error", async () => {
    const { client } = fakeClient(async () => {
      throw new AuthenticationError(401, { type: "authentication_error", message: "invalid x-api-key" }, "invalid x-api-key", new Headers());
    });
    const provider = new AnthropicAssetGenerationProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });

    try {
      await provider.generateStructuredAssets(REQUEST);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderResponseError);
      expect((err as LLMProviderResponseError).reason).toBe("authentication_error");
      expect((err as Error).message).not.toContain(FAKE_API_KEY);
    }
  });

  it("sanitizes a rate-limit error", async () => {
    const { client } = fakeClient(async () => {
      throw new RateLimitError(429, { type: "rate_limit_error", message: "rate limited" }, "rate limited", new Headers());
    });
    const provider = new AnthropicAssetGenerationProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });
    await expect(provider.generateStructuredAssets(REQUEST)).rejects.toMatchObject({ reason: "rate_limited" });
  });

  it("sanitizes an overloaded/internal-server error", async () => {
    const { client } = fakeClient(async () => {
      throw new InternalServerError(529, { type: "overloaded_error", message: "overloaded" }, "overloaded", new Headers());
    });
    const provider = new AnthropicAssetGenerationProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });
    await expect(provider.generateStructuredAssets(REQUEST)).rejects.toMatchObject({ reason: "overloaded" });
  });

  it("never lets the configured API key appear in any thrown error message", async () => {
    const { client } = fakeClient(async () => {
      throw new AuthenticationError(401, { type: "authentication_error", message: "invalid x-api-key" }, "invalid x-api-key", new Headers());
    });
    const provider = new AnthropicAssetGenerationProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });

    try {
      await provider.generateStructuredAssets(REQUEST);
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(FAKE_API_KEY);
      expect(message.toLowerCase()).not.toContain("bearer");
    }
  });
});
