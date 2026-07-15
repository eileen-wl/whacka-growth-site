import { describe, expect, it } from "vitest";
import {
  REPORT_PURPOSE,
  REPORTING_RULES,
  buildGrowthReportLLMRequest,
  buildReportingRules,
  buildSystemPrompt,
  buildUserPrompt,
} from "../prompts/growth-report-prompt";
import type { EvidenceEntry } from "../types/growth-report";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

const EVIDENCE_CATALOG: EvidenceEntry[] = [
  { id: "traffic.sessions", label: "GA4 sessions", value: 100, source: "GA4", measurementBasis: "Sum of daily sessions." },
  { id: "behavior.page_views", label: "PostHog pageviews", value: 300, source: "PostHog", measurementBasis: "Sum of $pageview events." },
];

describe("buildSystemPrompt", () => {
  it("identifies the agent as an evidence-grounded analyst scoped to the supplied evidence", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("evidence-grounded growth reporting analyst");
    expect(prompt).toContain("You may only use the supplied evidence catalog and data-quality context.");
  });

  it("contains the evidence-grounding rules", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("cite evidence using only the supplied evidence IDs");
    expect(prompt).toContain("must not invent numbers");
    expect(prompt).toContain("disclose missing or weak data");
  });

  it("explicitly prohibits final experiment decisions and next-step choices", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("must not make final experiment decisions");
    expect(prompt).toContain("choose the next topic");
    expect(prompt).toContain("choose the next CTA");
    expect(prompt).toContain("choose the next distribution channel");
    expect(prompt).toContain("The later Experiment Decision Agent will make experiment decisions.");
  });

  it("prohibits fabrication of benchmarks, competitor comparisons, user feedback, and product conversion data", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("fabricate benchmarks, competitor comparisons, user feedback, or product conversion data");
  });

  it("prohibits web search and external knowledge", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("must not search the web or use external knowledge");
  });

  it("acknowledges Search Console and Whacka data limitations", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("acknowledge when Search Console is empty");
    expect(prompt).toContain("acknowledge that Whacka product-side conversions");
  });

  it("prohibits treating event-count ratios as conversion rates, and mixing GA4/PostHog pageview measurements", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("must not present event-count ratios");
    expect(prompt).toContain("user conversion rates or session conversion rates");
    expect(prompt).toContain("must not treat GA4 pageviews and PostHog pageviews as identical measurements");
  });

  it("prohibits statistical-significance and causation claims", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("must not claim statistical significance");
    expect(prompt).toContain("must not claim causation from correlation");
  });

  it("reflects English by default", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("Write every string value in the response in English (en).");
  });

  it("reflects zh-CN when selected", () => {
    const prompt = buildSystemPrompt("zh-CN");
    expect(prompt).toContain("Simplified Chinese (zh-CN)");
    expect(prompt).not.toContain("Write every string value in the response in English (en).");
  });

  it("never contains a credential-like value", () => {
    const prompt = buildSystemPrompt("en").toLowerCase();
    expect(prompt).not.toContain("api_key");
    expect(prompt).not.toContain("api key");
    expect(prompt).not.toContain("bearer");
    expect(prompt).not.toContain("sk-ant");
  });
});

describe("buildReportingRules", () => {
  it("combines the fixed rules with a language-specific instruction", () => {
    const rules = buildReportingRules("en");
    expect(rules.length).toBe(REPORTING_RULES.length + 1);
    expect(rules.slice(0, REPORTING_RULES.length)).toEqual(REPORTING_RULES);
  });
});

