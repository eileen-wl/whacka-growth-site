import Anthropic, {
  AnthropicError,
  APIConnectionError,
  APIError,
  AuthenticationError,
  InternalServerError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { growthReportAnalysisSchema } from "../types/growth-report";
import { LLMProviderConfigError, LLMProviderResponseError } from "./provider";
import type { LLMProvider } from "./provider";
import type { GrowthReportAnalysis, GrowthReportLLMRequest, LLMStructuredResult } from "../types/growth-report";

/**
 * Conservative, SDK-managed retry count. The SDK only retries explicitly
 * transient failures (429 rate limits, 5xx/overloaded, network errors) —
 * it never retries 4xx errors like authentication (401) or validation
 * (422), so this satisfies "small bounded retry for transient failures
 * only" without any bespoke retry loop here.
 */
const DEFAULT_MAX_RETRIES = 2;

/** Built once: translating the zod schema to a JSON schema is pure and doesn't depend on any live credentials. */
const RESPONSE_FORMAT = zodOutputFormat(growthReportAnalysisSchema);

/** Minimal client surface this provider needs from `@anthropic-ai/sdk`'s Messages resource — lets tests inject a mock instead of the real SDK. */
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

export interface AnthropicProviderOptions {
  /** Read from ANTHROPIC_API_KEY by the caller (script) — never read directly from process.env in here. */
  apiKey?: string;
  /** Read from GROWTH_REPORT_MODEL by the caller. */
  model?: string;
  /** Injectable for tests — when set, the real SDK client is never constructed. */
  client?: AnthropicMessagesClient;
}

export class AnthropicGrowthReportProvider implements LLMProvider {
  readonly name = "anthropic";

  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  private readonly injectedClient: AnthropicMessagesClient | undefined;
  private lazyClient: AnthropicMessagesClient | undefined;

  constructor(options: AnthropicProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.injectedClient = options.client;
  }

  /** Constructs the real Anthropic client only when actually needed for a live call — never at import or construction time. */
  private getClient(): AnthropicMessagesClient {
    if (this.injectedClient) return this.injectedClient;

    if (!this.apiKey) {
      throw new LLMProviderConfigError(
        "ANTHROPIC_API_KEY is required to run the Anthropic provider live. Set it in .env, or use --provider mock / --dry-run instead."
      );
    }

    if (!this.lazyClient) {
      this.lazyClient = new Anthropic({ apiKey: this.apiKey, maxRetries: DEFAULT_MAX_RETRIES }) as unknown as AnthropicMessagesClient;
    }
    return this.lazyClient;
  }

  async generateStructuredReport(request: GrowthReportLLMRequest): Promise<LLMStructuredResult<GrowthReportAnalysis>> {
    if (!this.model) {
      throw new LLMProviderConfigError(
        "GROWTH_REPORT_MODEL is required to run the Anthropic provider live. Set it in .env once the model is confirmed."
      );
    }

    const client = this.getClient();
    const model = this.model;

    let message: Awaited<ReturnType<AnthropicMessagesClient["messages"]["parse"]>>;
    try {
      message = await client.messages.parse({
        model,
        max_tokens: request.maxTokens,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.userPrompt }],
        output_config: { format: RESPONSE_FORMAT },
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }

    if (message.stop_reason === "refusal") {
      throw new LLMProviderResponseError("Anthropic refused to generate a structured report for this request.", "refusal");
    }
    if (message.stop_reason === "max_tokens") {
      throw new LLMProviderResponseError(
        "Anthropic's response was truncated at the max_tokens limit before completing the structured report. Increase GROWTH_REPORT_MAX_TOKENS.",
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
      data: message.parsed_output as GrowthReportAnalysis,
      provider: this.name,
      model: message.model,
      requestId: message._request_id ?? null,
      stopReason: message.stop_reason,
      inputTokens: message.usage?.input_tokens ?? null,
      outputTokens: message.usage?.output_tokens ?? null,
    };
  }
}

/** Maps SDK errors to LLMProviderResponseError with a safe, actionable message — never echoes the API key or auth headers. */
function mapAnthropicError(err: unknown): Error {
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
