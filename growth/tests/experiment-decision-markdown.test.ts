import { describe, expect, it } from "vitest";
import { renderExperimentDecisionMarkdown } from "../renderers/experiment-decision-markdown";
import type { EvidenceEntry } from "../types/growth-report";
import type { ExperimentDecisionAnalysis, FinalExperimentDecision, FindingCatalogEntry, LimitationCatalogEntry } from "../types/experiment-decision";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

const EVIDENCE: EvidenceEntry[] = [
  { id: "behavior.event_based_cta_rate", label: "Event-based CTA rate", value: 0.17, source: "PostHog", measurementBasis: "x" },
  { id: "traffic.sessions", label: "GA4 sessions", value: 100, source: "GA4", measurementBasis: "x" },
];
const FINDINGS: FindingCatalogEntry[] = [
  { id: "finding.finding_1", title: "Traffic finding", observation: "O", interpretation: "I", evidenceRefs: ["traffic.sessions"], confidence: "medium" },
];
const LIMITATIONS: LimitationCatalogEntry[] = [
  { id: "data_limit.product_conversions_not_connected", title: "Whacka product-side conversions are not connected", impact: "Cannot measure signups.", relatedEvidenceRefs: [] },
];

function proceedAnalysis(): ExperimentDecisionAnalysis {
  return {
    decisionSummary: { decisionStatus: "proceed", headline: "Emphasize view_demo for Bookly", rationale: "Rationale text.", confidence: "low", recommendedExperimentId: "experiment_1" },
    rankedExperimentOptions: [
      {
        id: "experiment_1",
        rank: 1,
        lever: "cta",
        title: "Emphasize view_demo",
        target: { topicOrApp: "Bookly", ctaType: "view_demo", channel: null },
        hypothesis: "Hypothesis text.",
        proposedChange: "Proposed change text.",
        controlDescription: "Control text.",
        variantDescription: "Variant text.",
        measurementPlan: {
          primaryMetricRef: "behavior.event_based_cta_rate",
          expectedDirection: "increase",
          successCriterion: "Higher event-based CTA rate than the control.",
          guardrailMetricRefs: ["traffic.sessions"],
          measurementCaveats: [],
        },
        evidenceRefs: ["behavior.event_based_cta_rate"],
        findingRefs: ["finding.finding_1"],
        limitationRefs: ["data_limit.product_conversions_not_connected"],
        confidence: "low",
        dependencies: [],
        risks: [],
        whyNotHigherRanked: null,
      },
    ],
    recommendedExperiment: {
      experimentId: "experiment_1",
      objective: "Objective text.",
      hypothesis: "Hypothesis text.",
      implementationBrief: { change: "Change text.", unchangedElements: ["Nothing else changes."], targetPagesOrApps: ["Bookly"], targetCta: "view_demo", targetChannel: null },
      measurementPlan: {
        primaryMetricRef: "behavior.event_based_cta_rate",
        secondaryMetricRefs: [],
        guardrailMetricRefs: ["traffic.sessions"],
        successCriterion: "Higher event-based CTA rate than the control.",
        failureCriterion: "No improvement.",
        minimumObservationRequirement: "Both variants must receive measurable pageviews.",
        knownMeasurementLimitations: [],
      },
      evidenceRefs: ["behavior.event_based_cta_rate"],
      findingRefs: ["finding.finding_1"],
      confidence: "low",
    },
    deferDecision: null,
    rejectedOrDeferredOptions: [],
    handoff: { forNextLoop: [{ item: "Confirm before treating as real.", destination: "manual_review", reason: "Low confidence." }], humanReviewRequired: true },
  };
}

function deferAnalysis(): ExperimentDecisionAnalysis {
  return {
    decisionSummary: { decisionStatus: "defer", headline: "Decision deferred", rationale: "Not enough evidence.", confidence: "low", recommendedExperimentId: null },
    rankedExperimentOptions: [],
    recommendedExperiment: null,
    deferDecision: {
      reason: "Not enough evidence.",
      missingEvidence: ["More traffic data."],
      requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: ["traffic.sessions"] }],
      earliestDecisionCondition: "Once more data is available.",
    },
    rejectedOrDeferredOptions: [{ title: "Rejected option", reason: "Insufficient evidence.", evidenceRefs: ["traffic.sessions"], limitationRefs: [] }],
    handoff: { forNextLoop: [], humanReviewRequired: true },
  };
}

function fixtureDecision(analysis: ExperimentDecisionAnalysis, overrides: Partial<FinalExperimentDecision> = {}): FinalExperimentDecision {
  return {
    schemaVersion: "1.0.0",
    decisionType: "experiment_decision",
    generatedAt: "2026-07-16T00:00:00.000Z",
    period: PERIOD,
    campaign: CAMPAIGN,
    provenance: {
      sourceGrowthReportFilename: "growth-report-2026-07-08_to_2026-07-14.json",
      sourceGrowthReportSha256: "abc123",
      sourceGrowthReportGeneratedAt: "2026-07-15T00:00:00.000Z",
      sourceGrowthReportProvider: "anthropic",
      sourceGrowthReportModel: "claude-test-model",
      sourceGrowthReportIsMock: false,
      sourceDataQualityStatus: "partial",
    },
    generation: { provider: "mock", model: "mock-v0", language: "en", isMock: true, requestId: null, stopReason: "end_turn", usage: { inputTokens: null, outputTokens: null } },
    decisionScope: { availableTopics: ["Bookly"], availableCtaTypes: ["view_demo"], availableChannels: [] },
    evidenceCatalog: EVIDENCE,
    findingCatalog: FINDINGS,
    limitationCatalog: LIMITATIONS,
    decision: analysis,
    humanReview: { required: true, approved: false, approvedBy: null, approvedAt: null, note: "The Experiment Decision Agent does not execute changes automatically." },
    dataQuality: { overallStatus: "partial", dateRangeMatch: true, missingSources: [], emptySources: [], warnings: ["Some warning."], measurementNotes: [] },
    ...overrides,
  };
}

