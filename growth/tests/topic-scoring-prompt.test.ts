import { describe, expect, it } from "vitest";
import { REPORTING_RULES, buildReportingRules, buildSystemPrompt, buildTopicScoringLLMRequest, buildUserPrompt } from "../prompts/topic-scoring-prompt";
import { getTopicScoringProfile } from "../scoring/topic-scoring-profile";
import type { TopicScoringContext } from "../types/topic-scoring";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureContext(overrides: Partial<TopicScoringContext> = {}): TopicScoringContext {
  return {
    topicId: "topic_abc",
    canonicalName: "Inventory Tracker",
    slug: "inventory-tracker",
    problemStatement: "Small shops lose track of stock.",
    targetAudience: "Small retail shop owners",
    useCases: ["Track stock counts"],
    desiredOutcome: "Fewer stockouts.",
    status: "candidate",
    candidateConfidence: "medium",
    relationshipToExistingContent: { status: "related_to_existing_app", relatedAppSlugs: ["orderly"], relatedTopicIds: [] },
    signals: [{ id: "signal_1", title: "T", summary: "S", signalType: "search_query", confidence: "medium", freshness: "fresh", metrics: [], sourceRecordIds: ["sourcerecord_1"] }],
    citedSourceRecords: [{ id: "sourcerecord_1", title: "R", sourceType: "ga4", content: "C", metrics: [] }],
    signalCount: 1,
    sourceCount: 1,
    sourceTypes: ["ga4"],
    ...overrides,
  };
}

describe("REPORTING_RULES", () => {
  it("prohibits web research, invented market data, weighting/ranking, and content generation", () => {
    const joined = REPORTING_RULES.join(" ").toLowerCase();
    expect(joined).toContain("must not browse the web");
    expect(joined).toContain("must not invent search volume, market size, competitors");
    expect(joined).toContain("must not calculate a weight, a weighted score, or a total score");
    expect(joined).toContain("must not rank the topics");
    expect(joined).toContain("must not choose or state a final recommendation");
    expect(joined).toContain("must not generate app content, seo copy, or social copy");
  });

  it("requires scoring all seven dimensions and distinguishing evidence from policy-default", () => {
    const joined = REPORTING_RULES.join(" ").toLowerCase();
    expect(joined).toContain("all seven required dimensions");
    expect(joined).toContain("policy_default");
  });

  it("treats competition as opportunity favourability, not whole-market competition", () => {
    const joined = REPORTING_RULES.join(" ").toLowerCase();
    expect(joined).toContain("opportunity favourability");
  });

  it("requires concise, evidence-only dimension rationales with a quantified limit", () => {
    const rule = REPORTING_RULES.find((r) => r.toLowerCase().includes("rationale"));
    expect(rule).toBeDefined();
    expect(rule).toContain("2 sentences");
    expect(rule).toContain("300 characters");
    expect(rule?.toLowerCase()).toContain("never repeat the topic");
    expect(rule?.toLowerCase()).toContain("never restate the scoring rubric");
  });
});

describe("buildReportingRules / buildSystemPrompt", () => {
  it("appends language instructions", () => {
    expect(buildReportingRules("en").at(-1)).toContain("English (en)");
    expect(buildReportingRules("zh-CN").at(-1)).toContain("Simplified Chinese");
  });

  it("system prompt identifies the model as a topic-assessment analyst", () => {
    expect(buildSystemPrompt("en")).toContain("topic-assessment analyst");
  });
});

describe("buildUserPrompt", () => {
  it("includes the scoring profile, topic catalog, and topic contexts", () => {
    const profile = getTopicScoringProfile();
    const prompt = buildUserPrompt({
      purpose: "purpose",
      period: PERIOD,
      campaign: CAMPAIGN,
      scoringProfile: profile,
      topicContexts: [fixtureContext()],
      topicCatalog: [{ topicId: "topic_abc", canonicalName: "Inventory Tracker", slug: "inventory-tracker", relatedAppSlugs: ["orderly"], relationshipStatus: "related_to_existing_app", signalCount: 1 }],
      dataQualityWarnings: [],
      sourceIsMock: false,
      sourceHumanReviewed: true,
      responseSchemaDescription: "SCHEMA_DESC",
    });
    expect(prompt).toContain("small_business_topic_scoring");
    expect(prompt).toContain("topic_abc");
    expect(prompt).toContain("SCHEMA_DESC");
  });

  it("reflects mock/human-review status explicitly", () => {
    const prompt = buildUserPrompt({
      purpose: "purpose",
      period: PERIOD,
      campaign: CAMPAIGN,
      scoringProfile: getTopicScoringProfile(),
      topicContexts: [],
      topicCatalog: [],
      dataQualityWarnings: [],
      sourceIsMock: true,
      sourceHumanReviewed: false,
      responseSchemaDescription: "desc",
    });
    expect(prompt).toContain("mock-generated: true");
    expect(prompt).toContain("human-approved: false");
  });

  it("never includes a credential-shaped value", () => {
    const prompt = buildUserPrompt({
      purpose: "purpose",
      period: PERIOD,
      campaign: CAMPAIGN,
      scoringProfile: getTopicScoringProfile(),
      topicContexts: [fixtureContext()],
      topicCatalog: [],
      dataQualityWarnings: [],
      sourceIsMock: false,
      sourceHumanReviewed: true,
      responseSchemaDescription: "desc",
    });
    const lower = prompt.toLowerCase();
    expect(lower).not.toContain("api_key");
    expect(lower).not.toContain("sk-ant");
    expect(lower).not.toContain("bearer");
  });
});

describe("buildTopicScoringLLMRequest", () => {
  it("builds a request carrying every structured field alongside the rendered prompts", () => {
    const request = buildTopicScoringLLMRequest({
      campaign: CAMPAIGN,
      period: PERIOD,
      language: "en",
      scoringProfile: getTopicScoringProfile(),
      topicContexts: [fixtureContext()],
      topicCatalog: [{ topicId: "topic_abc", canonicalName: "Inventory Tracker", slug: "inventory-tracker", relatedAppSlugs: [], relationshipStatus: "new", signalCount: 1 }],
      dataQualityWarnings: ["Search Console is empty for this period."],
      sourceIsMock: false,
      sourceHumanReviewed: true,
      maxTokens: 8000,
    });

    expect(request.systemPrompt).toContain("topic-assessment analyst");
    expect(request.userPrompt).toContain("topic_abc");
    expect(request.topicContexts).toHaveLength(1);
    expect(request.dataQualityWarnings).toEqual(["Search Console is empty for this period."]);
    expect(request.maxTokens).toBe(8000);
  });

  it("reflects the requested language in reportingRules", () => {
    const request = buildTopicScoringLLMRequest({
      campaign: CAMPAIGN,
      period: PERIOD,
      language: "zh-CN",
      scoringProfile: getTopicScoringProfile(),
      topicContexts: [],
      topicCatalog: [],
      dataQualityWarnings: [],
      sourceIsMock: false,
      sourceHumanReviewed: true,
      maxTokens: 8000,
    });
    expect(request.reportingRules.at(-1)).toContain("Simplified Chinese");
  });
});
