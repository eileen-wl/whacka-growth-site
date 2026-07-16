import { describe, expect, it } from "vitest";
import {
  SignalMiningValidationError,
  applySourceRecordLimit,
  assembleSignalCandidates,
  assembleTopicCandidates,
  buildSignalMiningFeedbackContext,
  computeRecordVolume,
  runSignalMiningAgent,
  validateSignalMiningAnalysis,
} from "../agents/signal-mining-agent";
import { MockSignalMiningProvider } from "../llm/mock-signal-mining-provider";
import type { SignalMiningProvider } from "../llm/signal-mining-provider";
import type { GrowthLoopFeedback } from "../contracts/loop-feedback";
import type { ExistingContentCatalogEntry, SignalMiningAnalysis, SignalSourceRecord } from "../types/signal-mining";
import type { LLMStructuredResult } from "../types/llm";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureRecord(overrides: Partial<SignalSourceRecord> = {}): SignalSourceRecord {
  return {
    id: "sourcerecord_1",
    source: { type: "ga4", name: "GA4 traffic acquisition", recordId: "google/organic", url: null, publishedAt: null, retrievedAt: "2026-07-15T00:00:00.000Z", isInternal: true },
    title: "Traffic source: google / organic",
    content: "GA4 recorded 80 sessions.",
    entities: { keywords: [], topics: [], audiences: [], productsOrApps: ["orderly"], channels: ["google / organic"] },
    metrics: [{ name: "sessions", value: 80, unit: "count", measurementBasis: "x", period: null }],
    references: { evidenceRefs: [], findingRefs: [], limitationRefs: [] },
    quality: { confidence: "medium", limitations: [] },
    ...overrides,
  };
}

const EXISTING_CONTENT: ExistingContentCatalogEntry[] = [
  { appSlug: "orderly", appName: "Orderly", hook: "Order tracker", status: "unknown", route: "/apps/orderly", availableCtaTypes: ["build", "copy_prompt"] },
];

function fixtureAnalysis(overrides: Partial<SignalMiningAnalysis> = {}): SignalMiningAnalysis {
  return {
    signalProposals: [
      {
        temporaryId: "proposed_signal_1",
        signalType: "engagement_pattern",
        title: "Traffic source: google / organic",
        summary: "GA4 recorded 80 sessions.",
        evidenceExcerpt: null,
        sourceRecordRefs: ["sourcerecord_1"],
        entities: { keywords: [], topics: [], audiences: [], productsOrApps: ["orderly"], channels: ["google / organic"] },
        quality: { confidence: "medium", freshness: "current", limitations: [] },
      },
    ],
    topicClusters: [
      {
        temporaryId: "proposed_topic_1",
        canonicalName: "Orderly traffic signals",
        slugSuggestion: "orderly-traffic-signals",
        aliases: [],
        problemStatement: "Orderly is receiving organic traffic worth investigating.",
        targetAudience: ["Small shop owners"],
        useCases: ["Track stock levels"],
        desiredOutcome: "Understand what's driving traffic to Orderly.",
        signalProposalRefs: ["proposed_signal_1"],
        relationshipToExistingContent: { status: "existing", relatedAppSlugs: ["orderly"] },
        confidence: "medium",
        limitations: [],
      },
    ],
    unresolvedSourceRecords: [],
    analysisNotes: { sourceCoverage: "1 of 1 records used.", majorLimitations: [], requiresHumanReview: true },
    ...overrides,
  };
}

class FakeProvider implements SignalMiningProvider {
  readonly name: string;
  constructor(
    private readonly analysis: SignalMiningAnalysis,
    name = "fake"
  ) {
    this.name = name;
  }
  async generateStructuredSignals(): Promise<LLMStructuredResult<SignalMiningAnalysis>> {
    return { data: this.analysis, provider: this.name, model: "fake-model", requestId: null, stopReason: "end_turn", inputTokens: null, outputTokens: null };
  }
}

