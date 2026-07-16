import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createAnthropicClient, runAnthropicStructuredRequest } from "./anthropic-structured-client";
import { growthReportAnalysisSchema } from "../types/growth-report";
import { LLMProviderConfigError } from "./provider";
import type { AnthropicMessagesClient } from "./anthropic-structured-client";
import type { LLMProvider } from "./provider";
import type { GrowthReportAnalysis, GrowthReportLLMRequest, LLMStructuredResult } from "../types/growth-report";

export type { AnthropicMessagesClient } from "./anthropic-structured-client";

/** Built once: translating the zod schema to a JSON schema is pure and doesn't depend on any live credentials. */
const RESPONSE_FORMAT = zodOutputFormat(growthReportAnalysisSchema);

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
      this.lazyClient = createAnthropicClient(this.apiKey);
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

    return runAnthropicStructuredRequest<GrowthReportAnalysis>({
      client,
      model: this.model,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      maxTokens: request.maxTokens,
      responseFormat: RESPONSE_FORMAT,
      truncatedMessage:
        "Anthropic's response was truncated at the max_tokens limit before completing the structured report. Increase GROWTH_REPORT_MAX_TOKENS.",
    });
  }
}
