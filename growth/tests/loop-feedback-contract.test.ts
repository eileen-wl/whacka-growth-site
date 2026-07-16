import { describe, expect, it } from "vitest";
import {
  GrowthLoopFeedbackBuildError,
  GrowthLoopFeedbackValidationError,
  buildGrowthLoopFeedback,
  validateGrowthLoopFeedback,
} from "../contracts/loop-feedback";
import type { GrowthLoopFeedback } from "../contracts/loop-feedback";
import type { FinalExperimentDecision } from "../types/experiment-decision";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

const dataQuality = {
  overallStatus: "partial" as const,
  dateRangeMatch: true,
  missingSources: [] as string[],
  emptySources: [] as string[],
  warnings: [] as string[],
  measurementNotes: [] as string[],
};

function fixtureDeferDecision(): FinalExperimentDecision {
  return {
    schemaVersion: "1.0.0",
    decisionType: "experiment_decision",
    generatedAt: "2026-07-15T00:00:00.000Z",
    period: PERIOD,
    campaign: CAMPAIGN,
    provenance: {
      sourceGrowthReportFilename: "growth-report-2026-07-08_to_2026-07-14.json",
      sourceGrowthReportSha256: "report-hash",
      sourceGrowthReportGeneratedAt: "2026-07-14T23:00:00.000Z",
      sourceGrowthReportProvider: "mock",
      sourceGrowthReportModel: "mock-model",
      sourceGrowthReportIsMock: true,
      sourceDataQualityStatus: "partial",
    },
    generation: { provider: "mock", model: "mock-model", language: "en", isMock: true, requestId: null, stopReason: null, usage: { inputTokens: null, outputTokens: null } },
    decisionScope: { availableTopics: ["inventory tracking"], availableCtaTypes: ["build", "view_demo"], availableChannels: ["organic_search"] },
    evidenceCatalog: [{ id: "traffic.sessions", label: "GA4 sessions", value: 120, source: "GA4", measurementBasis: "sum" }],
    findingCatalog: [{ id: "finding.low_traffic", title: "Low traffic", observation: "Sessions are low.", interpretation: "Not enough data yet.", evidenceRefs: ["traffic.sessions"], confidence: "low" }],
    limitationCatalog: [{ id: "data_limit.partial_data_quality", title: "Partial data quality", impact: "Some metrics are missing.", relatedEvidenceRefs: ["traffic.sessions"] }],
    decision: {
      decisionSummary: { decisionStatus: "defer", headline: "Not enough evidence yet.", rationale: "Traffic volume is too low to size an experiment.", confidence: "low", recommendedExperimentId: null },
      rankedExperimentOptions: [],
      recommendedExperiment: null,
      deferDecision: {
        reason: "Insufficient traffic volume to detect an effect.",
        missingEvidence: ["At least 30 days of consistent traffic."],
        requiredNextObservations: [
          { observation: "Collect another full reporting period of GA4 traffic data.", relatedEvidenceOrLimitationRefs: ["traffic.sessions", "data_limit.partial_data_quality"] },
        ],
        earliestDecisionCondition: "After the next full reporting period.",
      },
      rejectedOrDeferredOptions: [],
      handoff: {
        forNextLoop: [
          { item: "Keep monitoring inventory tracking search demand.", destination: "signal_mining", reason: "Only source type with any signal so far." },
          { item: "Flag for manual review once traffic grows.", destination: "manual_review", reason: "Out of scope for automated handoff." },
        ],
        humanReviewRequired: true,
      },
    },
    humanReview: { required: true, approved: false, approvedBy: null, approvedAt: null, note: "Awaiting human review." },
    dataQuality,
  };
}

