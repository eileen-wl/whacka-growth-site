import { describe, expect, it } from "vitest";
import { assembleDeferAnalysis, assembleProceedAnalysis } from "../llm/experiment-decision-assembly";
import { ExperimentDecisionValidationError, validateDecisionAnalysis } from "../agents/experiment-decision-agent";
import type { DecisionGate, DeferDetails, ExperimentDecisionContext, ProceedDetails } from "../types/experiment-decision";

const GATE_PROCEED: DecisionGate = { decisionStatus: "proceed", headline: "Headline", rationale: "Rationale", confidence: "medium" };
const GATE_DEFER: DecisionGate = { decisionStatus: "defer", headline: "Headline", rationale: "Rationale", confidence: "low" };

function fixtureContext(overrides: Partial<ExperimentDecisionContext> = {}): ExperimentDecisionContext {
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
    decisionScope: { availableTopics: ["Orderly"], availableCtaTypes: ["build"], availableChannels: ["utm_source=newsletter"] },
    dataQualityStatus: "partial",
    dataQualityWarnings: [],
    measurementNotes: [],
    ...overrides,
  };
}

function fixtureProceedOption(overrides: Partial<ProceedDetails["rankedExperimentOptions"][number]> = {}): ProceedDetails["rankedExperimentOptions"][number] {
  return {
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
    primaryMetricRef: "traffic.sessions",
    expectedDirection: "increase",
    successCriterion: "Higher event-based CTA rate than the control.",
    guardrailMetricRefs: [],
    measurementCaveats: [],
    evidenceRefs: ["traffic.sessions"],
    findingRefs: [],
    limitationRefs: [],
    confidence: "medium",
    dependencies: [],
    risks: [],
    whyNotHigherRanked: "",
    ...overrides,
  };
}

function fixtureProceedDetails(overrides: Partial<ProceedDetails> = {}): ProceedDetails {
  return {
    rankedExperimentOptions: [fixtureProceedOption()],
    recommendedExperimentId: "experiment_1",
    handoffItems: [{ item: "Confirm before shipping.", destination: "manual_review", reason: "Human review required." }],
    ...overrides,
  };
}

function fixtureDeferDetails(overrides: Partial<DeferDetails> = {}): DeferDetails {
  return {
    reason: "Not enough evidence.",
    missingEvidence: ["More data."],
    requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: ["data_limit.product_conversions_not_connected"] }],
    earliestDecisionCondition: "Later.",
    handoffItems: [{ item: "Re-run once more data exists.", destination: "manual_review", reason: "Insufficient evidence." }],
    ...overrides,
  };
}