describe("renderExperimentDecisionMarkdown — proceed", () => {
  const markdown = renderExperimentDecisionMarkdown(fixtureDecision(proceedAnalysis()));

  it("renders the proceed-path sections", () => {
    for (const heading of [
      "# Experiment Decision Brief",
      "## Decision Status",
      "## Reporting Period",
      "## Campaign",
      "## Recommendation",
      "## Why This Decision",
      "## Ranked Experiment Options",
      "## Recommended Experiment Brief",
      "## Hypothesis",
      "## Proposed Change",
      "## Control and Variant",
      "## Measurement Plan",
      "## Evidence",
      "## Risks and Dependencies",
      "## Rejected or Deferred Options",
      "## Data Limitations",
      "## Handoff to the Next Growth Loop Stage",
      "## Human Review",
      "## Generation Metadata",
    ]) {
      expect(markdown).toContain(heading);
    }
  });

  it("does not render the defer-only sections", () => {
    expect(markdown).not.toContain("## Decision Deferred");
    expect(markdown).not.toContain("## Missing Evidence");
  });

  it("shows PROCEED status prominently", () => {
    expect(markdown).toContain("**PROCEED**");
  });

  it("resolves evidence references to label and value", () => {
    expect(markdown).toContain("`behavior.event_based_cta_rate` (Event-based CTA rate: 0.17)");
  });

  it("resolves finding and limitation references to their titles", () => {
    expect(markdown).toContain("`finding.finding_1` (Traffic finding)");
    expect(markdown).toContain("`data_limit.product_conversions_not_connected` (Whacka product-side conversions are not connected)");
  });

  it("shows control and variant descriptions", () => {
    expect(markdown).toContain("Control text.");
    expect(markdown).toContain("Variant text.");
  });

  it("shows the measurement plan's success/failure/minimum-observation criteria", () => {
    expect(markdown).toContain("Higher event-based CTA rate than the control.");
    expect(markdown).toContain("No improvement.");
    expect(markdown).toContain("Both variants must receive measurable pageviews.");
  });
});

describe("renderExperimentDecisionMarkdown — defer", () => {
  const markdown = renderExperimentDecisionMarkdown(fixtureDecision(deferAnalysis()));

  it("renders the defer-path sections instead of the recommendation sections", () => {
    expect(markdown).toContain("## Decision Deferred");
    expect(markdown).toContain("## Why the Decision Was Deferred");
    expect(markdown).toContain("## Missing Evidence");
    expect(markdown).toContain("## Required Next Observations");
    expect(markdown).toContain("## Earliest Decision Condition");
    expect(markdown).not.toContain("## Recommendation\n");
  });

  it("shows DEFER status prominently", () => {
    expect(markdown).toContain("**DEFER**");
  });

  it("lists missing evidence and required next observations", () => {
    expect(markdown).toContain("More traffic data.");
    expect(markdown).toContain("Collect more data.");
  });

  it("shows rejected or deferred options", () => {
    expect(markdown).toContain("Rejected option");
    expect(markdown).toContain("Insufficient evidence.");
  });
});

describe("renderExperimentDecisionMarkdown — mock status and unavailable values", () => {
  it("prominently marks a mock-generated source Growth Report", () => {
    const decision = fixtureDecision(deferAnalysis(), { provenance: { ...fixtureDecision(deferAnalysis()).provenance, sourceGrowthReportIsMock: true } });
    const markdown = renderExperimentDecisionMarkdown(decision);
    expect(markdown.toLowerCase()).toContain("mock-generated");
  });

  it("prominently marks a mock-generated decision itself", () => {
    const markdown = renderExperimentDecisionMarkdown(fixtureDecision(deferAnalysis()));
    expect(markdown).toContain("MOCK — not a real analysis");
  });

  it("shows human review requirement prominently", () => {
    const markdown = renderExperimentDecisionMarkdown(fixtureDecision(deferAnalysis()));
    expect(markdown).toContain("## Human Review");
    expect(markdown).toContain("**Required:** Yes");
    expect(markdown).toContain("**Approved:** No");
  });

  it("renders null/unavailable values as Unavailable, never as 0 or empty", () => {
    const markdown = renderExperimentDecisionMarkdown(fixtureDecision(deferAnalysis()));
    expect(markdown).toContain("**Approved by:** Unavailable");
    expect(markdown).toContain("**Approved at:** Unavailable");
    expect(markdown).toContain("**Input tokens:** Unavailable");
    expect(markdown).toContain("**Output tokens:** Unavailable");
  });

  it("shows an unresolved marker for a reference missing from every catalog, instead of crashing", () => {
    const analysis = deferAnalysis();
    analysis.deferDecision!.requiredNextObservations[0].relatedEvidenceOrLimitationRefs = ["nonexistent.id"];
    const markdown = renderExperimentDecisionMarkdown(fixtureDecision(analysis));
    expect(markdown).toContain("`nonexistent.id` (unresolved)");
  });
});
