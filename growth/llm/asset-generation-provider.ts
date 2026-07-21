import type { LLMStructuredResult } from "../types/llm";
import type { AssetGenerationAnalysis, AssetGenerationLLMRequest } from "../types/asset-generation";

export { LLMProviderConfigError, LLMProviderResponseError } from "./provider";

/**
 * Provider-neutral contract the Asset Generation Agent depends on. The agent
 * must never import an SDK (e.g. @anthropic-ai/sdk) directly — only a
 * concrete provider module (anthropic-asset-generation-provider.ts,
 * mock-asset-generation-provider.ts) may.
 */
export interface AssetGenerationProvider {
  readonly name: string;
  generateStructuredAssets(request: AssetGenerationLLMRequest): Promise<LLMStructuredResult<AssetGenerationAnalysis>>;
}
