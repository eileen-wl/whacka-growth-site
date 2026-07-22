import { describe, expect, it } from "vitest";
import { buildReferenceAliasMaps, resolveDeferDetailsAliases, resolveProceedDetailsAliases } from "../llm/experiment-decision-reference-aliases";
import { ExperimentDecisionValidationError } from "../agents/experiment-decision-agent";
import type { DeferDetails, ExperimentDecisionContext, ProceedDetails } from "../types/experiment-decision";

/**
 * Regression coverage for the live Stage 2 reference-validation failure:
 * the model invented human-readable shorthand finding IDs (e.g.
 * "finding.finding-app-perf") instead of selecting an exact catalog ID.
 * These tests cover the deterministic alias layer in isolation — alias
 * construction, sorting, reverse mapping, and resolution — separately from
 * the end-to-end two-stage provider tests in
 * anthropic-experiment-decision-provider.test.ts.
 */

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
    evidenceCatalog: [
      { id: "traffic.sessions", label: "GA4 sessions", value: 100, source: "GA4", measurementBasis: "x" },
      { id: "behavior.total_cta_clicks", label: "Total CTA clicks", value: 50, source: "PostHog", measurementBasis: "x" },
    ],
    findingCatalog: [{ id: "finding.finding-app-perf", title: "App performance", observation: "O", interpretation: "I", evidenceRefs: [], confidence: "medium" }],
    limitationCatalog: [{ id: "data_limit.product_conversions_not_connected", title: "T", impact: "I", relatedEvidenceRefs: [] }],
    decisionScope: { availableTopics: ["Orderly"], availableCtaTypes: ["build"], availableChannels: [] },
    dataQualityStatus: "partial",
    dataQualityWarnings: [],
    measurementNotes: [],
    ...overrides,
  };
}

describe("buildReferenceAliasMaps — deterministic construction", () => {
  it("assigns E###/F###/L### aliases sorted ascending by original id, not insertion order", () => {
    const context = fixtureContext();
    const aliases = buildReferenceAliasMaps(context);

    // "behavior.total_cta_clicks" sorts before "traffic.sessions" ascending, even though it's listed second in the catalog.
    expect(aliases.evidence.toAlias.get("behavior.total_cta_clicks")).toBe("E001");
    expect(aliases.evidence.toAlias.get("traffic.sessions")).toBe("E002");
    expect(aliases.evidence.aliases).toEqual(["E001", "E002"]);

    expect(aliases.finding.toAlias.get("finding.finding-app-perf")).toBe("F001");
    expect(aliases.finding.aliases).toEqual(["F001"]);

    expect(aliases.limitation.toAlias.get("data_limit.product_conversions_not_connected")).toBe("L001");
    expect(aliases.limitation.aliases).toEqual(["L001"]);
  });

  it("pads aliases to at least 3 digits", () => {
    const aliases = buildReferenceAliasMaps(fixtureContext());
    for (const alias of aliases.evidence.aliases) expect(alias).toMatch(/^E\d{3,}$/);
    for (const alias of aliases.finding.aliases) expect(alias).toMatch(/^F\d{3,}$/);
    for (const alias of aliases.limitation.aliases) expect(alias).toMatch(/^L\d{3,}$/);
  });

  it("is stable: rebuilding from an unchanged context produces identical aliases", () => {
    const context = fixtureContext();
    const first = buildReferenceAliasMaps(context);
    const second = buildReferenceAliasMaps(context);
    expect([...first.evidence.toAlias.entries()]).toEqual([...second.evidence.toAlias.entries()]);
    expect([...first.finding.toAlias.entries()]).toEqual([...second.finding.toAlias.entries()]);
    expect([...first.limitation.toAlias.entries()]).toEqual([...second.limitation.toAlias.entries()]);
  });

  it("toId and toAlias are exact inverses of each other", () => {
    const context = fixtureContext();
    const aliases = buildReferenceAliasMaps(context);
    for (const entry of context.evidenceCatalog) {
      const alias = aliases.evidence.toAlias.get(entry.id);
      expect(alias).toBeDefined();
      expect(aliases.evidence.toId.get(alias as string)).toBe(entry.id);
    }
  });

  it("produces an empty alias list (never an invalid empty enum) for an empty catalog", () => {
    const aliases = buildReferenceAliasMaps(fixtureContext({ findingCatalog: [] }));
    expect(aliases.finding.aliases).toEqual([]);
    expect(aliases.finding.toAlias.size).toBe(0);
    expect(aliases.finding.toId.size).toBe(0);
  });

  it("does not change the original final catalogs — only aliases are derived, never mutated in place", () => {
    const context = fixtureContext();
    const before = JSON.stringify(context);
    buildReferenceAliasMaps(context);
    expect(JSON.stringify(context)).toBe(before);
  });
});

function fixtureProceedDetails(overrides: Partial<ProceedDetails> = {}): ProceedDetails {
  return {
    rankedExperimentOptions: [
      {
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
        primaryMetricRef: "E002",
        expectedDirection: "increase",
        successCriterion: "Higher event-based CTA rate than the control.",
        guardrailMetricRefs: ["E001"],
        measurementCaveats: [],
        evidenceRefs: ["E002", "E001"],
        findingRefs: ["F001"],
        limitationRefs: ["L001"],
        confidence: "medium",
        dependencies: [],
        risks: [],
        whyNotHigherRanked: "",
      },
    ],
    recommendedExperimentId: "experiment_1",
    handoffItems: [{ item: "Confirm before shipping.", destination: "manual_review", reason: "Human review required." }],
    ...overrides,
  };
}

