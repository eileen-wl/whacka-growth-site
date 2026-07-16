import { describe, expect, it } from "vitest";
import { REPORTING_RULES, buildReportingRules, buildSignalMiningLLMRequest, buildSystemPrompt, buildUserPrompt } from "../prompts/signal-mining-prompt";
import type { SignalSourceRecord } from "../types/signal-mining";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureRecord(overrides: Partial<SignalSourceRecord> = {}): SignalSourceRecord {
  return {
    id: "sourcerecord_abc",
    source: { type: "ga4", name: "GA4 traffic acquisition", recordId: "google/organic", url: null, publishedAt: null, retrievedAt: "2026-07-15T00:00:00.000Z", isInternal: true },
    title: "Traffic source: google / organic",
    content: "GA4 recorded 80 sessions from source=google, medium=organic.",
    entities: { keywords: [], topics: [], audiences: [], productsOrApps: [], channels: ["google / organic"] },
    metrics: [{ name: "sessions", value: 80, unit: "count", measurementBasis: "GA4 topSources sessions.", period: "2026-07-08_to_2026-07-14" }],
    references: { evidenceRefs: [], findingRefs: [], limitationRefs: [] },
    quality: { confidence: "medium", limitations: [] },
    ...overrides,
  };
}

describe("REPORTING_RULES", () => {
  it("prohibits scoring, ranking, asset generation, SEO/social copy, CMS writes, and web search", () => {
    const joined = REPORTING_RULES.join(" ").toLowerCase();
    expect(joined).toContain("must not score or rank topics");
    expect(joined).toContain("must not generate app content, seo copy, or social copy");
    expect(joined).toContain("must not write to a cms");
    expect(joined).toContain("must not search the web");
    expect(joined).toContain("must not choose or describe a final experiment");
  });

  it("requires citing sourceRecordRefs and never inventing an app slug", () => {
    const joined = REPORTING_RULES.join(" ").toLowerCase();
    expect(joined).toContain("sourcerecordrefs");
    expect(joined).toContain("never invent an app slug");
  });
});

describe("buildReportingRules / buildSystemPrompt", () => {
  it("appends an English language instruction by default", () => {
    const rules = buildReportingRules("en");
    expect(rules.at(-1)).toContain("English (en)");
  });

  it("appends a Simplified Chinese language instruction for zh-CN", () => {
    const rules = buildReportingRules("zh-CN");
    expect(rules.at(-1)).toContain("Simplified Chinese");
  });

  it("system prompt identifies the model as a signal-mining analyst", () => {
    expect(buildSystemPrompt("en")).toContain("signal-mining analyst");
  });
});

describe("buildUserPrompt", () => {
  it("includes the source record catalog and existing content catalog verbatim", () => {
    const prompt = buildUserPrompt({
      purpose: "purpose",
      period: PERIOD,
      campaign: CAMPAIGN,
      sourceRecordCatalog: [fixtureRecord()],
      existingContentCatalog: [{ appSlug: "orderly", appName: "Orderly", hook: "Order tracker", status: "unknown", route: "/apps/orderly", availableCtaTypes: ["build", "copy_prompt"] }],
      feedbackContext: null,
      dataQualityWarnings: [],
      responseSchemaDescription: "SCHEMA_DESC",
    });
    expect(prompt).toContain("sourcerecord_abc");
    expect(prompt).toContain('"appSlug": "orderly"');
    expect(prompt).toContain("SCHEMA_DESC");
  });

  it("never includes a credential-shaped value", () => {
    const prompt = buildUserPrompt({
      purpose: "purpose",
      period: PERIOD,
      campaign: CAMPAIGN,
      sourceRecordCatalog: [fixtureRecord()],
      existingContentCatalog: [],
      feedbackContext: null,
      dataQualityWarnings: [],
      responseSchemaDescription: "SCHEMA_DESC",
    });
    const lower = prompt.toLowerCase();
    expect(lower).not.toContain("api_key");
    expect(lower).not.toContain("sk-ant");
    expect(lower).not.toContain("bearer");
  });
});

describe("buildSignalMiningLLMRequest", () => {
  it("builds a request carrying every structured field alongside the rendered prompts", () => {
    const request = buildSignalMiningLLMRequest({
      campaign: CAMPAIGN,
      period: PERIOD,
      language: "en",
      sourceRecordCatalog: [fixtureRecord()],
      existingContentCatalog: [],
      feedbackContext: null,
      dataQualityWarnings: ["Search Console data is empty for this period."],
      maxTokens: 8000,
    });

    expect(request.systemPrompt).toContain("signal-mining analyst");
    expect(request.userPrompt).toContain("sourcerecord_abc");
    expect(request.sourceRecordCatalog).toHaveLength(1);
    expect(request.dataQualityWarnings).toEqual(["Search Console data is empty for this period."]);
    expect(request.maxTokens).toBe(8000);
  });

  it("reflects the requested language in reportingRules", () => {
    const request = buildSignalMiningLLMRequest({
      campaign: CAMPAIGN,
      period: PERIOD,
      language: "zh-CN",
      sourceRecordCatalog: [],
      existingContentCatalog: [],
      feedbackContext: null,
      dataQualityWarnings: [],
      maxTokens: 8000,
    });
    expect(request.reportingRules.at(-1)).toContain("Simplified Chinese");
  });
});
