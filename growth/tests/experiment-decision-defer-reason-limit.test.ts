import { describe, expect, it } from "vitest";
import { buildDeferDetailsSchema, experimentDecisionAnalysisSchema } from "../types/experiment-decision";
import { buildStage2DeferSystemPrompt } from "../prompts/experiment-decision-prompt";
import { assembleDeferAnalysis } from "../llm/experiment-decision-assembly";
import { buildReferenceAliasMaps } from "../llm/experiment-decision-reference-aliases";
import { validateDecisionAnalysis } from "../agents/experiment-decision-agent";
import type { DecisionGate, DeferDetails, ExperimentDecisionContext } from "../types/experiment-decision";

/**
 * Regression coverage for the live Stage 2 (defer) failure: "Too big:
 * expected string to have <=600 characters" on deferDecision.reason. Both
 * deferDetailsSchema.reason (Stage 2B, live) and the final
 * experimentDecisionAnalysisSchema's deferDecision.reason must share the
 * same raised limit — 600 was the old MEDIUM-text ceiling both sides
 * already agreed on; a real model response exceeded it, exactly the same
 * class of failure the rationale fix already resolved for Stage 1.
 */

const REASON_900 = "R".repeat(900);
const REASON_1500 = "R".repeat(1500);
const REASON_1501 = "R".repeat(1501);

const GATE_DEFER: DecisionGate = { decisionStatus: "defer", headline: "Headline", rationale: "Rationale", confidence: "low" };

function fixtureDeferDetails(reason: string): DeferDetails {
  return {
    reason,
    missingEvidence: ["More data."],
    requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: [] }],
    earliestDecisionCondition: "Later.",
    handoffItems: [],
  };
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

function fixtureAnalysis(reason: string) {
  return {
    decisionSummary: { decisionStatus: "defer" as const, headline: "Headline", rationale: "Rationale", confidence: "low" as const, recommendedExperimentId: null },
    rankedExperimentOptions: [],
    recommendedExperiment: null,
    deferDecision: {
      reason,
      missingEvidence: ["More data."],
      requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: [] }],
      earliestDecisionCondition: "Later.",
    },
    rejectedOrDeferredOptions: [],
    handoff: { forNextLoop: [], humanReviewRequired: true },
  };
}

describe("buildDeferDetailsSchema — reason length", () => {
  const aliases = buildReferenceAliasMaps(fixtureContext());

  it("accepts a reason longer than the old 600-character limit", () => {
    expect(buildDeferDetailsSchema(aliases).safeParse(fixtureDeferDetails(REASON_900)).success).toBe(true);
  });

  it("accepts a reason exactly at the new 1500-character maximum", () => {
    expect(buildDeferDetailsSchema(aliases).safeParse(fixtureDeferDetails(REASON_1500)).success).toBe(true);
  });

  it("rejects a reason exceeding the new maximum", () => {
    expect(buildDeferDetailsSchema(aliases).safeParse(fixtureDeferDetails(REASON_1501)).success).toBe(false);
  });
});

describe("experimentDecisionAnalysisSchema — deferDecision.reason length", () => {
  it("accepts a reason longer than the old 600-character limit", () => {
    expect(experimentDecisionAnalysisSchema.safeParse(fixtureAnalysis(REASON_900)).success).toBe(true);
  });

  it("accepts a reason exactly at the new 1500-character maximum", () => {
    expect(experimentDecisionAnalysisSchema.safeParse(fixtureAnalysis(REASON_1500)).success).toBe(true);
  });

  it("rejects a reason exceeding the new 1500-character maximum", () => {
    expect(experimentDecisionAnalysisSchema.safeParse(fixtureAnalysis(REASON_1501)).success).toBe(false);
  });
});

describe("provider-facing vs final deferDecision.reason constraints stay aligned", () => {
  const aliases = buildReferenceAliasMaps(fixtureContext());

  it("accepts and rejects at exactly the same boundary on both schemas", () => {
    for (const reason of [REASON_900, REASON_1500]) {
      expect(buildDeferDetailsSchema(aliases).safeParse(fixtureDeferDetails(reason)).success).toBe(true);
      expect(experimentDecisionAnalysisSchema.safeParse(fixtureAnalysis(reason)).success).toBe(true);
    }
    expect(buildDeferDetailsSchema(aliases).safeParse(fixtureDeferDetails(REASON_1501)).success).toBe(false);
    expect(experimentDecisionAnalysisSchema.safeParse(fixtureAnalysis(REASON_1501)).success).toBe(false);
  });
});

describe("buildStage2DeferSystemPrompt — concise reason instruction", () => {
  it("explicitly requires a concise reason (sentence cap, character guidance, no evidence/limitation dump, missingEvidence pointer)", () => {
    const prompt = buildStage2DeferSystemPrompt("en");
    expect(prompt).toContain("at most 3 sentences");
    expect(prompt).toContain("under 500 characters");
    expect(prompt.toLowerCase()).toContain("do not restate or copy the evidence catalog");
    expect(prompt.toLowerCase()).toContain("do not enumerate every limitation");
    expect(prompt).toContain("missingEvidence");
  });
});

describe("two-stage assembly with a long (but valid) Stage 2 defer reason", () => {
  it("produces a final decision that still passes the full validator", () => {
    const details = fixtureDeferDetails(REASON_900);
    const analysis = assembleDeferAnalysis(GATE_DEFER, details);
    expect(analysis.deferDecision?.reason).toBe(REASON_900);
    expect(() => validateDecisionAnalysis(analysis, fixtureContext())).not.toThrow();
  });
});
