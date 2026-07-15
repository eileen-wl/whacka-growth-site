import type { GrowthReportAnalysis, GrowthReportLLMRequest, LLMStructuredResult } from "../types/growth-report";

/**
 * Provider-neutral contract the Growth Report Agent depends on. The agent
 * must never import an SDK (e.g. @anthropic-ai/sdk) directly — only a
 * concrete provider module (anthropic-provider.ts, mock-provider.ts) may.
 */
export interface LLMProvider {
  readonly name: string;
  generateStructuredReport(request: GrowthReportLLMRequest): Promise<LLMStructuredResult<GrowthReportAnalysis>>;
}

/** Provider isn't configured/usable for a live run (missing API key, missing model, unknown provider name). */
export class LLMProviderConfigError extends Error {}

/**
 * A provider call completed (or failed) in a way that can't produce a usable
 * structured report: empty content, refusal, truncation, missing parsed
 * output, or a sanitized API failure. `reason` is a stable machine-readable
 * category; `message` is safe to print (never contains credentials).
 */
export class LLMProviderResponseError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "empty_content"
      | "missing_parsed_output"
      | "refusal"
      | "truncated"
      | "authentication_error"
      | "rate_limited"
      | "overloaded"
      | "api_error"
  ) {
    super(message);
  }
}