describe("resolveProceedDetailsAliases", () => {
  it("maps every E/F/L alias back to its exact original catalog id", () => {
    const context = fixtureContext();
    const aliases = buildReferenceAliasMaps(context);
    const resolved = resolveProceedDetailsAliases(fixtureProceedDetails(), aliases);
    const option = resolved.rankedExperimentOptions[0];

    expect(option.primaryMetricRef).toBe("traffic.sessions");
    expect(option.guardrailMetricRefs).toEqual(["behavior.total_cta_clicks"]);
    expect(option.evidenceRefs).toEqual(["traffic.sessions", "behavior.total_cta_clicks"]);
    expect(option.findingRefs).toEqual(["finding.finding-app-perf"]);
    expect(option.limitationRefs).toEqual(["data_limit.product_conversions_not_connected"]);
  });

  it("rejects an invented/unresolvable evidence alias, never fuzzy-matching it to a real one", () => {
    const aliases = buildReferenceAliasMaps(fixtureContext());
    const details = fixtureProceedDetails({
      rankedExperimentOptions: [{ ...fixtureProceedDetails().rankedExperimentOptions[0], evidenceRefs: ["E999"] }],
    });
    expect(() => resolveProceedDetailsAliases(details, aliases)).toThrow(ExperimentDecisionValidationError);
    expect(() => resolveProceedDetailsAliases(details, aliases)).toThrow(/unknown evidence alias "E999"/);
  });

  it("rejects a non-zero-padded near-miss alias rather than matching it to the real one", () => {
    const aliases = buildReferenceAliasMaps(fixtureContext());
    const details = fixtureProceedDetails({
      rankedExperimentOptions: [{ ...fixtureProceedDetails().rankedExperimentOptions[0], evidenceRefs: ["E2"] }],
    });
    expect(() => resolveProceedDetailsAliases(details, aliases)).toThrow(/unknown evidence alias "E2"/);
  });

  it("rejects a finding alias used where an evidence alias is expected", () => {
    const aliases = buildReferenceAliasMaps(fixtureContext());
    const details = fixtureProceedDetails({
      rankedExperimentOptions: [{ ...fixtureProceedDetails().rankedExperimentOptions[0], primaryMetricRef: "F001" }],
    });
    expect(() => resolveProceedDetailsAliases(details, aliases)).toThrow(/unknown evidence alias "F001"/);
  });

  it("identifies the stage in the thrown message", () => {
    const aliases = buildReferenceAliasMaps(fixtureContext());
    const details = fixtureProceedDetails({
      rankedExperimentOptions: [{ ...fixtureProceedDetails().rankedExperimentOptions[0], findingRefs: ["F999"] }],
    });
    expect(() => resolveProceedDetailsAliases(details, aliases)).toThrow(/Stage 2 \(proceed details\)/);
  });
});

function fixtureDeferDetails(overrides: Partial<DeferDetails> = {}): DeferDetails {
  return {
    reason: "Not enough evidence.",
    missingEvidence: ["More data."],
    requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: ["E001", "L001"] }],
    earliestDecisionCondition: "Later.",
    handoffItems: [],
    ...overrides,
  };
}

describe("resolveDeferDetailsAliases", () => {
  it("maps E and L aliases back to their exact original ids", () => {
    const aliases = buildReferenceAliasMaps(fixtureContext());
    const resolved = resolveDeferDetailsAliases(fixtureDeferDetails(), aliases);
    expect(resolved.requiredNextObservations[0].relatedEvidenceOrLimitationRefs).toEqual(["behavior.total_cta_clicks", "data_limit.product_conversions_not_connected"]);
  });

  it("rejects an F alias in relatedEvidenceOrLimitationRefs — findings are never valid there", () => {
    const aliases = buildReferenceAliasMaps(fixtureContext());
    const details = fixtureDeferDetails({
      requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: ["F001"] }],
    });
    expect(() => resolveDeferDetailsAliases(details, aliases)).toThrow(ExperimentDecisionValidationError);
    expect(() => resolveDeferDetailsAliases(details, aliases)).toThrow(/finding \(F###\) aliases are not valid/);
  });

  it("rejects an invented/unresolvable alias, never fuzzy-matching it", () => {
    const aliases = buildReferenceAliasMaps(fixtureContext());
    const details = fixtureDeferDetails({
      requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: ["L999"] }],
    });
    expect(() => resolveDeferDetailsAliases(details, aliases)).toThrow(/unknown limitation alias "L999"/);
  });

  it("identifies the stage in the thrown message", () => {
    const aliases = buildReferenceAliasMaps(fixtureContext());
    const details = fixtureDeferDetails({
      requiredNextObservations: [{ observation: "Collect more data.", relatedEvidenceOrLimitationRefs: ["not-an-alias"] }],
    });
    expect(() => resolveDeferDetailsAliases(details, aliases)).toThrow(/Stage 2 \(defer details\)/);
  });
});