describe("applySourceRecordLimit", () => {
  it("keeps every record when under the limit", () => {
    const result = applySourceRecordLimit([fixtureRecord()], 100);
    expect(result.used).toHaveLength(1);
    expect(result.omittedCount).toBe(0);
  });

  it("selects higher-volume records deterministically and reports the omitted count", () => {
    const low = fixtureRecord({ id: "a", metrics: [{ name: "sessions", value: 1, unit: "count", measurementBasis: "x", period: null }] });
    const high = fixtureRecord({ id: "b", metrics: [{ name: "sessions", value: 99, unit: "count", measurementBasis: "x", period: null }] });
    const result = applySourceRecordLimit([low, high], 1);
    expect(result.used).toEqual([high]);
    expect(result.omittedCount).toBe(1);
  });

  it("breaks ties by id ascending, for determinism", () => {
    const a = fixtureRecord({ id: "b", metrics: [] });
    const b = fixtureRecord({ id: "a", metrics: [] });
    const result = applySourceRecordLimit([a, b], 1);
    expect(result.used).toEqual([b]);
  });
});

describe("computeRecordVolume", () => {
  it("sums the absolute value of every metric", () => {
    const record = fixtureRecord({ metrics: [{ name: "a", value: -3, unit: null, measurementBasis: "x", period: null }, { name: "b", value: 5, unit: null, measurementBasis: "x", period: null }] });
    expect(computeRecordVolume(record)).toBe(8);
  });
});

describe("buildSignalMiningFeedbackContext", () => {
  it("returns null when feedback is null", () => {
    expect(buildSignalMiningFeedbackContext(null)).toBeNull();
  });

  it("preserves constraints and strips refs from instructions (context, not citable evidence)", () => {
    const feedback: GrowthLoopFeedback = {
      schemaVersion: "1.0.0",
      id: "loopfeedback_1",
      createdAt: "2026-07-15T00:00:00.000Z",
      campaignId: CAMPAIGN.id,
      sourceDecision: { filename: "experiment-decision-x.json", sha256: "hash", generatedAt: "2026-07-15T00:00:00.000Z", decisionStatus: "proceed", isMock: false },
      feedbackType: "test_cta",
      instructions: [{ destination: "topic_pool", instruction: "Test the build CTA.", topicOrApp: "orderly", ctaType: "build", channel: null, evidenceRefs: ["e1"], findingRefs: [], limitationRefs: [] }],
      constraints: { allowedTopics: ["orderly"], allowedCtaTypes: ["build"], allowedChannels: [], mustCollectEvidence: false, mustNotClaim: [] },
      humanReview: { required: true, approved: false, approvedBy: null, approvedAt: null },
    };
    const context = buildSignalMiningFeedbackContext(feedback);
    expect(context?.isMock).toBe(false);
    expect(context?.constraints.allowedTopics).toEqual(["orderly"]);
    expect(context?.instructions[0]).toEqual({ destination: "topic_pool", instruction: "Test the build CTA.", topicOrApp: "orderly", ctaType: "build", channel: null });
  });
});

