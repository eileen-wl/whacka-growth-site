import type { LLMStructuredResult } from "../types/llm";
import type { ExperimentDecisionAnalysis, ExperimentDecisionLLMRequest } from "../types/experiment-decision";

export { LLMProviderConfigError, LLMProviderResponseError } from "./provider";

/**
 * Provider-neutral contract the Experiment Decision Agent depends on. The
 * agent must never import an SDK (e.g. @anthropic-ai/sdk) directly — only a
 * concrete provider module (anthropic-experiment-decision-provider.ts,
 * mock-experiment-decision-provider.ts) may.
 */
export interface ExperimentDecisionProvider {
  readonly name: string;
  generateStructuredDecision(request: ExperimentDecisionLLMRequest): Promise<LLMStructuredResult<ExperimentDecisionAnalysis>>;
}
