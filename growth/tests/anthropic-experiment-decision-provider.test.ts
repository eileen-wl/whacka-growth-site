import { AuthenticationError, InternalServerError, RateLimitError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it, vi } from "vitest";
import { AnthropicExperimentDecisionProvider } from "../llm/anthropic-experiment-decision-provider";
import { LLMProviderConfigError, LLMProviderResponseError } from "../llm/provider";
import { ExperimentDecisionValidationError, validateDecisionAnalysis } from "../agents/experiment-decision-agent";
import { buildDeferDetailsSchema, buildProceedDetailsSchema, decisionGateSchema } from "../types/experiment-decision";
import { buildReferenceAliasMaps } from "../llm/experiment-decision-reference-aliases";
import type { AnthropicMessagesClient } from "../llm/anthropic-experiment-decision-provider";
import type { ExperimentDecisionLLMRequest } from "../types/experiment-decision";

const FAKE_API_KEY = "sk-ant-test-fake-key-do-not-use-654321";

const REQUEST: ExperimentDecisionLLMRequest = {
  purpose: "purpose",
  language: "en",
  context: {
    period: { start: "2026-07-08", end: "2026-07-14" },
    campaign: { id: "test_campaign", name: "Test Campaign" },
    sourceReportFilename: "growth-report-2026-07-08_to_2026-07-14.json",
    sourceReportSha256: "abc123",
    sourceReportGeneratedAt: "2026-07-15T00:00:00.000Z",
    sourceReportProvider: "anthropic",
    sourceReportModel: "claude-test-model",
    sourceReportIsMock: false,
    metrics: {
      traffic: { overview: { sessions: 100, screenPageViews: 300, engagedSessions: 60, engagementRate: 0.6, activeUsers: null, activeUsersMeasurementNote: "x" }, acquisition: [], landingPages: [], topSources: [], topLandingPages: [] },
      behavior: { eventTotals: { pageViews: 300, viewDemoClicks: 20, remixClicks: 15, buildClicks: 10, copyPromptClicks: 5, totalCtaClicks: 50 }, uniqueUsers: null, uniqueUsersMeasurementNote: "x", byApp: [], byPageType: [], byUtmSource: [], byUtmMedium: [], byUtmCampaign: [], byUtmContent: [] },
      search: { status: "ok", totals: { clicks: 20, impressions: 500, ctr: 0.04, averagePosition: 8.5 }, daily: [], topQueries: [], topPages: [], queryPages: [] },
      productConversions: { signups: null, firstAppCreated: null, appPublished: null, status: "not_connected", note: "x" },
    },
    evidenceCatalog: [{ id: "traffic.sessions", label: "GA4 sessions", value: 100, source: "GA4", measurementBasis: "x" }],
    findingCatalog: [{ id: "finding.finding-app-perf", title: "App performance", observation: "O", interpretation: "I", evidenceRefs: [], confidence: "medium" }],
    limitationCatalog: [{ id: "data_limit.product_conversions_not_connected", title: "T", impact: "I", relatedEvidenceRefs: [] }],
    decisionScope: { availableTopics: ["Orderly"], availableCtaTypes: ["build"], availableChannels: [] },
    dataQualityStatus: "partial",
    dataQualityWarnings: [],
    measurementNotes: [],
  },
  reportingRules: [],
  responseSchemaDescription: "desc",
  maxTokens: 4000,
  systemPrompt: "SYSTEM_PROMPT_TEXT",
  userPrompt: "USER_PROMPT_TEXT",
};

/** REQUEST.context sorts to: evidence "traffic.sessions" -> E001; finding "finding.finding-app-perf" -> F001; limitation "data_limit.product_conversions_not_connected" -> L001. */
const ALIASES = buildReferenceAliasMaps(REQUEST.context);

function stage1Message(decisionStatus: "proceed" | "defer", overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_stage1",
    model: "claude-test-model",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "..." }],
    parsed_output: { decisionStatus, headline: "Headline", rationale: "Rationale", confidence: "low" },
    usage: { input_tokens: 40, output_tokens: 10 },
    _request_id: "req_stage1",
    ...overrides,
  };
}

function proceedDetailsMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_stage2",
    model: "claude-test-model",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "..." }],
    parsed_output: {
      rankedExperimentOptions: [
        {
          id: "experiment_1",
          rank: 1,
          lever: "cta",
          title: "Emphasize build CTA",
          targetTopicOrApp: "Orderly",
          targetCtaType: "build",
          targetChannel: "",
          hypothesis: "A more prominent build CTA increases the event-based CTA rate.",
          proposedChange: "Increase the visual emphasis of the build CTA.",
          controlDescription: "Current CTA presentation, unchanged.",
          variantDescription: "Orderly page with a more prominent build CTA.",
          primaryMetricRef: "E001",
          expectedDirection: "increase",
          successCriterion: "Higher event-based CTA rate than the control.",
          guardrailMetricRefs: [],
          measurementCaveats: [],
          evidenceRefs: ["E001"],
          findingRefs: ["F001"],
          limitationRefs: ["L001"],
          confidence: "low",
          dependencies: [],
          risks: [],
          whyNotHigherRanked: "",
        },
      ],
      recommendedExperimentId: "experiment_1",
      handoffItems: [],
    },
    usage: { input_tokens: 200, output_tokens: 90 },
    _request_id: "req_stage2_proceed",
    ...overrides,
  };
}

function deferDetailsMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_stage2",
    model: "claude-test-model",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "..." }],
    parsed_output: {
      reason: "Not enough evidence.",
      missingEvidence: ["More data."],
      requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: ["E001", "L001"] }],
      earliestDecisionCondition: "Later.",
      handoffItems: [],
    },
    usage: { input_tokens: 150, output_tokens: 60 },
    _request_id: "req_stage2_defer",
    ...overrides,
  };
}

/** A stateful fake client: returns one queued response per `parse()` call, in order. Reuses the last response if called more times than queued (defensive; no test here relies on this). */
function fakeClient(responses: unknown[]): { client: AnthropicMessagesClient; parse: ReturnType<typeof vi.fn> } {
  let call = 0;
  const parse = vi.fn(async () => {
    const response = responses[call] ?? responses[responses.length - 1];
    call++;
    return response;
  });
  return { client: { messages: { parse } } as unknown as AnthropicMessagesClient, parse };
}

describe("AnthropicExperimentDecisionProvider — configuration", () => {
  it("is named 'anthropic'", () => {
    expect(new AnthropicExperimentDecisionProvider({ apiKey: "x", model: "m" }).name).toBe("anthropic");
  });

  it("does not require a real API key or model just to construct", () => {
    expect(() => new AnthropicExperimentDecisionProvider()).not.toThrow();
  });

  it("fails with LLMProviderConfigError only when actually generating, if no API key and no injected client", async () => {
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model" });
    await expect(provider.generateStructuredDecision(REQUEST)).rejects.toThrow(LLMProviderConfigError);
  });

  it("fails with LLMProviderConfigError when no model is configured, even with a client injected", async () => {
    const { client } = fakeClient([stage1Message("defer"), deferDetailsMessage()]);
    const provider = new AnthropicExperimentDecisionProvider({ apiKey: FAKE_API_KEY, client });
    await expect(provider.generateStructuredDecision(REQUEST)).rejects.toThrow(LLMProviderConfigError);
  });

  it("does not require an API key when a client is injected", async () => {
    const { client } = fakeClient([stage1Message("defer"), deferDetailsMessage()]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredDecision(REQUEST)).resolves.toBeDefined();
  });
});