describe("validateSignalMiningAnalysis", () => {
  it("accepts a well-formed analysis", () => {
    expect(() => validateSignalMiningAnalysis(fixtureAnalysis(), [fixtureRecord()], EXISTING_CONTENT)).not.toThrow();
  });

  it("rejects an unknown sourceRecordRef", () => {
    const analysis = fixtureAnalysis();
    analysis.signalProposals[0].sourceRecordRefs = ["nonexistent"];
    expect(() => validateSignalMiningAnalysis(analysis, [fixtureRecord()], EXISTING_CONTENT)).toThrow(SignalMiningValidationError);
  });

  it("rejects a duplicate signalProposals.temporaryId", () => {
    const analysis = fixtureAnalysis();
    analysis.signalProposals.push({ ...analysis.signalProposals[0] });
    expect(() => validateSignalMiningAnalysis(analysis, [fixtureRecord()], EXISTING_CONTENT)).toThrow(/Duplicate signalProposals/);
  });

  it("rejects a duplicate topicClusters.temporaryId", () => {
    const analysis = fixtureAnalysis();
    analysis.topicClusters.push({ ...analysis.topicClusters[0] });
    expect(() => validateSignalMiningAnalysis(analysis, [fixtureRecord()], EXISTING_CONTENT)).toThrow(/Duplicate topicClusters/);
  });

  it("rejects an unknown signalProposalRef in a topic cluster", () => {
    const analysis = fixtureAnalysis();
    analysis.topicClusters[0].signalProposalRefs = ["nonexistent_signal"];
    expect(() => validateSignalMiningAnalysis(analysis, [fixtureRecord()], EXISTING_CONTENT)).toThrow(/unknown signalProposalRef/);
  });

  it("rejects an unknown app slug", () => {
    const analysis = fixtureAnalysis();
    analysis.topicClusters[0].relationshipToExistingContent.relatedAppSlugs = ["not-a-real-app"];
    expect(() => validateSignalMiningAnalysis(analysis, [fixtureRecord()], EXISTING_CONTENT)).toThrow(/unknown app slug/);
  });

  it("rejects an unresolvedSourceRecords entry referencing an unknown record", () => {
    const analysis = fixtureAnalysis({ unresolvedSourceRecords: [{ sourceRecordRef: "nonexistent", reason: "irrelevant", note: "x" }] });
    expect(() => validateSignalMiningAnalysis(analysis, [fixtureRecord()], EXISTING_CONTENT)).toThrow(SignalMiningValidationError);
  });

  it("rejects an unknown top-level key (e.g. a smuggled scoring field)", () => {
    const raw = { ...fixtureAnalysis(), totalScore: 90 };
    expect(() => validateSignalMiningAnalysis(raw, [fixtureRecord()], EXISTING_CONTENT)).toThrow(SignalMiningValidationError);
  });

  it("accepts zero signals and zero topics", () => {
    const analysis = fixtureAnalysis({ signalProposals: [], topicClusters: [] });
    expect(() => validateSignalMiningAnalysis(analysis, [fixtureRecord()], EXISTING_CONTENT)).not.toThrow();
  });
});

