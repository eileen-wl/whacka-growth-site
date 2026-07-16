import { AuthenticationError, InternalServerError, RateLimitError } from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { AnthropicSignalMiningProvider } from "../llm/anthropic-signal-mining-provider";
import { LLMProviderConfigError, LLMProviderResponseError } from "../llm/provider";
import type { AnthropicMessagesClient } from "../llm/anthropic-signal-mining-provider";
import type { SignalMiningAnalysis, SignalMiningLLMRequest } from "../types/signal-mining";

const FAKE_API_KEY = "sk-ant-test-fake-key-do-not-use-654321";

const REQUEST: SignalMiningLLMRequest = {
  purpose: "purpose",
  campaign: { id: "test_campaign", name: "Test Campaign" },
  period: { start: "2026-07-08", end: "2026-07-14" },
  language: "en",
  sourceRecordCatalog: [],
  existingContentCatalog: [],
  feedbackContext: null,
  dataQualityWarnings: [],
  reportingRules: [],
  responseSchemaDescription: "desc",
  maxTokens: 8000,
  systemPrompt: "SYSTEM_PROMPT_TEXT",
  userPrompt: "USER_PROMPT_TEXT",
};

function validAnalysis(): SignalMiningAnalysis {
  return {
    signalProposals: [],
    topicClusters: [],
    unresolvedSourceRecords: [],
    analysisNotes: { sourceCoverage: "No source records supplied.", majorLimitations: [], requiresHumanReview: true },
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

describe("AnthropicSignalMiningProvider — configuration", () => {
  it("is named 'anthropic'", () => {
    expect(new AnthropicSignalMiningProvider({ apiKey: "x", model: "m" }).name).toBe("anthropic");
  });

  it("does not require a real API key or model just to construct", () => {
    expect(() => new AnthropicSignalMiningProvider()).not.toThrow();
  });

  it("fails with LLMProviderConfigError only when actually generating, if no API key and no injected client", async () => {
    const provider = new AnthropicSignalMiningProvider({ model: "claude-test-model" });
    await expect(provider.generateStructuredSignals(REQUEST)).rejects.toThrow(LLMProviderConfigError);
  });

  it("fails with LLMProviderConfigError when no model is configured, even with a client injected", async () => {
    const { client } = fakeClient(async () => baseMessage());
    const provider = new AnthropicSignalMiningProvider({ apiKey: FAKE_API_KEY, client });
    await expect(provider.generateStructuredSignals(REQUEST)).rejects.toThrow(LLMProviderConfigError);
  });

  it("does not require an API key when a client is injected", async () => {
    const { client } = fakeClient(async () => baseMessage());
    const provider = new AnthropicSignalMiningProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredSignals(REQUEST)).resolves.toBeDefined();
  });
});

describe("AnthropicSignalMiningProvider — request construction", () => {
  it("passes the configured model", async () => {
    const { client, parse } = fakeClient(async () => baseMessage());
    const provider = new AnthropicSignalMiningProvider({ model: "claude-test-model", client });
    await provider.generateStructuredSignals(REQUEST);
    expect(parse).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-test-model" }));
  });

  it("passes the system prompt and a single user message with the user prompt", async () => {
    const { client, parse } = fakeClient(async () => baseMessage());
    const provider = new AnthropicSignalMiningProvider({ model: "claude-test-model", client });
    await provider.generateStructuredSignals(REQUEST);
    const params = parse.mock.calls[0][0] as Record<string, unknown>;
    expect(params.system).toBe("SYSTEM_PROMPT_TEXT");
    expect(params.messages).toEqual([{ role: "user", content: "USER_PROMPT_TEXT" }]);
  });

  it("passes a structured output_config.format", async () => {
    const { client, parse } = fakeClient(async () => baseMessage());
    const provider = new AnthropicSignalMiningProvider({ model: "claude-test-model", client });
    await provider.generateStructuredSignals(REQUEST);
    const params = parse.mock.calls[0][0] as { output_config?: { format?: unknown } };
    expect(params.output_config?.format).toBeDefined();
  });
});

describe("AnthropicSignalMiningProvider — successful response handling", () => {
  it("returns the parsed output as data with safe metadata", async () => {
    const { client } = fakeClient(async () => baseMessage());
    const provider = new AnthropicSignalMiningProvider({ model: "claude-test-model", client });
    const result = await provider.generateStructuredSignals(REQUEST);
    expect(result.data).toEqual(validAnalysis());
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-test-model");
    expect(result.requestId).toBe("req_abc123");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });
});

describe("AnthropicSignalMiningProvider — response failure handling", () => {
  it("rejects an empty content response", async () => {
    const { client } = fakeClient(async () => baseMessage({ content: [] }));
    const provider = new AnthropicSignalMiningProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredSignals(REQUEST)).rejects.toMatchObject({ reason: "empty_content" });
  });

  it("rejects a response with no parsed output", async () => {
    const { client } = fakeClient(async () => baseMessage({ parsed_output: null }));
    const provider = new AnthropicSignalMiningProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredSignals(REQUEST)).rejects.toMatchObject({ reason: "missing_parsed_output" });
  });

  it("clearly rejects a refusal stop reason", async () => {
    const { client } = fakeClient(async () => baseMessage({ stop_reason: "refusal" }));
    const provider = new AnthropicSignalMiningProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredSignals(REQUEST)).rejects.toMatchObject({ reason: "refusal" });
  });

  it("clearly rejects a max_tokens truncation", async () => {
    const { client } = fakeClient(async () => baseMessage({ stop_reason: "max_tokens" }));
    const provider = new AnthropicSignalMiningProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredSignals(REQUEST)).rejects.toMatchObject({ reason: "truncated" });
  });
});

describe("AnthropicSignalMiningProvider — API error sanitization", () => {
  it("sanitizes an authentication error", async () => {
    const { client } = fakeClient(async () => {
      throw new AuthenticationError(401, { type: "authentication_error", message: "invalid x-api-key" }, "invalid x-api-key", new Headers());
    });
    const provider = new AnthropicSignalMiningProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });

    try {
      await provider.generateStructuredSignals(REQUEST);
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
    const provider = new AnthropicSignalMiningProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });
    await expect(provider.generateStructuredSignals(REQUEST)).rejects.toMatchObject({ reason: "rate_limited" });
  });

  it("sanitizes an overloaded/internal-server error", async () => {
    const { client } = fakeClient(async () => {
      throw new InternalServerError(529, { type: "overloaded_error", message: "overloaded" }, "overloaded", new Headers());
    });
    const provider = new AnthropicSignalMiningProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });
    await expect(provider.generateStructuredSignals(REQUEST)).rejects.toMatchObject({ reason: "overloaded" });
  });

  it("never lets the configured API key appear in any thrown error message", async () => {
    const { client } = fakeClient(async () => {
      throw new AuthenticationError(401, { type: "authentication_error", message: "invalid x-api-key" }, "invalid x-api-key", new Headers());
    });
    const provider = new AnthropicSignalMiningProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });

    try {
      await provider.generateStructuredSignals(REQUEST);
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(FAKE_API_KEY);
      expect(message.toLowerCase()).not.toContain("bearer");
    }
  });
});
