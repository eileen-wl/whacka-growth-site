import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createAnthropicClient, runAnthropicStructuredRequest } from "./anthropic-structured-client";
import {
  buildStage1SystemPrompt,
  buildStage1UserPrompt,
  buildStage2DeferSystemPrompt,
  buildStage2DeferUserPrompt,
  buildStage2ProceedSystemPrompt,
  buildStage2ProceedUserPrompt,
} from "../prompts/experiment-decision-prompt";
import { assembleDeferAnalysis, assembleProceedAnalysis } from "./experiment-decision-assembly";
import { buildReferenceAliasMaps, resolveDeferDetailsAliases, resolveProceedDetailsAliases } from "./experiment-decision-reference-aliases";
import { buildDeferDetailsSchema, buildProceedDetailsSchema, decisionGateSchema } from "../types/experiment-decision";
import { LLMProviderConfigError, LLMProviderResponseError } from "./provider";
import type { AnthropicMessagesClient } from "./anthropic-structured-client";
import type { ExperimentDecisionProvider } from "./experiment-decision-provider";
import type {
  DecisionGate,
  DeferDetails,
  ExperimentDecisionAnalysis,
  ExperimentDecisionLLMRequest,
  ProceedDetails,
} from "../types/experiment-decision";
import type { LLMStructuredResult } from "../types/llm";

export type { AnthropicMessagesClient } from "./anthropic-structured-client";

/**
 * Live Anthropic generation, in two structured-output calls instead of
 * one. The original single-call `experimentDecisionAnalysisSchema` (see
 * growth/types/experiment-decision.ts) is too complex to compile as one
 * Anthropic structured-output grammar — Anthropic rejects it with "The
 * compiled grammar is too large, which would cause performance issues."
 * Growth Report live generation is unaffected: it uses its own, simpler
 * schema and already works with claude-opus-4-8.
 *
 * Stage 1 (decisionGateSchema) always runs first and decides proceed vs.
 * defer. Stage 2 (built per request by `buildProceedDetailsSchema` or
 * `buildDeferDetailsSchema`, from that request's own deterministic
 * evidence/finding/limitation aliases — see growth/llm/experiment-
 * decision-reference-aliases.ts) runs next, whichever branch stage 1
 * selected. Building Stage 2's schema per request (rather than once,
 * statically) is what lets the model select ONLY an alias that actually
 * exists for this decision — a live run previously had the model invent
 * human-readable finding IDs that were never in the catalog, since a
 * generic `refId` string field can't be enum-constrained. After Stage 2
 * responds, its aliases are resolved back to the exact original catalog
 * IDs before assembly — growth/llm/experiment-decision-assembly.ts
 * deterministically combines both stages' (now alias-free) output into a
 * full ExperimentDecisionAnalysis-shaped object — the SAME shape the
 * single-call path always produced — which the caller (growth/agents/
 * experiment-decision-agent.ts's `validateDecisionAnalysis`) validates
 * exactly as before. The Mock Provider is untouched: it never calls
 * Anthropic, so it never hit either the grammar-size limit or the invented-
 * ID problem, and still returns a full decision in one in-process call.
 */

/** Built once: translating decisionGateSchema to a JSON schema is pure and doesn't depend on any live credentials or request-specific aliases (Stage 1 has no reference fields). */
const STAGE1_RESPONSE_FORMAT = zodOutputFormat(decisionGateSchema);

export interface AnthropicExperimentDecisionProviderOptions {
  /** Resolved from EXPERIMENT_DECISION_MODEL -> GROWTH_REPORT_MODEL by the caller (script) — never read directly from process.env in here. */
  apiKey?: string;
  model?: string;
  /** Injectable for tests — when set, the real SDK client is never constructed. */
  client?: AnthropicMessagesClient;
}

/** Re-throws an LLMProviderResponseError with the same `reason` but a stage-labeled message, so a sanitized error always says which of the two calls failed. Any other error (e.g. a config error) passes through unchanged. */
function rethrowWithStage(err: unknown, stageLabel: string): never {
  if (err instanceof LLMProviderResponseError) {
    throw new LLMProviderResponseError(`${stageLabel} failed: ${err.message}`, err.reason);
  }
  throw err;
}