describe("assembleSignalCandidates", () => {
  const provenance = { sourceFileNames: ["growth-summary-x.json"], sourceHashes: ["hash1"], provider: "mock", model: "mock-v0", isMock: true };

  it("builds a valid SignalCandidate with a deterministic id", () => {
    const analysis = fixtureAnalysis();
    const result = assembleSignalCandidates({ analysis, sourceRecordCatalog: [fixtureRecord()], campaignId: CAMPAIGN.id, capturedAt: "2026-07-15T00:00:00.000Z", feedbackId: null, provenance });
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].id).toMatch(/^signal_/);
    expect(result.signals[0].campaignId).toBe(CAMPAIGN.id);
  });

  it("copies metrics only from the cited source record", () => {
    const analysis = fixtureAnalysis();
    const result = assembleSignalCandidates({ analysis, sourceRecordCatalog: [fixtureRecord()], campaignId: CAMPAIGN.id, capturedAt: "2026-07-15T00:00:00.000Z", feedbackId: null, provenance });
    expect(result.signals[0].metrics).toEqual([{ name: "sessions", value: 80, unit: "count", measurementBasis: "x", period: null }]);
  });

  it("preserves multi-source provenance without losing any individual source id", () => {
    const recordA = fixtureRecord({ id: "a", source: { ...fixtureRecord().source, name: "Source A" } });
    const recordB = fixtureRecord({ id: "b", source: { ...fixtureRecord().source, name: "Source B" } });
    const analysis = fixtureAnalysis();
    analysis.signalProposals[0].sourceRecordRefs = ["a", "b"];
    const result = assembleSignalCandidates({ analysis, sourceRecordCatalog: [recordA, recordB], campaignId: CAMPAIGN.id, capturedAt: "2026-07-15T00:00:00.000Z", feedbackId: null, provenance });
    expect(result.signals[0].provenance.sourceRecordIds.sort()).toEqual(["a", "b"]);
    expect(result.signals[0].source.name).toContain("Source A");
    expect(result.signals[0].source.name).toContain("Source B");
  });

  it("removes exact duplicate proposals (identical sorted source-record-ref sets) and records the count", () => {
    const analysis = fixtureAnalysis();
    analysis.signalProposals.push({ ...analysis.signalProposals[0], temporaryId: "proposed_signal_2" });
    const result = assembleSignalCandidates({ analysis, sourceRecordCatalog: [fixtureRecord()], campaignId: CAMPAIGN.id, capturedAt: "2026-07-15T00:00:00.000Z", feedbackId: null, provenance });
    expect(result.signals).toHaveLength(1);
    expect(result.duplicatesRemoved).toBe(1);
    expect(result.inputSignalProposalCount).toBe(2);
    expect(result.temporaryIdToFinalId.get("proposed_signal_1")).toBe(result.temporaryIdToFinalId.get("proposed_signal_2"));
  });

  it("maps a signal citing a growth_loop_feedback record's sourceDecisionId through provenance", () => {
    const feedbackRecord = fixtureRecord({ id: "sourcerecord_feedback", source: { ...fixtureRecord().source, type: "growth_loop_feedback", name: "Growth Loop Feedback" }, metrics: [] });
    const analysis = fixtureAnalysis();
    analysis.signalProposals[0].sourceRecordRefs = ["sourcerecord_1", "sourcerecord_feedback"];
    const result = assembleSignalCandidates({
      analysis,
      sourceRecordCatalog: [fixtureRecord(), feedbackRecord],
      campaignId: CAMPAIGN.id,
      capturedAt: "2026-07-15T00:00:00.000Z",
      feedbackId: "loopfeedback_1",
      provenance,
    });
    expect(result.signals[0].provenance.sourceDecisionId).toBe("loopfeedback_1");
  });

  it("does not mutate the input analysis", () => {
    const analysis = fixtureAnalysis();
    const before = JSON.stringify(analysis);
    assembleSignalCandidates({ analysis, sourceRecordCatalog: [fixtureRecord()], campaignId: CAMPAIGN.id, capturedAt: "2026-07-15T00:00:00.000Z", feedbackId: null, provenance });
    expect(JSON.stringify(analysis)).toBe(before);
  });
});