function fixtureProceedDecision(): FinalExperimentDecision {
  const base = fixtureDeferDecision();
  return {
    ...base,
    decision: {
      decisionSummary: { decisionStatus: "proceed", headline: "Test a build CTA for inventory tracking.", rationale: "Search demand plus fit justify a CTA test.", confidence: "medium", recommendedExperimentId: "exp_1" },
      rankedExperimentOptions: [
        {
          id: "exp_1",
          rank: 1,
          lever: "cta",
          title: "Swap primary CTA to Build",
          target: { topicOrApp: "inventory tracking", ctaType: "build", channel: "organic_search" },
          hypothesis: "A build CTA converts better than view_demo for this topic.",
          proposedChange: "Change primary CTA label/type to build.",
          controlDescription: "Current view_demo CTA.",
          variantDescription: "New build CTA.",
          measurementPlan: { primaryMetricRef: "traffic.sessions", expectedDirection: "increase", successCriterion: "Build clicks increase by 10%.", guardrailMetricRefs: [], measurementCaveats: [] },
          evidenceRefs: ["traffic.sessions"],
          findingRefs: ["finding.low_traffic"],
          limitationRefs: [],
          confidence: "medium",
          dependencies: [],
          risks: [],
          whyNotHigherRanked: null,
        },
      ],
      recommendedExperiment: {
        experimentId: "exp_1",
        objective: "Increase build-CTA engagement for the inventory tracking topic.",
        hypothesis: "A build CTA converts better than view_demo for this topic.",
        implementationBrief: { change: "Swap CTA to build.", unchangedElements: [], targetPagesOrApps: ["orderly"], targetCta: "build", targetChannel: "organic_search" },
        measurementPlan: { primaryMetricRef: "traffic.sessions", secondaryMetricRefs: [], guardrailMetricRefs: [], successCriterion: "Build clicks increase by 10%.", failureCriterion: "No change within 30 days.", minimumObservationRequirement: "30 days.", knownMeasurementLimitations: [] },
        evidenceRefs: ["traffic.sessions"],
        findingRefs: ["finding.low_traffic"],
        confidence: "medium",
      },
      deferDecision: null,
      rejectedOrDeferredOptions: [],
      handoff: { forNextLoop: [{ item: "Update topic pool with CTA test outcome once available.", destination: "topic_pool", reason: "Feeds the next scoring cycle." }], humanReviewRequired: true },
    },
  };
}

