import { describe, expect, it } from "vitest";
import {
  DECISION_PURPOSE,
  REPORTING_RULES,
  buildExperimentDecisionLLMRequest,
  buildReportingRules,
  buildSystemPrompt,
  buildUserPrompt,
} from "../prompts/experiment-decision-prompt";
import type { ExperimentDecisionContext } from "../types/experiment-decision";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureContext(overrides: Partial<ExperimentDecisionContext> = {}): ExperimentDecisionContext {
  return {
    period: PERIOD,
    campaign: CAMPAIGN,
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
    findingCatalog: [{ id: "finding.finding_1", title: "T", observation: "O", interpretation: "I", evidenceRefs: ["traffic.sessions"], confidence: "medium" }],
    limitationCatalog: [{ id: "data_limit.product_conversions_not_connected", title: "T", impact: "I", relatedEvidenceRefs: [] }],
    decisionScope: { availableTopics: ["Bookly"], availableCtaTypes: ["view_demo"], availableChannels: ["google / organic"] },
    dataQualityStatus: "partial",
    dataQualityWarnings: ["Some warning."],
    measurementNotes: ["Some note."],
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  it("identifies the agent as an evidence-grounded experiment decision analyst", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("experiment decision analyst");
    expect(prompt).toContain("You may only use the supplied decision context");
  });

  it("contains the evidence-grounding rules", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("cite every recommendation using valid evidence IDs");
    expect(prompt).toContain("cite relevant Growth Report finding IDs");
  });

  it("contains decision boundaries: proceed vs defer", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain('recommend exactly one primary experiment when decisionStatus is "proceed"');
    expect(prompt).toContain('set decisionStatus to "defer"');
    expect(prompt.toLowerCase()).toContain("deferring is a valid, expected outcome, not a failure");
  });

  it("prohibits external research and benchmarks", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("must not search the web");
    expect(prompt).toContain("external benchmarks");
  });

  it("prohibits automatic execution, publishing, and CMS changes", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("must not change the CMS, publish an experiment");
    expect(prompt).toContain("execute the recommendation");
    expect(prompt).toContain("This Agent records a decision only.");
  });

  it("prohibits fabricated thresholds implicitly via the fabrication rule", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("fabricate competitors, keywords, user research, traffic sources, conversion data, statistical significance, or sample sizes");
  });

  it("prohibits treating product-conversion nulls as measured outcomes", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("must not optimize for signups, firstAppCreated, or appPublished");
    expect(prompt).toContain("never treat null as zero");
  });

  it("prohibits selecting a topic or channel outside the supplied decision scope", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("must not select a topic/app that does not appear in availableTopics");
    expect(prompt).toContain("channel that does not appear in availableChannels");
    expect(prompt).toContain("Signal Mining");
  });

  it("includes the mock-source-report warning rule", () => {
    const prompt = buildSystemPrompt("en");
    expect(prompt).toContain("mock-generated");
    expect(prompt).toContain("mock-derived");
  });

  it("reflects English by default and Chinese when selected", () => {
    expect(buildSystemPrompt("en")).toContain("Write every string value in the response in English (en).");
    expect(buildSystemPrompt("zh-CN")).toContain("Simplified Chinese (zh-CN)");
  });

  it("never contains a credential-like value", () => {
    const prompt = buildSystemPrompt("en").toLowerCase();
    expect(prompt).not.toContain("api_key");
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
  it("includes period, campaign, source report info, decision scope, and catalogs", () => {
    const context = fixtureContext();
    const prompt = buildUserPrompt({ purpose: DECISION_PURPOSE, context, responseSchemaDescription: "SCHEMA_DESC" });

    expect(prompt).toContain("2026-07-08 to 2026-07-14");
    expect(prompt).toContain("Test Campaign");
    expect(prompt).toContain("growth-report-2026-07-08_to_2026-07-14.json");
    expect(prompt).toContain('"availableTopics"');
    expect(prompt).toContain("Bookly");
    expect(prompt).toContain('"id": "traffic.sessions"');
    expect(prompt).toContain('"id": "finding.finding_1"');
    expect(prompt).toContain('"id": "data_limit.product_conversions_not_connected"');
    expect(prompt).toContain("SCHEMA_DESC");
  });

  it("includes current data limitations via warnings and measurement notes", () => {
    const context = fixtureContext({ dataQualityWarnings: ["Search Console is empty."], measurementNotes: ["Active users unavailable."] });
    const prompt = buildUserPrompt({ purpose: DECISION_PURPOSE, context, responseSchemaDescription: "SCHEMA_DESC" });
    expect(prompt).toContain("Search Console is empty.");
    expect(prompt).toContain("Active users unavailable.");
  });

  it("never contains a credential-like value or an absolute local path", () => {
    const context = fixtureContext();
    const prompt = buildUserPrompt({ purpose: DECISION_PURPOSE, context, responseSchemaDescription: "SCHEMA_DESC" }).toLowerCase();
    expect(prompt).not.toContain("api_key");
    expect(prompt).not.toContain("anthropic_api_key");
    expect(prompt).not.toContain(":\\users\\");
    expect(prompt).not.toContain("node_modules");
  });
});

describe("buildExperimentDecisionLLMRequest", () => {
  it("assembles a request whose rendered prompts embed the structured decision context", () => {
    const context = fixtureContext();
    const request = buildExperimentDecisionLLMRequest({ context, language: "en", maxTokens: 4000 });

    expect(request.context).toEqual(context);
    expect(request.language).toBe("en");
    expect(request.maxTokens).toBe(4000);
    expect(request.systemPrompt).toContain("experiment decision analyst");
    expect(request.userPrompt).toContain("Bookly");
    expect(request.reportingRules.length).toBeGreaterThan(0);
    expect(request.responseSchemaDescription).toContain("decisionSummary");
  });

  it("reflects the selected language in the system prompt", () => {
    const request = buildExperimentDecisionLLMRequest({ context: fixtureContext(), language: "zh-CN", maxTokens: 4000 });
    expect(request.systemPrompt).toContain("Simplified Chinese (zh-CN)");
  });
});
