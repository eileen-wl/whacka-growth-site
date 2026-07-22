import { describe, expect, it } from "vitest";
import { REPORTING_RULES, buildAssetGenerationLLMRequest, buildReportingRules, buildSystemPrompt, buildUserPrompt } from "../prompts/asset-generation-prompt";
import type { AssetGenerationContext } from "../types/asset-generation";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureContext(overrides: Partial<AssetGenerationContext> = {}): AssetGenerationContext {
  return {
    period: PERIOD,
    campaign: CAMPAIGN,
    topicId: "topic_abc",
    scoredTopicId: "scoredtopic_abc",
    canonicalName: "Inventory Tracker",
    slug: "inventory-tracker",
    problemStatement: "Small shops lose track of stock.",
    targetAudience: "Small retail shop owners",
    useCases: ["Track stock counts"],
    desiredOutcome: "Fewer stockouts.",
    rank: 1,
    candidateCount: 3,
    totalScore: 72,
    recommendation: "advance",
    confidence: "high",
    dimensions: [],
    blockers: [],
    relationshipToExistingContent: { status: "new", relatedAppSlugs: [], relatedTopicIds: [] },
    sourceScoringIsMock: false,
    sourceTopicsHumanReviewed: true,
    dataQualityWarnings: [],
    dataQualityLimitations: [],
    language: "en",
    allowedCtaTypes: ["view_demo", "remix", "build", "copy_prompt"],
    requestedSocialChannels: [],
    existingAppCatalog: [{ name: "Orderly", slug: "orderly", hook: "Order tracker", status: "unknown" }],
    cmsFieldRequirements: ["app.name is required."],
    ...overrides,
  };
}

describe("REPORTING_RULES", () => {
  it("prohibits web research, invented market data, URLs in content, and CMS/publication actions", () => {
    const joined = REPORTING_RULES.join(" ").toLowerCase();
    expect(joined).toContain("must not browse the web");
    expect(joined).toContain("must not invent measured search volume");
    expect(joined).toContain("must not put any url in generated prose");
    expect(joined).toContain("cms");
    expect(joined).toContain("publication field");
  });

  it("forbids choosing a different topic, scoring, or ranking", () => {
    const joined = REPORTING_RULES.join(" ").toLowerCase();
    expect(joined).toContain("must not choose a different topic, change any score, rank topics");
  });

  it("requires social posts only for requested channels and zero when none requested", () => {
    const joined = REPORTING_RULES.join(" ").toLowerCase();
    expect(joined).toContain("only for the explicitly supplied requested social channels");
    expect(joined).toContain("produce zero social posts when zero channels were requested");
  });

  it("requires selecting primaryType only from allowed CTA types", () => {
    const joined = REPORTING_RULES.join(" ").toLowerCase();
    expect(joined).toContain("primarytype only from the supplied allowed cta types");
  });

  it("requires evidence grounding — never a count described as a rate without a valid denominator, never engagement volume converted into validated demand", () => {
    const joined = REPORTING_RULES.join(" ").toLowerCase();
    expect(joined).toContain("must never describe a count");
    expect(joined).toContain("rate requires a valid denominator");
    expect(joined).toContain("must not convert engagement volume into a claim of validated demand");
  });

  it("requires preserving every limitation about missing evidence (pageviews, unique users, product outcomes)", () => {
    const joined = REPORTING_RULES.join(" ").toLowerCase();
    expect(joined).toContain("missing pageviews");
    expect(joined).toContain("missing unique-user counts");
    expect(joined).toContain("missing connected product outcomes");
  });

  it("gives a target length for SEO title and meta description", () => {
    const joined = REPORTING_RULES.join(" ").toLowerCase();
    expect(joined).toContain("seo.title to at most 60 characters");
    expect(joined).toContain("seo.metadescription to at most 160 characters");
  });
});

describe("buildReportingRules / buildSystemPrompt", () => {
  it("appends language instructions", () => {
    expect(buildReportingRules("en").at(-1)).toContain("English (en)");
    expect(buildReportingRules("zh-CN").at(-1)).toContain("Simplified Chinese");
  });

  it("system prompt identifies the model as a growth asset designer", () => {
    expect(buildSystemPrompt("en")).toContain("growth asset designer");
  });

  it("omits integration-test rules by default", () => {
    const rules = buildReportingRules("en");
    expect(rules.some((r) => r.toLowerCase().includes("integration test"))).toBe(false);
  });

  it("adds integration-test rules — engineering purpose, no validated-demand claims, banned phrases, still complete content — when integrationTest is true, without dropping the language instruction as the last rule", () => {
    const rules = buildReportingRules("en", true);
    const joined = rules.join(" ").toLowerCase();
    expect(joined).toContain("engineering integration test");
    expect(joined).toContain("must not claim that demand has been validated");
    expect(joined).toContain("proven demand");
    expect(joined).toContain("validated opportunity");
    expect(joined).toContain("top-performing market");
    expect(joined).toContain("confirmed user need");
    expect(joined).toContain("full app copy and appprompt");
    expect(joined).toContain("preserve every limitation");
    expect(rules.at(-1)).toContain("English (en)");
  });

  it("threads integrationTest into the rendered system prompt", () => {
    const prompt = buildSystemPrompt("en", true);
    expect(prompt.toLowerCase()).toContain("engineering integration test");
    expect(prompt.toLowerCase()).toContain("proven demand");
  });

  it("forbids mentioning the integration test or the source recommendation inside public-facing copy", () => {
    const rules = buildReportingRules("en", true);
    const joined = rules.join(" ").toLowerCase();
    expect(joined).toContain("never mention that this is an engineering integration test");
    expect(joined).toContain("app copy, seo copy, or social copy");
  });

  it("does not add integration-test rules to the system prompt by default", () => {
    expect(buildSystemPrompt("en").toLowerCase()).not.toContain("engineering integration test");
  });
});