describe("assembleTopicCandidates", () => {
  const provenance = { sourceFileNames: [], sourceHashes: [], provider: "mock", model: "mock-v0", isMock: true };

  it("resolves signalProposalRefs to final SignalCandidate ids", () => {
    const analysis = fixtureAnalysis();
    const signalResult = assembleSignalCandidates({ analysis, sourceRecordCatalog: [fixtureRecord()], campaignId: CAMPAIGN.id, capturedAt: "2026-07-15T00:00:00.000Z", feedbackId: null, provenance });
    const signalsById = new Map(signalResult.signals.map((s) => [s.id, s]));
    const sourceRecordsById = new Map([[fixtureRecord().id, fixtureRecord()]]);
    const topics = assembleTopicCandidates({ analysis, temporaryIdToFinalId: signalResult.temporaryIdToFinalId, signalsById, sourceRecordsById, campaignId: CAMPAIGN.id, createdAt: "2026-07-15T00:00:00.000Z", provenance });
    expect(topics).toHaveLength(1);
    expect(topics[0].signalRefs).toEqual([signalResult.signals[0].id]);
  });

  it("maps mining relationship status onto the contract's status enum", () => {
    const analysis = fixtureAnalysis();
    const signalResult = assembleSignalCandidates({ analysis, sourceRecordCatalog: [fixtureRecord()], campaignId: CAMPAIGN.id, capturedAt: "2026-07-15T00:00:00.000Z", feedbackId: null, provenance });
    const signalsById = new Map(signalResult.signals.map((s) => [s.id, s]));
    const sourceRecordsById = new Map([[fixtureRecord().id, fixtureRecord()]]);
    const topics = assembleTopicCandidates({ analysis, temporaryIdToFinalId: signalResult.temporaryIdToFinalId, signalsById, sourceRecordsById, campaignId: CAMPAIGN.id, createdAt: "2026-07-15T00:00:00.000Z", provenance });
    expect(topics[0].relationshipToExistingContent.status).toBe("related_to_existing_app");
  });

  it("marks status as 'needs_review' when confidence is low", () => {
    const analysis = fixtureAnalysis();
    analysis.topicClusters[0].confidence = "low";
    const signalResult = assembleSignalCandidates({ analysis, sourceRecordCatalog: [fixtureRecord()], campaignId: CAMPAIGN.id, capturedAt: "2026-07-15T00:00:00.000Z", feedbackId: null, provenance });
    const signalsById = new Map(signalResult.signals.map((s) => [s.id, s]));
    const sourceRecordsById = new Map([[fixtureRecord().id, fixtureRecord()]]);
    const topics = assembleTopicCandidates({ analysis, temporaryIdToFinalId: signalResult.temporaryIdToFinalId, signalsById, sourceRecordsById, campaignId: CAMPAIGN.id, createdAt: "2026-07-15T00:00:00.000Z", provenance });
    expect(topics[0].status).toBe("needs_review");
  });

  it("marks status as 'candidate' when confidence is not low and relationship is 'existing'", () => {
    const analysis = fixtureAnalysis();
    const signalResult = assembleSignalCandidates({ analysis, sourceRecordCatalog: [fixtureRecord()], campaignId: CAMPAIGN.id, capturedAt: "2026-07-15T00:00:00.000Z", feedbackId: null, provenance });
    const signalsById = new Map(signalResult.signals.map((s) => [s.id, s]));
    const sourceRecordsById = new Map([[fixtureRecord().id, fixtureRecord()]]);
    const topics = assembleTopicCandidates({ analysis, temporaryIdToFinalId: signalResult.temporaryIdToFinalId, signalsById, sourceRecordsById, campaignId: CAMPAIGN.id, createdAt: "2026-07-15T00:00:00.000Z", provenance });
    expect(topics[0].status).toBe("candidate");
  });

  it("never assigns 'rejected' or 'archived' automatically", () => {
    const analysis = fixtureAnalysis();
    const signalResult = assembleSignalCandidates({ analysis, sourceRecordCatalog: [fixtureRecord()], campaignId: CAMPAIGN.id, capturedAt: "2026-07-15T00:00:00.000Z", feedbackId: null, provenance });
    const signalsById = new Map(signalResult.signals.map((s) => [s.id, s]));
    const sourceRecordsById = new Map([[fixtureRecord().id, fixtureRecord()]]);
    const topics = assembleTopicCandidates({ analysis, temporaryIdToFinalId: signalResult.temporaryIdToFinalId, signalsById, sourceRecordsById, campaignId: CAMPAIGN.id, createdAt: "2026-07-15T00:00:00.000Z", provenance });
    expect(["candidate", "needs_review"]).toContain(topics[0].status);
    expect(topics[0].rejection).toBeNull();
  });
});