describe("AnthropicExperimentDecisionProvider — two-stage request flow (proceed)", () => {
  it("makes exactly two Anthropic calls", async () => {
    const { client, parse } = fakeClient([stage1Message("proceed"), proceedDetailsMessage()]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await provider.generateStructuredDecision(REQUEST);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("stage 1 uses the decision-gate schema; stage 2 uses the proceed-details schema", async () => {
    const { client, parse } = fakeClient([stage1Message("proceed"), proceedDetailsMessage()]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await provider.generateStructuredDecision(REQUEST);

    const call1 = parse.mock.calls[0][0] as { output_config: { format: { schema: unknown } } };
    const call2 = parse.mock.calls[1][0] as { output_config: { format: { schema: unknown } } };
    // Compare `.schema` only — zodOutputFormat() also returns a fresh `parse` closure per call, which never compares equal by reference.
    expect(call1.output_config.format.schema).toEqual(zodOutputFormat(decisionGateSchema).schema);
    expect(call2.output_config.format.schema).toEqual(zodOutputFormat(buildProceedDetailsSchema(ALIASES)).schema);
  });

  it("stage 2's prompt includes the stage 1 result", async () => {
    const { client, parse } = fakeClient([stage1Message("proceed"), proceedDetailsMessage()]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await provider.generateStructuredDecision(REQUEST);

    const call2 = parse.mock.calls[1][0] as { messages: { content: string }[] };
    expect(call2.messages[0].content).toContain("Headline");
    expect(call2.messages[0].content).toContain('"decisionStatus": "proceed"');
  });

  it("assembles a proceed decision that passes the existing full validator", async () => {
    const { client } = fakeClient([stage1Message("proceed"), proceedDetailsMessage()]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    const result = await provider.generateStructuredDecision(REQUEST);

    expect(() => validateDecisionAnalysis(result.data, REQUEST.context)).not.toThrow();
    expect(result.data.decisionSummary.decisionStatus).toBe("proceed");
    expect(result.data.recommendedExperiment).not.toBeNull();
    expect(result.data.deferDecision).toBeNull();
  });

  it("maps every E/F/L alias in the response back to the original catalog IDs — the final decision never contains an alias", async () => {
    const { client } = fakeClient([stage1Message("proceed"), proceedDetailsMessage()]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    const result = await provider.generateStructuredDecision(REQUEST);

    const option = result.data.rankedExperimentOptions[0];
    expect(option.measurementPlan.primaryMetricRef).toBe("traffic.sessions");
    expect(option.evidenceRefs).toEqual(["traffic.sessions"]);
    expect(option.findingRefs).toEqual(["finding.finding-app-perf"]);
    expect(option.limitationRefs).toEqual(["data_limit.product_conversions_not_connected"]);
    expect(result.data.recommendedExperiment?.evidenceRefs).toEqual(["traffic.sessions"]);

    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain("E001");
    expect(serialized).not.toContain("F001");
    expect(serialized).not.toContain("L001");
  });

  it("rejects an invented evidence alias instead of writing a partial decision", async () => {
    const { client, parse } = fakeClient([
      stage1Message("proceed"),
      proceedDetailsMessage({
        parsed_output: {
          ...proceedDetailsMessage().parsed_output,
          rankedExperimentOptions: [{ ...proceedDetailsMessage().parsed_output.rankedExperimentOptions[0], evidenceRefs: ["E999"] }],
        },
      }),
    ]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredDecision(REQUEST)).rejects.toThrow(/unknown evidence alias "E999"/);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("sums input/output tokens across both stages", async () => {
    const { client } = fakeClient([stage1Message("proceed"), proceedDetailsMessage()]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    const result = await provider.generateStructuredDecision(REQUEST);
    expect(result.inputTokens).toBe(40 + 200);
    expect(result.outputTokens).toBe(10 + 90);
  });

  it("reports safe metadata from stage 2 (provider/model/requestId/stopReason)", async () => {
    const { client } = fakeClient([stage1Message("proceed"), proceedDetailsMessage()]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    const result = await provider.generateStructuredDecision(REQUEST);
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-test-model");
    expect(result.requestId).toBe("req_stage2_proceed");
    expect(result.stopReason).toBe("end_turn");
  });
});

describe("AnthropicExperimentDecisionProvider — two-stage request flow (defer)", () => {
  it("makes exactly two Anthropic calls", async () => {
    const { client, parse } = fakeClient([stage1Message("defer"), deferDetailsMessage()]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await provider.generateStructuredDecision(REQUEST);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("stage 2 uses the defer-details schema", async () => {
    const { client, parse } = fakeClient([stage1Message("defer"), deferDetailsMessage()]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await provider.generateStructuredDecision(REQUEST);

    const call2 = parse.mock.calls[1][0] as { output_config: { format: { schema: unknown } } };
    expect(call2.output_config.format.schema).toEqual(zodOutputFormat(buildDeferDetailsSchema(ALIASES)).schema);
  });

  it("assembles a defer decision that passes the existing full validator", async () => {
    const { client } = fakeClient([stage1Message("defer"), deferDetailsMessage()]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    const result = await provider.generateStructuredDecision(REQUEST);

    expect(() => validateDecisionAnalysis(result.data, REQUEST.context)).not.toThrow();
    expect(result.data.decisionSummary.decisionStatus).toBe("defer");
    expect(result.data.recommendedExperiment).toBeNull();
    expect(result.data.deferDecision).not.toBeNull();
    expect(result.data.rankedExperimentOptions).toEqual([]);
  });

  it("maps only E/L aliases back to original IDs — never a fuzzy match, never an alias left in the final decision", async () => {
    const { client } = fakeClient([stage1Message("defer"), deferDetailsMessage()]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    const result = await provider.generateStructuredDecision(REQUEST);

    expect(result.data.deferDecision?.requiredNextObservations[0].relatedEvidenceOrLimitationRefs).toEqual([
      "traffic.sessions",
      "data_limit.product_conversions_not_connected",
    ]);
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain("E001");
    expect(serialized).not.toContain("L001");
  });

  it("rejects a finding (F) alias placed in relatedEvidenceOrLimitationRefs instead of writing a partial decision", async () => {
    const { client, parse } = fakeClient([
      stage1Message("defer"),
      deferDetailsMessage({
        parsed_output: {
          ...deferDetailsMessage().parsed_output,
          requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: ["F001"] }],
        },
      }),
    ]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredDecision(REQUEST)).rejects.toThrow(/finding \(F###\) aliases are not valid/);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("rejects an invented alias rather than writing a partial decision (Stage 2 failure writes no output)", async () => {
    const { client } = fakeClient([
      stage1Message("defer"),
      deferDetailsMessage({
        parsed_output: {
          ...deferDetailsMessage().parsed_output,
          requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: ["L999"] }],
        },
      }),
    ]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredDecision(REQUEST)).rejects.toThrow(ExperimentDecisionValidationError);
    await expect(provider.generateStructuredDecision(REQUEST)).rejects.toThrow(/unknown limitation alias "L999"/);
  });

  it("sums input/output tokens across both stages", async () => {
    const { client } = fakeClient([stage1Message("defer"), deferDetailsMessage()]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    const result = await provider.generateStructuredDecision(REQUEST);
    expect(result.inputTokens).toBe(40 + 150);
    expect(result.outputTokens).toBe(10 + 60);
  });
});

describe("AnthropicExperimentDecisionProvider — stage failure behavior", () => {
  it("rejects and never calls stage 2 when stage 1 fails", async () => {
    const { client, parse } = fakeClient([]);
    parse.mockRejectedValueOnce(new Error("boom"));
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredDecision(REQUEST)).rejects.toThrow();
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("clearly identifies stage 1 in a sanitized error message", async () => {
    const { client } = fakeClient([stage1Message("proceed", { content: [] })]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredDecision(REQUEST)).rejects.toMatchObject({
      reason: "empty_content",
      message: expect.stringContaining("Stage 1 (decision gate)"),
    });
  });

  it("clearly identifies stage 2 (proceed details) in a sanitized error message, without a partial result", async () => {
    const { client, parse } = fakeClient([stage1Message("proceed"), proceedDetailsMessage({ content: [] })]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredDecision(REQUEST)).rejects.toMatchObject({
      reason: "empty_content",
      message: expect.stringContaining("Stage 2 (proceed details)"),
    });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("clearly identifies stage 2 (defer details) in a sanitized error message", async () => {
    const { client } = fakeClient([stage1Message("defer"), deferDetailsMessage({ stop_reason: "max_tokens" })]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredDecision(REQUEST)).rejects.toMatchObject({
      reason: "truncated",
      message: expect.stringContaining("Stage 2 (defer details)"),
    });
  });

  it("rejects a stage 1 refusal", async () => {
    const { client } = fakeClient([stage1Message("proceed", { stop_reason: "refusal" })]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredDecision(REQUEST)).rejects.toMatchObject({ reason: "refusal" });
  });

  it("rejects when stage 2 (proceed) recommends an experiment id that does not match any produced option", async () => {
    const { client } = fakeClient([
      stage1Message("proceed"),
      proceedDetailsMessage({ parsed_output: { ...proceedDetailsMessage().parsed_output, recommendedExperimentId: "does_not_exist" } }),
    ]);
    const provider = new AnthropicExperimentDecisionProvider({ model: "claude-test-model", client });
    await expect(provider.generateStructuredDecision(REQUEST)).rejects.toThrow(/does not match any rankedExperimentOptions id/);
  });
});

describe("AnthropicExperimentDecisionProvider — API error sanitization", () => {
  it("sanitizes an authentication error on stage 1", async () => {
    const client = {
      messages: {
        parse: vi.fn(async () => {
          throw new AuthenticationError(401, { type: "authentication_error", message: "invalid x-api-key" }, "invalid x-api-key", new Headers());
        }),
      },
    } as unknown as AnthropicMessagesClient;
    const provider = new AnthropicExperimentDecisionProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });

    try {
      await provider.generateStructuredDecision(REQUEST);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderResponseError);
      expect((err as LLMProviderResponseError).reason).toBe("authentication_error");
      expect((err as Error).message).not.toContain(FAKE_API_KEY);
    }
  });

  it("sanitizes a rate-limit error", async () => {
    const client = { messages: { parse: vi.fn(async () => { throw new RateLimitError(429, { type: "rate_limit_error", message: "rate limited" }, "rate limited", new Headers()); }) } } as unknown as AnthropicMessagesClient;
    const provider = new AnthropicExperimentDecisionProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });
    await expect(provider.generateStructuredDecision(REQUEST)).rejects.toMatchObject({ reason: "rate_limited" });
  });

  it("sanitizes an overloaded/internal-server error", async () => {
    const client = { messages: { parse: vi.fn(async () => { throw new InternalServerError(529, { type: "overloaded_error", message: "overloaded" }, "overloaded", new Headers()); }) } } as unknown as AnthropicMessagesClient;
    const provider = new AnthropicExperimentDecisionProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });
    await expect(provider.generateStructuredDecision(REQUEST)).rejects.toMatchObject({ reason: "overloaded" });
  });

  it("never lets the configured API key appear in any thrown error message", async () => {
    const client = {
      messages: {
        parse: vi.fn(async () => {
          throw new AuthenticationError(401, { type: "authentication_error", message: "invalid x-api-key" }, "invalid x-api-key", new Headers());
        }),
      },
    } as unknown as AnthropicMessagesClient;
    const provider = new AnthropicExperimentDecisionProvider({ apiKey: FAKE_API_KEY, model: "claude-test-model", client });

    try {
      await provider.generateStructuredDecision(REQUEST);
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(FAKE_API_KEY);
      expect(message.toLowerCase()).not.toContain("bearer");
    }
  });
});

// ---------------------------------------------------------------------------
// Schema shape assertions — the whole point of the two-stage split is to
// keep each Anthropic structured-output grammar small. These check the
// *schemas themselves* (not runtime data): no optional properties, no
// nullable/anyOf fields, and no cross-contamination between the proceed
// and defer branches.
// ---------------------------------------------------------------------------

interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  anyOf?: unknown[];
}

function collectAnyOfPaths(node: JsonSchemaNode | undefined, path = "root"): string[] {
  if (!node || typeof node !== "object") return [];
  const found: string[] = [];
  if (node.anyOf) found.push(path);
  if (node.properties) {
    for (const [key, value] of Object.entries(node.properties)) {
      found.push(...collectAnyOfPaths(value, `${path}.${key}`));
    }
  }
  if (node.items) found.push(...collectAnyOfPaths(node.items, `${path}[]`));
  return found;
}

function collectNotFullyRequiredPaths(node: JsonSchemaNode | undefined, path = "root"): string[] {
  if (!node || typeof node !== "object") return [];
  const found: string[] = [];
  if (node.type === "object" && node.properties) {
    const keys = Object.keys(node.properties);
    const required = node.required ?? [];
    const missing = keys.filter((k) => !required.includes(k));
    if (missing.length > 0) found.push(`${path} missing [${missing.join(",")}] from required`);
    for (const [key, value] of Object.entries(node.properties)) {
      found.push(...collectNotFullyRequiredPaths(value, `${path}.${key}`));
    }
  }
  if (node.type === "array" && node.items) {
    found.push(...collectNotFullyRequiredPaths(node.items, `${path}[]`));
  }
  return found;
}

describe("Two-stage provider-facing schemas — structural constraints", () => {
  const schemas: [string, unknown][] = [
    ["decisionGateSchema", decisionGateSchema],
    ["buildProceedDetailsSchema(ALIASES)", buildProceedDetailsSchema(ALIASES)],
    ["buildDeferDetailsSchema(ALIASES)", buildDeferDetailsSchema(ALIASES)],
  ];

  for (const [name, schema] of schemas) {
    it(`${name} has every property required (no optional fields)`, () => {
      const fmt = zodOutputFormat(schema as Parameters<typeof zodOutputFormat>[0]) as { schema: JsonSchemaNode };
      expect(collectNotFullyRequiredPaths(fmt.schema)).toEqual([]);
    });

    it(`${name} contains no anyOf/nullable fields`, () => {
      const fmt = zodOutputFormat(schema as Parameters<typeof zodOutputFormat>[0]) as { schema: JsonSchemaNode };
      expect(collectAnyOfPaths(fmt.schema)).toEqual([]);
    });
  }

  it("buildProceedDetailsSchema(ALIASES) does not include defer-only fields", () => {
    const fmt = zodOutputFormat(buildProceedDetailsSchema(ALIASES)) as { schema: JsonSchemaNode };
    const keys = Object.keys(fmt.schema.properties ?? {});
    for (const deferOnlyField of ["deferDecision", "reason", "missingEvidence", "requiredNextObservations", "earliestDecisionCondition"]) {
      expect(keys).not.toContain(deferOnlyField);
    }
  });

  it("buildDeferDetailsSchema(ALIASES) does not include proceed-only fields", () => {
    const fmt = zodOutputFormat(buildDeferDetailsSchema(ALIASES)) as { schema: JsonSchemaNode };
    const keys = Object.keys(fmt.schema.properties ?? {});
    for (const proceedOnlyField of ["rankedExperimentOptions", "recommendedExperimentId", "recommendedExperiment"]) {
      expect(keys).not.toContain(proceedOnlyField);
    }
  });

  it("decisionGateSchema has no nested objects beyond the top level", () => {
    const fmt = zodOutputFormat(decisionGateSchema) as { schema: JsonSchemaNode };
    for (const value of Object.values(fmt.schema.properties ?? {})) {
      expect(value.type).not.toBe("object");
      expect(value.type).not.toBe("array");
    }
  });

  it("uses compact aliases (E###/F###/L###) in the enum description, never the original catalog id", () => {
    const fmt = zodOutputFormat(buildProceedDetailsSchema(ALIASES)) as { schema: JsonSchemaNode };
    const serialized = JSON.stringify(fmt.schema);
    expect(serialized).toContain("E001");
    expect(serialized).toContain("F001");
    expect(serialized).toContain("L001");
    expect(serialized).not.toContain("traffic.sessions");
    expect(serialized).not.toContain("finding.finding-app-perf");
    expect(serialized).not.toContain("data_limit.product_conversions_not_connected");
  });
});