describe("buildUserPrompt", () => {
  it("includes the selected topic context, existing app catalog, and CMS field requirements", () => {
    const prompt = buildUserPrompt({
      purpose: "purpose",
      period: PERIOD,
      campaign: CAMPAIGN,
      context: fixtureContext(),
      allowedCtaTypes: ["view_demo", "remix", "build", "copy_prompt"],
      requestedSocialChannels: [],
      responseSchemaDescription: "SCHEMA_DESC",
    });
    expect(prompt).toContain("topic_abc");
    expect(prompt).toContain("Orderly");
    expect(prompt).toContain("app.name is required.");
    expect(prompt).toContain("SCHEMA_DESC");
  });

  it("reflects mock/human-review status and requested channels explicitly", () => {
    const prompt = buildUserPrompt({
      purpose: "purpose",
      period: PERIOD,
      campaign: CAMPAIGN,
      context: fixtureContext({ sourceScoringIsMock: true, sourceTopicsHumanReviewed: false }),
      allowedCtaTypes: ["view_demo", "remix", "build", "copy_prompt"],
      requestedSocialChannels: ["linkedin", "x"],
      responseSchemaDescription: "desc",
    });
    expect(prompt).toContain("mock-generated: true");
    expect(prompt).toContain("human-approved: false");
    expect(prompt).toContain("linkedin, x");
  });

  it("states zero requested channels explicitly", () => {
    const prompt = buildUserPrompt({
      purpose: "purpose",
      period: PERIOD,
      campaign: CAMPAIGN,
      context: fixtureContext(),
      allowedCtaTypes: ["view_demo", "remix", "build", "copy_prompt"],
      requestedSocialChannels: [],
      responseSchemaDescription: "desc",
    });
    expect(prompt).toContain("produce zero social posts");
  });

  it("never includes a credential-shaped value", () => {
    const prompt = buildUserPrompt({
      purpose: "purpose",
      period: PERIOD,
      campaign: CAMPAIGN,
      context: fixtureContext(),
      allowedCtaTypes: ["view_demo", "remix", "build", "copy_prompt"],
      requestedSocialChannels: [],
      responseSchemaDescription: "desc",
    });
    const lower = prompt.toLowerCase();
    expect(lower).not.toContain("api_key");
    expect(lower).not.toContain("sk-ant");
    expect(lower).not.toContain("bearer");
  });
});

describe("buildAssetGenerationLLMRequest", () => {
  it("builds a request carrying every structured field alongside the rendered prompts", () => {
    const request = buildAssetGenerationLLMRequest({
      campaign: CAMPAIGN,
      period: PERIOD,
      language: "en",
      context: fixtureContext(),
      allowedCtaTypes: ["view_demo", "remix", "build", "copy_prompt"],
      requestedSocialChannels: [],
      maxTokens: 10000,
    });
    expect(request.systemPrompt).toContain("growth asset designer");
    expect(request.userPrompt).toContain("topic_abc");
    expect(request.maxTokens).toBe(10000);
  });

  it("reflects the requested language in reportingRules", () => {
    const request = buildAssetGenerationLLMRequest({
      campaign: CAMPAIGN,
      period: PERIOD,
      language: "zh-CN",
      context: fixtureContext(),
      allowedCtaTypes: ["view_demo", "remix", "build", "copy_prompt"],
      requestedSocialChannels: [],
      maxTokens: 10000,
    });
    expect(request.reportingRules.at(-1)).toContain("Simplified Chinese");
  });

  it("threads integrationTest: true into both the system prompt and reportingRules, and still requests the full response schema", () => {
    const request = buildAssetGenerationLLMRequest({
      campaign: CAMPAIGN,
      period: PERIOD,
      language: "en",
      context: fixtureContext({ recommendation: "hold" }),
      allowedCtaTypes: ["view_demo", "remix", "build", "copy_prompt"],
      requestedSocialChannels: [],
      maxTokens: 10000,
      integrationTest: true,
    });
    expect(request.systemPrompt.toLowerCase()).toContain("engineering integration test");
    expect(request.reportingRules.some((r) => r.toLowerCase().includes("proven demand"))).toBe(true);
    expect(request.responseSchemaDescription).toContain("appConcept");
    expect(request.responseSchemaDescription).toContain("seo");
  });

  it("defaults integrationTest to false when omitted", () => {
    const request = buildAssetGenerationLLMRequest({
      campaign: CAMPAIGN,
      period: PERIOD,
      language: "en",
      context: fixtureContext(),
      allowedCtaTypes: ["view_demo", "remix", "build", "copy_prompt"],
      requestedSocialChannels: [],
      maxTokens: 10000,
    });
    expect(request.systemPrompt.toLowerCase()).not.toContain("engineering integration test");
  });
});