describe("buildUserPrompt", () => {
  it("includes the purpose, period, campaign, and evidence catalog", () => {
    const prompt = buildUserPrompt({
      purpose: REPORT_PURPOSE,
      period: PERIOD,
      campaign: CAMPAIGN,
      evidenceCatalog: EVIDENCE_CATALOG,
      dataQualityWarnings: [],
      measurementNotes: [],
      responseSchemaDescription: "SCHEMA_DESC",
    });

    expect(prompt).toContain(REPORT_PURPOSE);
    expect(prompt).toContain("2026-07-08 to 2026-07-14");
    expect(prompt).toContain("Test Campaign");
    expect(prompt).toContain("test_campaign");
    expect(prompt).toContain('"id": "traffic.sessions"');
    expect(prompt).toContain('"id": "behavior.page_views"');
    expect(prompt).toContain("SCHEMA_DESC");
  });

  it("includes current data-quality warnings and measurement notes when present", () => {
    const prompt = buildUserPrompt({
      purpose: REPORT_PURPOSE,
      period: PERIOD,
      campaign: CAMPAIGN,
      evidenceCatalog: EVIDENCE_CATALOG,
      dataQualityWarnings: ["Search Console API connection succeeded, but all search-performance reports returned zero rows."],
      measurementNotes: ["GA4 activeUsers could not be safely summed."],
      responseSchemaDescription: "SCHEMA_DESC",
    });

    expect(prompt).toContain("Search Console API connection succeeded, but all search-performance reports returned zero rows.");
    expect(prompt).toContain("GA4 activeUsers could not be safely summed.");
  });

  it("shows a placeholder when there are no warnings or notes", () => {
    const prompt = buildUserPrompt({
      purpose: REPORT_PURPOSE,
      period: PERIOD,
      campaign: CAMPAIGN,
      evidenceCatalog: EVIDENCE_CATALOG,
      dataQualityWarnings: [],
      measurementNotes: [],
      responseSchemaDescription: "SCHEMA_DESC",
    });

    expect(prompt).toContain("(none)");
  });

  it("never contains a credential-like value or unrelated raw project data", () => {
    const prompt = buildUserPrompt({
      purpose: REPORT_PURPOSE,
      period: PERIOD,
      campaign: CAMPAIGN,
      evidenceCatalog: EVIDENCE_CATALOG,
      dataQualityWarnings: [],
      measurementNotes: [],
      responseSchemaDescription: "SCHEMA_DESC",
    }).toLowerCase();

    expect(prompt).not.toContain("api_key");
    expect(prompt).not.toContain("anthropic_api_key");
    expect(prompt).not.toContain("posthog_personal_api_key");
    expect(prompt).not.toContain("node_modules");
    expect(prompt).not.toContain(":\\users\\");
  });
});

describe("buildGrowthReportLLMRequest", () => {
  it("assembles a request whose rendered prompts embed the structured inputs", () => {
    const request = buildGrowthReportLLMRequest({
      period: PERIOD,
      campaign: CAMPAIGN,
      language: "en",
      evidenceCatalog: EVIDENCE_CATALOG,
      dataQualityWarnings: ["warning A"],
      measurementNotes: ["note A"],
      maxTokens: 4000,
    });

    expect(request.period).toEqual(PERIOD);
    expect(request.campaign).toEqual(CAMPAIGN);
    expect(request.language).toBe("en");
    expect(request.evidenceCatalog).toEqual(EVIDENCE_CATALOG);
    expect(request.maxTokens).toBe(4000);
    expect(request.systemPrompt).toContain("evidence-grounded growth reporting analyst");
    expect(request.userPrompt).toContain("warning A");
    expect(request.userPrompt).toContain("note A");
    expect(request.reportingRules.length).toBeGreaterThan(0);
    expect(request.responseSchemaDescription).toContain("findings");
  });

  it("produces a Chinese system prompt when language is zh-CN", () => {
    const request = buildGrowthReportLLMRequest({
      period: PERIOD,
      campaign: CAMPAIGN,
      language: "zh-CN",
      evidenceCatalog: EVIDENCE_CATALOG,
      dataQualityWarnings: [],
      measurementNotes: [],
      maxTokens: 4000,
    });

    expect(request.systemPrompt).toContain("Simplified Chinese (zh-CN)");
  });
});