describe("runSignalMiningAgent — end to end", () => {
  const baseParams = {
    campaign: CAMPAIGN,
    period: PERIOD,
    language: "en" as const,
    maxTokens: 8000,
    maxSourceRecords: 100,
    existingContentCatalog: EXISTING_CONTENT,
    feedback: null,
    dataQualityWarnings: [] as string[],
    dataQualityStatus: "partial" as const,
    provenance: { sourceSummaryFilename: "growth-summary-x.json", sourceSummarySha256: "hash", sourceFeedbackFilename: null, sourceFeedbackSha256: null, manualInputFilename: null, manualInputSha256: null },
    generatedAt: "2026-07-15T00:00:00.000Z",
  };

  it("produces a valid FinalSignalMiningRun with valid SignalCandidate/TopicCandidate contracts", async () => {
    const run = await runSignalMiningAgent({ ...baseParams, provider: new FakeProvider(fixtureAnalysis()), sourceRecordCatalog: [fixtureRecord()] });
    expect(run.schemaVersion).toBe("1.0.0");
    expect(run.runType).toBe("signal_mining");
    expect(run.signals).toHaveLength(1);
    expect(run.topicPool).toHaveLength(1);
    expect(run.topicPool[0].signalRefs.every((ref) => run.signals.some((s) => s.id === ref))).toBe(true);
  });

  it("always requires human review and defaults approved to false", async () => {
    const run = await runSignalMiningAgent({ ...baseParams, provider: new FakeProvider(fixtureAnalysis()), sourceRecordCatalog: [fixtureRecord()] });
    expect(run.humanReview).toEqual({ required: true, approved: false, approvedBy: null, approvedAt: null, note: expect.any(String) });
  });

  it("marks generation.isMock true for the mock provider and false for any other provider name", async () => {
    const mockRun = await runSignalMiningAgent({ ...baseParams, provider: new MockSignalMiningProvider(), sourceRecordCatalog: [fixtureRecord()] });
    expect(mockRun.generation.isMock).toBe(true);
    const fakeRun = await runSignalMiningAgent({ ...baseParams, provider: new FakeProvider(fixtureAnalysis(), "anthropic"), sourceRecordCatalog: [fixtureRecord()] });
    expect(fakeRun.generation.isMock).toBe(false);
  });

  it("is valid with zero topics when the provider reports zero signals and zero clusters", async () => {
    const emptyAnalysis = fixtureAnalysis({ signalProposals: [], topicClusters: [] });
    const run = await runSignalMiningAgent({ ...baseParams, provider: new FakeProvider(emptyAnalysis), sourceRecordCatalog: [fixtureRecord()] });
    expect(run.signals).toEqual([]);
    expect(run.topicPool).toEqual([]);
  });

  it("applies the source record limit and records recordsOmittedByLimit", async () => {
    const many = Array.from({ length: 5 }, (_, i) => fixtureRecord({ id: `r${i}`, metrics: [{ name: "sessions", value: i, unit: "count", measurementBasis: "x", period: null }] }));
    const emptyAnalysis = fixtureAnalysis({ signalProposals: [], topicClusters: [] });
    const run = await runSignalMiningAgent({ ...baseParams, provider: new FakeProvider(emptyAnalysis), sourceRecordCatalog: many, maxSourceRecords: 2 });
    expect(run.sourceSummary.recordsCollected).toBe(5);
    expect(run.sourceSummary.recordsUsed).toBe(2);
    expect(run.sourceSummary.recordsOmittedByLimit).toBe(3);
  });

  it("does not mutate the input sourceRecordCatalog array", async () => {
    const records = [fixtureRecord()];
    const before = JSON.stringify(records);
    await runSignalMiningAgent({ ...baseParams, provider: new FakeProvider(fixtureAnalysis()), sourceRecordCatalog: records });
    expect(JSON.stringify(records)).toBe(before);
  });

  it("throws SignalMiningValidationError and produces no run when the provider response is invalid", async () => {
    const invalidAnalysis = { ...fixtureAnalysis(), totalScore: 90 } as unknown as SignalMiningAnalysis;
    await expect(runSignalMiningAgent({ ...baseParams, provider: new FakeProvider(invalidAnalysis), sourceRecordCatalog: [fixtureRecord()] })).rejects.toThrow(SignalMiningValidationError);
  });
});
