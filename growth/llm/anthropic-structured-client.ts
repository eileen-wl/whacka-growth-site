import Anthropic, {
  AnthropicError,
  APIConnectionError,
  APIError,
  AuthenticationError,
  InternalServerError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { LLMProviderResponseError } from "./provider";
import type { LLMStructuredResult } from "../types/llm";

/**
 * Conservative, SDK-managed retry count. The SDK only retries explicitly
 * transient failures (429 rate limits, 5xx/overloaded, network errors) —
 * it never retries 4xx errors like authentication (401) or validation
 * (422), so this satisfies "small bounded retry for transient failures
 * only" without any bespoke retry loop here.
 */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Minimal client surface any Anthropic-backed structured-output provider
 * needs from `@anthropic-ai/sdk`'s Messages resource — lets tests inject a
 * mock instead of the real SDK. Shared by every task-specific Anthropic
 * provider (growth report, experiment decision, ...) so the client shape,
 * error sanitization, and structured-output parsing logic exist in exactly
 * one place.
 */
export interface AnthropicMessagesClient {
  messages: {
    parse(params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: "user"; content: string }[];
      output_config: { format: unknown };
    }): Promise<{
      id: string;
      model: string;
      stop_reason: string | null;
      content: unknown[];
      parsed_output: unknown;
      usage?: { input_tokens?: number; output_tokens?: number };
      _request_id?: string | null;
    }>;
  };
}

/** Constructs the real Anthropic client. Callers should only invoke this lazily, for an actual live request — never at module import time. */
export function createAnthropicClient(apiKey: string, maxRetries: number = DEFAULT_MAX_RETRIES): AnthropicMessagesClient {
  return new Anthropic({ apiKey, maxRetries }) as unknown as AnthropicMessagesClient;
}

export interface RunAnthropicStructuredRequestParams {
  client: AnthropicMessagesClient;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  /** The result of `zodOutputFormat(taskSpecificSchema)`, built once per task at module scope. */
  responseFormat: unknown;
  /** Overrides the default max_tokens-truncation message with a task-specific one (e.g. naming the right env var). */
  truncatedMessage?: string;
}

/**
 * Sends one structured-output request to Anthropic and validates the
 * response: rejects refusals, truncation, empty content, and missing
 * parsed output, then extracts only safe metadata. Shared by every
 * Anthropic-backed provider so this logic (and its test coverage) exists
 * once. Does not use assistant-message prefilling — always exactly one
 * user message.
 */
export async function runAnthropicStructuredRequest<T>(
  params: RunAnthropicStructuredRequestParams
): Promise<LLMStructuredResult<T>> {
  let message: Awaited<ReturnType<AnthropicMessagesClient["messages"]["parse"]>>;
  try {
    message = await params.client.messages.parse({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.systemPrompt,
      messages: [{ role: "user", content: params.userPrompt }],
      output_config: { format: params.responseFormat },
    });
  } catch (err) {
    throw mapAnthropicError(err);
  }

  if (message.stop_reason === "refusal") {
    throw new LLMProviderResponseError("Anthropic refused to generate a structured response for this request.", "refusal");
  }
  if (message.stop_reason === "max_tokens") {
    throw new LLMProviderResponseError(
      params.truncatedMessage ??
        "Anthropic's response was truncated at the max_tokens limit before completing the structured response.",
      "truncated"
    );
  }
  if (!Array.isArray(message.content) || message.content.length === 0) {
    throw new LLMProviderResponseError("Anthropic returned an empty response with no content.", "empty_content");
  }
  if (message.parsed_output === null || message.parsed_output === undefined) {
    throw new LLMProviderResponseError("Anthropic's response did not include a parsed structured output.", "missing_parsed_output");
  }

  return {
    data: message.parsed_output as T,
    provider: "anthropic",
    model: message.model,
    requestId: message._request_id ?? null,
    stopReason: message.stop_reason,
    inputTokens: message.usage?.input_tokens ?? null,
    outputTokens: message.usage?.output_tokens ?? null,
  };
}

/** Maps SDK errors to LLMProviderResponseError with a safe, actionable message — never echoes the API key or auth headers. */
export function mapAnthropicError(err: unknown): Error {
  if (err instanceof AuthenticationError) {
    return new LLMProviderResponseError("Anthropic rejected the request: authentication failed. Check ANTHROPIC_API_KEY.", "authentication_error");
  }
  if (err instanceof RateLimitError) {
    return new LLMProviderResponseError("Anthropic rate-limited this request. Try again later.", "rate_limited");
  }
  if (err instanceof InternalServerError) {
    return new LLMProviderResponseError("Anthropic's API is temporarily overloaded or unavailable. Try again later.", "overloaded");
  }
  if (err instanceof APIConnectionError) {
    return new LLMProviderResponseError("Could not connect to the Anthropic API.", "api_error");
  }
  if (err instanceof APIError) {
    return new LLMProviderResponseError(`Anthropic API request failed (status ${err.status ?? "unknown"}): ${err.message}`, "api_error");
  }
  if (err instanceof AnthropicError) {
    // Covers "Failed to parse structured output: ..." thrown by the SDK's own parser on schema-invalid JSON.
    return new LLMProviderResponseError(`Anthropic's response could not be parsed against the required schema: ${err.message}`, "missing_parsed_output");
  }
  const reason = err instanceof Error ? err.message : String(err);
  return new LLMProviderResponseError(`Unexpected error calling Anthropic: ${reason}`, "api_error");
}
