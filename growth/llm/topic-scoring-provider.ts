import type { LLMStructuredResult } from "../types/llm";
import type { TopicScoringAnalysis, TopicScoringLLMRequest } from "../types/topic-scoring";

export { LLMProviderConfigError, LLMProviderResponseError } from "./provider";

/**
 * Provider-neutral contract the Topic Scoring Agent depends on. The agent
 * must never import an SDK (e.g. @anthropic-ai/sdk) directly — only a
 * concrete provider module (anthropic-topic-scoring-provider.ts,
 * mock-topic-scoring-provider.ts) may.
 */
export interface TopicScoringProvider {
  readonly name: string;
  generateStructuredScores(request: TopicScoringLLMRequest): Promise<LLMStructuredResult<TopicScoringAnalysis>>;
}