describe("buildGrowthLoopFeedback", () => {
  it("builds valid feedback from a deferred decision", () => {
    const feedback = buildGrowthLoopFeedback(fixtureDeferDecision(), { sourceDecisionFilename: "experiment-decision-2026-07-08_to_2026-07-14.json", sourceDecisionSha256: "decision-hash" });
    expect(() => validateGrowthLoopFeedback(feedback)).not.toThrow();
    expect(feedback.feedbackType).toBe("collect_more_data");
    expect(feedback.sourceDecision.decisionStatus).toBe("defer");
  });

  it("only includes handoff items destined for signal_mining or topic_pool", () => {
    const feedback = buildGrowthLoopFeedback(fixtureDeferDecision(), { sourceDecisionFilename: "f.json", sourceDecisionSha256: "h" });
    expect(feedback.instructions.every((i) => i.destination === "signal_mining" || i.destination === "topic_pool")).toBe(true);
    expect(feedback.instructions.some((i) => i.instruction.includes("manual review"))).toBe(false);
  });

  it("splits mixed relatedEvidenceOrLimitationRefs into evidenceRefs and limitationRefs by known ID prefixes", () => {
    const feedback = buildGrowthLoopFeedback(fixtureDeferDecision(), { sourceDecisionFilename: "f.json", sourceDecisionSha256: "h" });
    const observationInstruction = feedback.instructions.find((i) => i.instruction.includes("Collect another full reporting period"));
    expect(observationInstruction?.evidenceRefs).toContain("traffic.sessions");
    expect(observationInstruction?.limitationRefs).toContain("data_limit.partial_data_quality");
  });

  it("carries mustCollectEvidence true and mustNotClaim populated from cited limitations for a deferred decision", () => {
    const feedback = buildGrowthLoopFeedback(fixtureDeferDecision(), { sourceDecisionFilename: "f.json", sourceDecisionSha256: "h" });
    expect(feedback.constraints.mustCollectEvidence).toBe(true);
    expect(feedback.constraints.mustNotClaim).toContain("Partial data quality");
  });

  it("builds valid feedback from a proceed decision and derives feedbackType from the recommended option's lever", () => {
    const feedback = buildGrowthLoopFeedback(fixtureProceedDecision(), { sourceDecisionFilename: "f.json", sourceDecisionSha256: "h" });
    expect(() => validateGrowthLoopFeedback(feedback)).not.toThrow();
    expect(feedback.feedbackType).toBe("test_cta");
    expect(feedback.sourceDecision.decisionStatus).toBe("proceed");
  });

  it("preserves topicOrApp/ctaType/channel from the matched ranked option for a proceed decision", () => {
    const feedback = buildGrowthLoopFeedback(fixtureProceedDecision(), { sourceDecisionFilename: "f.json", sourceDecisionSha256: "h" });
    const instruction = feedback.instructions.find((i) => i.destination === "topic_pool" && i.topicOrApp !== null);
    expect(instruction?.topicOrApp).toBe("inventory tracking");
    expect(instruction?.ctaType).toBe("build");
    expect(instruction?.channel).toBe("organic_search");
  });

  it("preserves the constraints scope from decisionScope verbatim", () => {
    const feedback = buildGrowthLoopFeedback(fixtureProceedDecision(), { sourceDecisionFilename: "f.json", sourceDecisionSha256: "h" });
    expect(feedback.constraints.allowedTopics).toEqual(["inventory tracking"]);
    expect(feedback.constraints.allowedCtaTypes).toEqual(["build", "view_demo"]);
    expect(feedback.constraints.allowedChannels).toEqual(["organic_search"]);
  });

  it("marks isMock through from the source decision's generation metadata", () => {
    const feedback = buildGrowthLoopFeedback(fixtureDeferDecision(), { sourceDecisionFilename: "f.json", sourceDecisionSha256: "h" });
    expect(feedback.sourceDecision.isMock).toBe(true);
  });

  it("always sets humanReview to required/unapproved by construction", () => {
    const feedback = buildGrowthLoopFeedback(fixtureDeferDecision(), { sourceDecisionFilename: "f.json", sourceDecisionSha256: "h" });
    expect(feedback.humanReview).toEqual({ required: true, approved: false, approvedBy: null, approvedAt: null });
  });

  it("throws when decisionStatus is 'proceed' but recommendedExperiment is null (inconsistent source decision)", () => {
    const decision = fixtureProceedDecision();
    decision.decision.recommendedExperiment = null;
    expect(() => buildGrowthLoopFeedback(decision, { sourceDecisionFilename: "f.json", sourceDecisionSha256: "h" })).toThrow(GrowthLoopFeedbackBuildError);
  });

  it("throws when decisionStatus is 'defer' but deferDecision is null (inconsistent source decision)", () => {
    const decision = fixtureDeferDecision();
    decision.decision.deferDecision = null;
    expect(() => buildGrowthLoopFeedback(decision, { sourceDecisionFilename: "f.json", sourceDecisionSha256: "h" })).toThrow(GrowthLoopFeedbackBuildError);
  });

  it("is a pure function: does not mutate the input decision", () => {
    const decision = fixtureDeferDecision();
    const before = JSON.stringify(decision);
    buildGrowthLoopFeedback(decision, { sourceDecisionFilename: "f.json", sourceDecisionSha256: "h" });
    expect(JSON.stringify(decision)).toBe(before);
  });
});

describe("growthLoopFeedbackSchema", () => {
  function fixtureFeedback(overrides: Partial<GrowthLoopFeedback> = {}): GrowthLoopFeedback {
    const base = buildGrowthLoopFeedback(fixtureDeferDecision(), { sourceDecisionFilename: "f.json", sourceDecisionSha256: "h" });
    return { ...base, ...overrides };
  }

  it("rejects a filename that looks like an absolute local path", () => {
    const feedback = fixtureFeedback({ sourceDecision: { ...fixtureFeedback().sourceDecision, filename: "C:\\Users\\me\\decision.json" } });
    expect(() => validateGrowthLoopFeedback(feedback)).toThrow(GrowthLoopFeedbackValidationError);
  });

  it("rejects humanReview.approved being true without required staying true", () => {
    const feedback = { ...fixtureFeedback(), humanReview: { required: false as unknown as true, approved: true, approvedBy: null, approvedAt: null } };
    expect(() => validateGrowthLoopFeedback(feedback)).toThrow(GrowthLoopFeedbackValidationError);
  });

  it("throws on an unsupported major schema version", () => {
    expect(() => validateGrowthLoopFeedback(fixtureFeedback({ schemaVersion: "2.0.0" }))).toThrow();
  });
});