function combineResults<T>(stage1: LLMStructuredResult<unknown>, stage2: LLMStructuredResult<unknown>, data: T): LLMStructuredResult<T> {
  return {
    data,
    provider: "anthropic",
    // Model/requestId/stopReason are reported from stage 2 — the call that produced the bulk of the content and the last one to run.
    model: stage2.model,
    requestId: stage2.requestId,
    stopReason: stage2.stopReason,
    inputTokens: (stage1.inputTokens ?? 0) + (stage2.inputTokens ?? 0),
    outputTokens: (stage1.outputTokens ?? 0) + (stage2.outputTokens ?? 0),
  };
}

export class AnthropicExperimentDecisionProvider implements ExperimentDecisionProvider {
  readonly name = "anthropic";

  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  private readonly injectedClient: AnthropicMessagesClient | undefined;
  private lazyClient: AnthropicMessagesClient | undefined;

  constructor(options: AnthropicExperimentDecisionProviderOptions = {}) {
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

  async generateStructuredDecision(request: ExperimentDecisionLLMRequest): Promise<LLMStructuredResult<ExperimentDecisionAnalysis>> {
    if (!this.model) {
      throw new LLMProviderConfigError(
        "No Anthropic model resolved (checked EXPERIMENT_DECISION_MODEL, then GROWTH_REPORT_MODEL). Set one in .env once a model is confirmed."
      );
    }

    const client = this.getClient();
    const { context } = request;
    const aliases = buildReferenceAliasMaps(context);

    let stage1: LLMStructuredResult<DecisionGate>;
    try {
      stage1 = await runAnthropicStructuredRequest<DecisionGate>({
        client,
        model: this.model,
        systemPrompt: buildStage1SystemPrompt(request.language),
        userPrompt: buildStage1UserPrompt(context),
        maxTokens: request.maxTokens,
        responseFormat: STAGE1_RESPONSE_FORMAT,
        truncatedMessage:
          "Anthropic's stage 1 (decision gate) response was truncated at the max_tokens limit. Increase EXPERIMENT_DECISION_MAX_TOKENS.",
      });
    } catch (err) {
      rethrowWithStage(err, "Stage 1 (decision gate)");
    }

    if (stage1.data.decisionStatus === "proceed") {
      let stage2: LLMStructuredResult<ProceedDetails>;
      try {
        stage2 = await runAnthropicStructuredRequest<ProceedDetails>({
          client,
          model: this.model,
          systemPrompt: buildStage2ProceedSystemPrompt(request.language),
          userPrompt: buildStage2ProceedUserPrompt(context, stage1.data, aliases),
          maxTokens: request.maxTokens,
          responseFormat: zodOutputFormat(buildProceedDetailsSchema(aliases)),
          truncatedMessage:
            "Anthropic's stage 2 (proceed details) response was truncated at the max_tokens limit. Increase EXPERIMENT_DECISION_MAX_TOKENS.",
        });
      } catch (err) {
        rethrowWithStage(err, "Stage 2 (proceed details)");
      }

      const resolved = resolveProceedDetailsAliases(stage2.data, aliases);
      const data = assembleProceedAnalysis(stage1.data, resolved);
      return combineResults(stage1, stage2, data);
    }

    let stage2: LLMStructuredResult<DeferDetails>;
    try {
      stage2 = await runAnthropicStructuredRequest<DeferDetails>({
        client,
        model: this.model,
        systemPrompt: buildStage2DeferSystemPrompt(request.language),
        userPrompt: buildStage2DeferUserPrompt(context, stage1.data, aliases),
        maxTokens: request.maxTokens,
        responseFormat: zodOutputFormat(buildDeferDetailsSchema(aliases)),
        truncatedMessage:
          "Anthropic's stage 2 (defer details) response was truncated at the max_tokens limit. Increase EXPERIMENT_DECISION_MAX_TOKENS.",
      });
    } catch (err) {
      rethrowWithStage(err, "Stage 2 (defer details)");
    }

    const resolved = resolveDeferDetailsAliases(stage2.data, aliases);
    const data = assembleDeferAnalysis(stage1.data, resolved);
    return combineResults(stage1, stage2, data);
  }
}