describe("assembleProceedAnalysis", () => {
  it("carries the stage 1 gate fields through to decisionSummary", () => {
    const analysis = assembleProceedAnalysis(GATE_PROCEED, fixtureProceedDetails());
    expect(analysis.decisionSummary).toEqual({
      decisionStatus: "proceed",
      headline: "Headline",
      rationale: "Rationale",
      confidence: "medium",
      recommendedExperimentId: "experiment_1",
    });
  });

  it("converts empty-string target sentinels to null", () => {
    const analysis = assembleProceedAnalysis(GATE_PROCEED, fixtureProceedDetails());
    expect(analysis.rankedExperimentOptions[0].target).toEqual({ topicOrApp: "Orderly", ctaType: "build", channel: null });
    expect(analysis.rankedExperimentOptions[0].whyNotHigherRanked).toBeNull();
  });

  it("does not convert a non-empty target field", () => {
    const details = fixtureProceedDetails({ rankedExperimentOptions: [fixtureProceedOption({ targetChannel: "utm_source=newsletter" })] });
    const analysis = assembleProceedAnalysis(GATE_PROCEED, details);
    expect(analysis.rankedExperimentOptions[0].target.channel).toBe("utm_source=newsletter");
  });

  it("derives recommendedExperiment entirely from the selected option — no separate model-authored content", () => {
    const analysis = assembleProceedAnalysis(GATE_PROCEED, fixtureProceedDetails());
    const option = analysis.rankedExperimentOptions[0];
    expect(analysis.recommendedExperiment).toEqual({
      experimentId: "experiment_1",
      objective: option.hypothesis,
      hypothesis: option.hypothesis,
      implementationBrief: {
        change: option.proposedChange,
        unchangedElements: [option.controlDescription],
        targetPagesOrApps: ["Orderly"],
        targetCta: "build",
        targetChannel: null,
      },
      measurementPlan: {
        primaryMetricRef: option.measurementPlan.primaryMetricRef,
        secondaryMetricRefs: [],
        guardrailMetricRefs: option.measurementPlan.guardrailMetricRefs,
        successCriterion: option.measurementPlan.successCriterion,
        failureCriterion: expect.any(String),
        minimumObservationRequirement: expect.any(String),
        knownMeasurementLimitations: option.measurementPlan.measurementCaveats,
      },
      evidenceRefs: option.evidenceRefs,
      findingRefs: option.findingRefs,
      confidence: option.confidence,
    });
  });

  it("sets deferDecision to null", () => {
    const analysis = assembleProceedAnalysis(GATE_PROCEED, fixtureProceedDetails());
    expect(analysis.deferDecision).toBeNull();
  });

  it("derives rejectedOrDeferredOptions from every non-recommended option", () => {
    const details = fixtureProceedDetails({
      rankedExperimentOptions: [
        fixtureProceedOption({ id: "experiment_1", rank: 1 }),
        fixtureProceedOption({ id: "experiment_2", rank: 2, title: "Alt option", whyNotHigherRanked: "Weaker evidence base." }),
      ],
      recommendedExperimentId: "experiment_1",
    });
    const analysis = assembleProceedAnalysis(GATE_PROCEED, details);
    expect(analysis.rejectedOrDeferredOptions).toEqual([
      { title: "Alt option", reason: "Weaker evidence base.", evidenceRefs: ["traffic.sessions"], limitationRefs: [] },
    ]);
  });

  it("falls back to a generic reason when whyNotHigherRanked is empty for a non-recommended option", () => {
    const details = fixtureProceedDetails({
      rankedExperimentOptions: [
        fixtureProceedOption({ id: "experiment_1", rank: 1 }),
        fixtureProceedOption({ id: "experiment_2", rank: 2, title: "Alt option", whyNotHigherRanked: "" }),
      ],
      recommendedExperimentId: "experiment_1",
    });
    const analysis = assembleProceedAnalysis(GATE_PROCEED, details);
    expect(analysis.rejectedOrDeferredOptions[0].reason).toBe("Ranked below the recommended option.");
  });

  it("passes handoffItems through with humanReviewRequired fixed to true", () => {
    const analysis = assembleProceedAnalysis(GATE_PROCEED, fixtureProceedDetails());
    expect(analysis.handoff).toEqual({
      forNextLoop: [{ item: "Confirm before shipping.", destination: "manual_review", reason: "Human review required." }],
      humanReviewRequired: true,
    });
  });

  it("throws ExperimentDecisionValidationError when recommendedExperimentId matches no option", () => {
    const details = fixtureProceedDetails({ recommendedExperimentId: "does_not_exist" });
    expect(() => assembleProceedAnalysis(GATE_PROCEED, details)).toThrow(ExperimentDecisionValidationError);
    expect(() => assembleProceedAnalysis(GATE_PROCEED, details)).toThrow(/Stage 2 \(proceed details\)/);
  });

  it("produces an analysis that passes the existing full validator", () => {
    const context = fixtureContext();
    const analysis = assembleProceedAnalysis(GATE_PROCEED, fixtureProceedDetails());
    expect(() => validateDecisionAnalysis(analysis, context)).not.toThrow();
  });

  it("rejects an assembled analysis that cites an evidenceRef not present in the catalog (invalid Stage 2 reference)", () => {
    const context = fixtureContext();
    const details = fixtureProceedDetails({
      rankedExperimentOptions: [fixtureProceedOption({ evidenceRefs: ["made_up_evidence_id"] })],
    });
    const analysis = assembleProceedAnalysis(GATE_PROCEED, details);
    expect(() => validateDecisionAnalysis(analysis, context)).toThrow(ExperimentDecisionValidationError);
    expect(() => validateDecisionAnalysis(analysis, context)).toThrow(/made_up_evidence_id/);
  });

  it("rejects an assembled analysis that targets a topic outside the decision scope", () => {
    const context = fixtureContext();
    const details = fixtureProceedDetails({
      rankedExperimentOptions: [fixtureProceedOption({ targetTopicOrApp: "SomeAppNotInScope" })],
    });
    const analysis = assembleProceedAnalysis(GATE_PROCEED, details);
    expect(() => validateDecisionAnalysis(analysis, context)).toThrow(ExperimentDecisionValidationError);
  });
});

describe("assembleDeferAnalysis", () => {
  it("carries the stage 1 gate fields through to decisionSummary, with recommendedExperimentId null", () => {
    const analysis = assembleDeferAnalysis(GATE_DEFER, fixtureDeferDetails());
    expect(analysis.decisionSummary).toEqual({
      decisionStatus: "defer",
      headline: "Headline",
      rationale: "Rationale",
      confidence: "low",
      recommendedExperimentId: null,
    });
  });

  it("sets rankedExperimentOptions, recommendedExperiment, and rejectedOrDeferredOptions to their empty/null defaults", () => {
    const analysis = assembleDeferAnalysis(GATE_DEFER, fixtureDeferDetails());
    expect(analysis.rankedExperimentOptions).toEqual([]);
    expect(analysis.recommendedExperiment).toBeNull();
    expect(analysis.rejectedOrDeferredOptions).toEqual([]);
  });

  it("maps deferDecision fields through verbatim", () => {
    const details = fixtureDeferDetails();
    const analysis = assembleDeferAnalysis(GATE_DEFER, details);
    expect(analysis.deferDecision).toEqual({
      reason: details.reason,
      missingEvidence: details.missingEvidence,
      requiredNextObservations: details.requiredNextObservations,
      earliestDecisionCondition: details.earliestDecisionCondition,
    });
  });

  it("passes handoffItems through with humanReviewRequired fixed to true", () => {
    const analysis = assembleDeferAnalysis(GATE_DEFER, fixtureDeferDetails());
    expect(analysis.handoff.humanReviewRequired).toBe(true);
    expect(analysis.handoff.forNextLoop).toEqual(fixtureDeferDetails().handoffItems);
  });

  it("produces an analysis that passes the existing full validator", () => {
    const context = fixtureContext();
    const analysis = assembleDeferAnalysis(GATE_DEFER, fixtureDeferDetails());
    expect(() => validateDecisionAnalysis(analysis, context)).not.toThrow();
  });

  it("rejects an assembled analysis whose requiredNextObservations cite an unknown evidence/limitation id", () => {
    const context = fixtureContext();
    const details = fixtureDeferDetails({
      requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: ["made_up_limitation_id"] }],
    });
    const analysis = assembleDeferAnalysis(GATE_DEFER, details);
    expect(() => validateDecisionAnalysis(analysis, context)).toThrow(ExperimentDecisionValidationError);
    expect(() => validateDecisionAnalysis(analysis, context)).toThrow(/made_up_limitation_id/);
  });
});
