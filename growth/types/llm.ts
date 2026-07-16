/** Task-neutral LLM types shared by every growth agent (Growth Report, Experiment Decision, ...). */

export type SupportedLanguage = "en" | "zh-CN";

/** A provider's result, with only non-sensitive metadata preserved (never credentials/tokens/headers). */
export interface LLMStructuredResult<T> {
  data: T;
  provider: string;
  model: string;
  requestId: string | null;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}
