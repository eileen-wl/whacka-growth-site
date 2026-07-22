import { describe, expect, it } from "vitest";
import { decisionGateSchema, experimentDecisionAnalysisSchema } from "../types/experiment-decision";
import { buildStage1SystemPrompt } from "../prompts/experiment-decision-prompt";
import { assembleDeferAnalysis } from "../llm/experiment-decision-assembly";
import { validateDecisionAnalysis } from "../agents/experiment-decision-agent";
import type { DecisionGate, DeferDetails, ExperimentDecisionContext } from "../types/experiment-decision";

/**
 * Regression coverage for the live Stage 1 failure: "Too big: expected
 * string to have <=600 characters" on decisionSummary.rationale. Both
 * decisionGateSchema (Stage 1, live) and the final
 * experimentDecisionAnalysisSchema's decisionSummary.rationale must share
 * the same raised limit — 600 was the old MEDIUM-text ceiling; a real
 * model response exceeded it.
 */

const RATIONALE_900 = "R".repeat(900);
const RATIONALE_1500 = "R".repeat(1500);
const RATIONALE_1501 = "R".repeat(1501);

function fixtureGate(rationale: string): DecisionGate {
  return { decisionStatus: "defer", headline: "Headline", rationale, confidence: "low" };
}

function fixtureContext(): ExperimentDecisionContext {
  return {
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
    findingCatalog: [],
    limitationCatalog: [{ id: "data_limit.product_conversions_not_connected", title: "T", impact: "I", relatedEvidenceRefs: [] }],
    decisionScope: { availableTopics: [], availableCtaTypes: [], availableChannels: [] },
    dataQualityStatus: "partial",
    dataQualityWarnings: [],
    measurementNotes: [],
  };
}

function fixtureDeferDetails(): DeferDetails {
  return {
    reason: "Not enough evidence.",
    missingEvidence: ["More data."],
    requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: [] }],
    earliestDecisionCondition: "Later.",
    handoffItems: [],
  };
}

describe("decisionGateSchema — rationale length", () => {
  it("accepts a rationale longer than the old 600-character limit", () => {
    expect(decisionGateSchema.safeParse(fixtureGate(RATIONALE_900)).success).toBe(true);
  });

  it("accepts a rationale exactly at the new 1500-character maximum", () => {
    expect(decisionGateSchema.safeParse(fixtureGate(RATIONALE_1500)).success).toBe(true);
  });

  it("rejects a rationale exceeding the new maximum", () => {
    const result = decisionGateSchema.safeParse(fixtureGate(RATIONALE_1501));
    expect(result.success).toBe(false);
  });
});

describe("experimentDecisionAnalysisSchema — decisionSummary.rationale length", () => {
  function fixtureAnalysis(rationale: string) {
    return {
      decisionSummary: { decisionStatus: "defer" as const, headline: "Headline", rationale, confidence: "low" as const, recommendedExperimentId: null },
      rankedExperimentOptions: [],
      recommendedExperiment: null,
      deferDecision: {
        reason: "Not enough evidence.",
        missingEvidence: ["More data."],
        requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: [] }],
        earliestDecisionCondition: "Later.",
      },
      rejectedOrDeferredOptions: [],
      handoff: { forNextLoop: [], humanReviewRequired: true },
    };
  }

  it("accepts a rationale longer than the old 600-character limit", () => {
    expect(experimentDecisionAnalysisSchema.safeParse(fixtureAnalysis(RATIONALE_900)).success).toBe(true);
  });

  it("rejects a rationale exceeding the new 1500-character maximum", () => {
    expect(experimentDecisionAnalysisSchema.safeParse(fixtureAnalysis(RATIONALE_1501)).success).toBe(false);
  });
});

describe("buildStage1SystemPrompt — concise rationale instruction", () => {
  it("explicitly requires a concise rationale (sentence cap, character guidance, no evidence/limitation dump)", () => {
    const prompt = buildStage1SystemPrompt("en");
    expect(prompt).toContain("at most 3 sentences");
    expect(prompt).toContain("under 500 characters");
    expect(prompt.toLowerCase()).toContain("do not restate or copy the evidence catalog");
    expect(prompt.toLowerCase()).toContain("do not enumerate every limitation");
  });
});

describe("two-stage assembly with a long (but valid) Stage 1 rationale", () => {
  it("produces a final decision that still passes the full validator", () => {
    const gate = fixtureGate(RATIONALE_900);
    const analysis = assembleDeferAnalysis(gate, fixtureDeferDetails());
    expect(analysis.decisionSummary.rationale).toBe(RATIONALE_900);
    expect(() => validateDecisionAnalysis(analysis, fixtureContext())).not.toThrow();
  });
});
