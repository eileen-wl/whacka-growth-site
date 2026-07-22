import { AnthropicError, AuthenticationError, InternalServerError, RateLimitError } from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { AnthropicTopicScoringProvider } from "../llm/anthropic-topic-scoring-provider";
import { LLMProviderConfigError, LLMProviderResponseError } from "../llm/provider";
import type { AnthropicMessagesClient } from "../llm/anthropic-topic-scoring-provider";
import type { TopicScoringAnalysis, TopicScoringLLMRequest } from "../types/topic-scoring";

const FAKE_API_KEY = "sk-ant-test-fake-key-do-not-use-654321";

const REQUEST: TopicScoringLLMRequest = {
  purpose: "purpose",
  campaign: { id: "test_campaign", name: "Test Campaign" },
  period: { start: "2026-07-08", end: "2026-07-14" },
  language: "en",
  scoringProfile: { id: "small_business_topic_scoring", version: "1.0.0", dimensions: [], insufficientEvidenceFallbackScore: 50 },
  topicContexts: [],
  topicCatalog: [],
  dataQualityWarnings: [],
  sourceIsMock: false,
  sourceHumanReviewed: true,
  reportingRules: [],
  responseSchemaDescription: "desc",
  maxTokens: 8000,
  systemPrompt: "SYSTEM_PROMPT_TEXT",
  userPrompt: "USER_PROMPT_TEXT",
};

function validAnalysis(): TopicScoringAnalysis {
  return {
    topicAssessments: [],
    portfolioObservations: { topicCoverage: "No topics supplied.", evidenceCoverage: "N/A", majorLimitations: [], requiresHumanReview: true },
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

describe("AnthropicTopicScoringProvider — configuration", () => {
  it("is named 'anthropic'", () => {
    expect(new AnthropicTopicScoringProvider({ apiKey: "x", model: "m" }).name).toBe("anthropic");
  });

  it("does not require a real API key or model just to construct", () => {
    expect(() => new AnthropicTopicScoringProvider()).not.toThrow();
  });

  it("fails with LLMProviderConfigError only when actually generating, if no API key and no injected client", async () => {
    const provider = new AnthropicTopicScoringProvider({ model: "claude-test-model" });
    await expect(provider.generateStructuredScores(REQUEST)).rejects.toThrow(LLMProviderConfigError);
  });

  it("fails with LLMProviderConfigError when no model is configured, even with a client injected", async () => {
    const { client } = fakeClient(async () => baseMessage());
    const provider = new AnthropicTopicScoringProvider({ apiKey: FAKE_API_KEY, client });
    await expect(provider.generateStructuredScores(REQUEST)).rejects.toThrow(LLMProviderConfigError);
  });

  it("does not require an API key when a client is injected", async () => {
    const { client } = fakeClient(async () => baseMessage());
    const provider = new AnthropicTopicScoringProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredScores(REQUEST)).resolves.toBeDefined();
  });
});

describe("AnthropicTopicScoringProvider — request construction", () => {
  it("passes the configured model", async () => {
    const { client, parse } = fakeClient(async () => baseMessage());
    const provider = new AnthropicTopicScoringProvider({ model: "claude-test-model", client });
    await provider.generateStructuredScores(REQUEST);
    expect(parse).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-test-model" }));
  });

  it("passes the system prompt and a single user message with the user prompt", async () => {
    const { client, parse } = fakeClient(async () => baseMessage());
    const provider = new AnthropicTopicScoringProvider({ model: "claude-test-model", client });
    await provider.generateStructuredScores(REQUEST);
    const params = parse.mock.calls[0][0] as Record<string, unknown>;
    expect(params.system).toBe("SYSTEM_PROMPT_TEXT");
    expect(params.messages).toEqual([{ role: "user", content: "USER_PROMPT_TEXT" }]);
  });

  it("passes a structured output_config.format", async () => {
    const { client, parse } = fakeClient(async () => baseMessage());
    const provider = new AnthropicTopicScoringProvider({ model: "claude-test-model", client });
    await provider.generateStructuredScores(REQUEST);
    const params = parse.mock.calls[0][0] as { output_config?: { format?: unknown } };
    expect(params.output_config?.format).toBeDefined();
  });
});

describe("AnthropicTopicScoringProvider — successful response handling", () => {
  it("returns the parsed output as data with safe metadata", async () => {
    const { client } = fakeClient(async () => baseMessage());
    const provider = new AnthropicTopicScoringProvider({ model: "claude-test-model", client });
    const result = await provider.generateStructuredScores(REQUEST);
    expect(result.data).toEqual(validAnalysis());
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-test-model");
    expect(result.requestId).toBe("req_abc123");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });
});

describe("AnthropicTopicScoringProvider — response failure handling", () => {
  it("rejects an empty content response", async () => {
    const { client } = fakeClient(async () => baseMessage({ content: [] }));
    const provider = new AnthropicTopicScoringProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredScores(REQUEST)).rejects.toMatchObject({ reason: "empty_content" });
  });

  it("rejects a response with no parsed output", async () => {
    const { client } = fakeClient(async () => baseMessage({ parsed_output: null }));
    const provider = new AnthropicTopicScoringProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredScores(REQUEST)).rejects.toMatchObject({ reason: "missing_parsed_output" });
  });

  it("clearly rejects a refusal stop reason", async () => {
    const { client } = fakeClient(async () => baseMessage({ stop_reason: "refusal" }));
    const provider = new AnthropicTopicScoringProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredScores(REQUEST)).rejects.toMatchObject({ reason: "refusal" });
  });

  it("clearly rejects a max_tokens truncation", async () => {
    const { client } = fakeClient(async () => baseMessage({ stop_reason: "max_tokens" }));
    const provider = new AnthropicTopicScoringProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredScores(REQUEST)).rejects.toMatchObject({ reason: "truncated" });
  });

  it("treats a raw JSON syntax parse failure (the SDK's own truncation signature) as a truncation, not a generic schema failure", async () => {
    const { client } = fakeClient(async () => {
      throw new AnthropicError("Failed to parse structured output as JSON: Unterminated string in JSON at position 19210");
    });
    const provider = new AnthropicTopicScoringProvider({ model: "claude-test-model", client });

    try {
      await provider.generateStructuredScores(REQUEST);
      expect.unreachable();
    } catch (err) {
      const providerError = err as LLMProviderResponseError;
      expect(providerError).toBeInstanceOf(LLMProviderResponseError);
      expect(providerError.reason).toBe("truncated");
      expect(providerError.message).toContain("TOPIC_SCORING_MAX_TOKENS");
      expect(providerError.message).toContain("8000"); // REQUEST.maxTokens, safe metadata
      expect(providerError.message).not.toContain("Unterminated string in JSON at position 19210"); // never echoes raw model/SDK parse detail
      expect(providerError.message).not.toContain("USER_PROMPT_TEXT");
      expect(providerError.message).not.toContain("SYSTEM_PROMPT_TEXT");
    }
  });

  it("still treats a schema-validation failure on well-formed JSON as missing_parsed_output, not truncation", async () => {
    const { client } = fakeClient(async () => {
      throw new AnthropicError(
        'Failed to parse structured output: Invalid input\nValidation issues:\n- topicAssessments: Required'
      );
    });
    const provider = new AnthropicTopicScoringProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredScores(REQUEST)).rejects.toMatchObject({ reason: "missing_parsed_output" });
  });
});

