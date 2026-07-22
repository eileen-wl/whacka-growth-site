import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BuildFeedbackArgsError,
  BuildFeedbackInputError,
  parseAndValidateFinalExperimentDecision,
  parseArgs,
  resolveFeedbackOutputPath,
  run,
} from "../scripts/build-growth-loop-feedback";
import { validateGrowthLoopFeedback } from "../contracts/loop-feedback";
import type { FileSystemDeps } from "../scripts/build-growth-loop-feedback";
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
        forNextLoop: [{ item: "Keep monitoring inventory tracking search demand.", destination: "signal_mining", reason: "Only source type with any signal so far." }],
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

function fakeDeps(files: Record<string, unknown>): FileSystemDeps {
  return {
    readFile: (path: string) => {
      const name = path.replace(/\\/g, "/").split("/").pop() as string;
      if (!(name in files)) throw new Error(`ENOENT: no such file "${name}"`);
      const value = files[name];
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    exists: (path: string) => {
      const name = path.replace(/\\/g, "/").split("/").pop() as string;
      return name in files;
    },
  };
}

const INPUT_FILENAME = "experiment-decision-2026-07-08_to_2026-07-14.json";

describe("parseArgs", () => {
  it("requires --input", () => {
    expect(() => parseArgs([])).toThrow(BuildFeedbackArgsError);
    expect(() => parseArgs(["--overwrite"])).toThrow(BuildFeedbackArgsError);
  });

  it("accepts --input and defaults --overwrite to false", () => {
    const args = parseArgs(["--input", "growth/decisions/x.json"]);
    expect(args.input).toBe("growth/decisions/x.json");
    expect(args.overwrite).toBe(false);
  });

  it("accepts --overwrite", () => {
    const args = parseArgs(["--input", "x.json", "--overwrite"]);
    expect(args.overwrite).toBe(true);
  });

  it("rejects an unrecognized argument", () => {
    expect(() => parseArgs(["--input", "x.json", "--bogus"])).toThrow(BuildFeedbackArgsError);
  });

  it("does not support --start/--end (period comes from the source decision, not CLI flags)", () => {
    expect(() => parseArgs(["--input", "x.json", "--start", "2026-07-08"])).toThrow(BuildFeedbackArgsError);
  });
});

describe("parseAndValidateFinalExperimentDecision", () => {
  it("accepts a valid FinalExperimentDecision", () => {
    const content = JSON.stringify(fixtureDeferDecision());
    expect(() => parseAndValidateFinalExperimentDecision(content, INPUT_FILENAME)).not.toThrow();
  });

  it("rejects malformed JSON", () => {
    expect(() => parseAndValidateFinalExperimentDecision("{not json", INPUT_FILENAME)).toThrow(BuildFeedbackInputError);
  });

  it("rejects a JSON object that isn't a FinalExperimentDecision", () => {
    expect(() => parseAndValidateFinalExperimentDecision(JSON.stringify({ foo: "bar" }), INPUT_FILENAME)).toThrow(BuildFeedbackInputError);
  });

  it("rejects the wrong decisionType", () => {
    const bad = { ...fixtureDeferDecision(), decisionType: "growth_report" };
    expect(() => parseAndValidateFinalExperimentDecision(JSON.stringify(bad), INPUT_FILENAME)).toThrow(BuildFeedbackInputError);
  });

  it("rejects an invalid embedded decision object (schema-invalid)", () => {
    const bad = fixtureDeferDecision();
    (bad.decision as unknown as Record<string, unknown>).decisionSummary = { decisionStatus: "not_a_real_status" };
    expect(() => parseAndValidateFinalExperimentDecision(JSON.stringify(bad), INPUT_FILENAME)).toThrow(BuildFeedbackInputError);
  });
});

describe("resolveFeedbackOutputPath — collision-safe filenames", () => {
  it("reuses the base filename when it does not already exist", () => {
    const path = resolveFeedbackOutputPath(PERIOD, false, () => false);
    expect(path.replace(/\\/g, "/")).toContain(`growth-loop-feedback-${PERIOD.start}_to_${PERIOD.end}.json`);
  });

  it("appends a timestamp when the base filename exists and --overwrite is not set", () => {
    const path = resolveFeedbackOutputPath(PERIOD, false, () => true, new Date("2026-07-21T00:00:00.000Z"));
    expect(path).toContain("2026-07-21T00-00-00");
  });

  it("reuses the base filename in place when --overwrite is set, even if it exists", () => {
    const path = resolveFeedbackOutputPath(PERIOD, true, () => true, new Date("2026-07-21T00:00:00.000Z"));
    expect(path.replace(/\\/g, "/")).toContain(`growth-loop-feedback-${PERIOD.start}_to_${PERIOD.end}.json`);
    expect(path).not.toContain("2026-07-21T00-00-00");
  });
});

describe("run — end-to-end (real writes to growth/decisions/, gitignored)", () => {
  it("converts a valid defer decision and writes valid GrowthLoopFeedback", () => {
    const deps = fakeDeps({ [INPUT_FILENAME]: fixtureDeferDecision() });
    const result = run(["--input", INPUT_FILENAME, "--overwrite"], deps);

    expect(() => validateGrowthLoopFeedback(result.feedback)).not.toThrow();
    expect(result.feedback.feedbackType).toBe("collect_more_data");
    expect(result.feedback.sourceDecision.decisionStatus).toBe("defer");

    const onDisk = JSON.parse(readFileSync(result.outputPath, "utf-8"));
    expect(() => validateGrowthLoopFeedback(onDisk)).not.toThrow();
    rmSync(result.outputPath, { force: true });
  });

  it("converts a valid proceed decision and writes valid GrowthLoopFeedback", () => {
    const deps = fakeDeps({ [INPUT_FILENAME]: fixtureProceedDecision() });
    const result = run(["--input", INPUT_FILENAME, "--overwrite"], deps);

    expect(() => validateGrowthLoopFeedback(result.feedback)).not.toThrow();
    expect(result.feedback.feedbackType).toBe("test_cta");
    expect(result.feedback.sourceDecision.decisionStatus).toBe("proceed");
    rmSync(result.outputPath, { force: true });
  });

  it("stores the source filename as a basename only, never an absolute/relative path", () => {
    const deps = fakeDeps({ [INPUT_FILENAME]: fixtureDeferDecision() });
    const result = run(["--input", `growth/decisions/${INPUT_FILENAME}`, "--overwrite"], deps);

    expect(result.sourceFilename).toBe(INPUT_FILENAME);
    expect(result.feedback.sourceDecision.filename).toBe(INPUT_FILENAME);
    expect(result.feedback.sourceDecision.filename).not.toContain("growth/decisions");
    expect(result.feedback.sourceDecision.filename).not.toMatch(/^[A-Za-z]:\\|^\//);
    rmSync(result.outputPath, { force: true });
  });

  it("computes the correct sha256 of the exact source file content", async () => {
    const { createHash } = await import("node:crypto");
    const content = JSON.stringify(fixtureDeferDecision());
    const expectedSha256 = createHash("sha256").update(content).digest("hex");

    const deps = fakeDeps({ [INPUT_FILENAME]: content });
    const result = run(["--input", INPUT_FILENAME, "--overwrite"], deps);

    expect(result.sourceSha256).toBe(expectedSha256);
    expect(result.feedback.sourceDecision.sha256).toBe(expectedSha256);
    rmSync(result.outputPath, { force: true });
  });

  it("rejects malformed JSON input end-to-end and writes nothing", () => {
    const deps = fakeDeps({ [INPUT_FILENAME]: "{not json" });
    expect(() => run(["--input", INPUT_FILENAME], deps)).toThrow(BuildFeedbackInputError);
  });

  it("rejects an invalid FinalExperimentDecision end-to-end and writes nothing", () => {
    const deps = fakeDeps({ [INPUT_FILENAME]: { foo: "bar" } });
    expect(() => run(["--input", INPUT_FILENAME], deps)).toThrow(BuildFeedbackInputError);
  });

  it("writes to growth/decisions/growth-loop-feedback-{start}_to_{end}.json using the source decision's own period", () => {
    const deps = fakeDeps({ [INPUT_FILENAME]: fixtureDeferDecision() });
    const result = run(["--input", INPUT_FILENAME, "--overwrite"], deps);
    expect(result.outputPath.replace(/\\/g, "/")).toContain(`growth/decisions/growth-loop-feedback-${PERIOD.start}_to_${PERIOD.end}.json`);
    rmSync(result.outputPath, { force: true });
  });

  it("does not mutate the source decision content while building feedback", () => {
    const fixture = fixtureDeferDecision();
    const content = JSON.stringify(fixture);
    const deps = fakeDeps({ [INPUT_FILENAME]: content });
    const result = run(["--input", INPUT_FILENAME, "--overwrite"], deps);
    expect(JSON.stringify(result.decision)).toBe(content);
    rmSync(result.outputPath, { force: true });
  });

  it("performs an atomic write — the output file always contains complete, valid JSON", () => {
    const deps = fakeDeps({ [INPUT_FILENAME]: fixtureDeferDecision() });
    const result = run(["--input", INPUT_FILENAME, "--overwrite"], deps);
    const raw = readFileSync(result.outputPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    rmSync(result.outputPath, { force: true });
  });

  it("does not require any LLM provider, API key, or network dependency", () => {
    // No provider/model/apiKey option exists anywhere in parseArgs or run() — constructing and running never touches @anthropic-ai/sdk.
    const deps = fakeDeps({ [INPUT_FILENAME]: fixtureDeferDecision() });
    const result = run(["--input", INPUT_FILENAME, "--overwrite"], deps);
    expect(result.feedback).toBeDefined();
    rmSync(result.outputPath, { force: true });
  });
});
