import type { LLMStructuredResult } from "../types/llm";
import type { SignalMiningAnalysis, SignalMiningLLMRequest } from "../types/signal-mining";

export { LLMProviderConfigError, LLMProviderResponseError } from "./provider";

/**
 * Provider-neutral contract the Signal Mining Agent depends on. The agent
 * must never import an SDK (e.g. @anthropic-ai/sdk) directly — only a
 * concrete provider module (anthropic-signal-mining-provider.ts,
 * mock-signal-mining-provider.ts) may.
 */
export interface SignalMiningProvider {
  readonly name: string;
  generateStructuredSignals(request: SignalMiningLLMRequest): Promise<LLMStructuredResult<SignalMiningAnalysis>>;
}