describe("AnthropicTopicScoringProvider — API error sanitization", () => {
  it("sanitizes an authentication error", async () => {
    const { client } = fakeClient(async () => {
      throw new AuthenticationError(401, { type: "authentication_error", message: "invalid x-api-key" }, "invalid x-api-key", new Headers());
    });
    const provider = new AnthropicTopicScoringProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });

    try {
      await provider.generateStructuredScores(REQUEST);
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
    const provider = new AnthropicTopicScoringProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });
    await expect(provider.generateStructuredScores(REQUEST)).rejects.toMatchObject({ reason: "rate_limited" });
  });

  it("sanitizes an overloaded/internal-server error", async () => {
    const { client } = fakeClient(async () => {
      throw new InternalServerError(529, { type: "overloaded_error", message: "overloaded" }, "overloaded", new Headers());
    });
    const provider = new AnthropicTopicScoringProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });
    await expect(provider.generateStructuredScores(REQUEST)).rejects.toMatchObject({ reason: "overloaded" });
  });

  it("never lets the configured API key appear in any thrown error message", async () => {
    const { client } = fakeClient(async () => {
      throw new AuthenticationError(401, { type: "authentication_error", message: "invalid x-api-key" }, "invalid x-api-key", new Headers());
    });
    const provider = new AnthropicTopicScoringProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });

    try {
      await provider.generateStructuredScores(REQUEST);
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(FAKE_API_KEY);
      expect(message.toLowerCase()).not.toContain("bearer");
    }
  });
});
