import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createAnthropicClient, runAnthropicStructuredRequest } from "./anthropic-structured-client";
import { signalMiningAnalysisSchema } from "../types/signal-mining";
import { LLMProviderConfigError } from "./provider";
import type { AnthropicMessagesClient } from "./anthropic-structured-client";
import type { SignalMiningProvider } from "./signal-mining-provider";
import type { SignalMiningAnalysis, SignalMiningLLMRequest } from "../types/signal-mining";
import type { LLMStructuredResult } from "../types/llm";

export type { AnthropicMessagesClient } from "./anthropic-structured-client";

/** Built once: translating the zod schema to a JSON schema is pure and doesn't depend on any live credentials. */
const RESPONSE_FORMAT = zodOutputFormat(signalMiningAnalysisSchema);

export interface AnthropicSignalMiningProviderOptions {
  /** Resolved from SIGNAL_MINING_MODEL -> GROWTH_REPORT_MODEL by the caller (script) — never read directly from process.env in here. */
  apiKey?: string;
  model?: string;
  /** Injectable for tests — when set, the real SDK client is never constructed. */
  client?: AnthropicMessagesClient;
}

export class AnthropicSignalMiningProvider implements SignalMiningProvider {
  readonly name = "anthropic";

  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  private readonly injectedClient: AnthropicMessagesClient | undefined;
  private lazyClient: AnthropicMessagesClient | undefined;

  constructor(options: AnthropicSignalMiningProviderOptions = {}) {
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

  async generateStructuredSignals(request: SignalMiningLLMRequest): Promise<LLMStructuredResult<SignalMiningAnalysis>> {
    if (!this.model) {
      throw new LLMProviderConfigError(
        "No Anthropic model resolved (checked SIGNAL_MINING_MODEL, then GROWTH_REPORT_MODEL). Set one in .env once a model is confirmed."
      );
    }

    const client = this.getClient();

    return runAnthropicStructuredRequest<SignalMiningAnalysis>({
      client,
      model: this.model,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      maxTokens: request.maxTokens,
      responseFormat: RESPONSE_FORMAT,
      truncatedMessage:
        "Anthropic's response was truncated at the max_tokens limit before completing the structured signal-mining response. Increase SIGNAL_MINING_MAX_TOKENS.",
    });
  }
}
