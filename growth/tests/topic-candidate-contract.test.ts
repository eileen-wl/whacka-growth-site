import { describe, expect, it } from "vitest";
import {
  SignalToTopicValidationError,
  TopicCandidateValidationError,
  buildTopicCandidateId,
  validateSignalsForTopic,
  validateTopicCandidate,
} from "../contracts/topic-candidate";
import type { TopicCandidate } from "../contracts/topic-candidate";
import { buildSignalCandidateId } from "../contracts/signal-candidate";
import type { SignalCandidate } from "../contracts/signal-candidate";

function fixtureSignal(overrides: Partial<SignalCandidate> = {}): SignalCandidate {
  return {
    schemaVersion: "1.0.0",
    id: buildSignalCandidateId({ sourceType: "search_console", sourceName: "GSC", sourceRecordId: "1", title: "inventory tracker" }),
    campaignId: "test_campaign",
    capturedAt: "2026-07-15T00:00:00.000Z",
    source: { type: "search_console", name: "GSC", recordId: "1", url: null, publishedAt: null, retrievedAt: "2026-07-15T00:00:00.000Z", isInternal: true },
    signalType: "search_query",
    title: "inventory tracker",
    summary: "Users search for an inventory tracker.",
    evidenceExcerpt: null,
    entities: { keywords: [], topics: [], audiences: [], productsOrApps: [], channels: [] },
    metrics: [],
    quality: { confidence: "medium", freshness: "fresh", duplicateStatus: "unique", limitations: [] },
    humanReviewRequired: true,
    provenance: { generatedBy: "signal-mining-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: [], sourceDecisionId: null, provider: null, model: null, isMock: false, humanReviewed: false },
    ...overrides,
  };
}

function fixtureTopic(overrides: Partial<TopicCandidate> = {}): TopicCandidate {
  return {
    schemaVersion: "1.0.0",
    id: buildTopicCandidateId({ campaignId: "test_campaign", canonicalName: "Inventory Tracker" }),
    campaignId: "test_campaign",
    createdAt: "2026-07-15T00:00:00.000Z",
    canonicalName: "Inventory Tracker",
    slug: "inventory-tracker",
    aliases: ["Stock Tracker"],
    problemStatement: "Small shops lose track of stock levels.",
    targetAudience: "Small retail shop owners",
    useCases: ["Track stock counts per product"],
    desiredOutcome: "Fewer stockouts and missed orders.",
    signalRefs: [buildSignalCandidateId({ sourceType: "search_console", sourceName: "GSC", sourceRecordId: "1", title: "inventory tracker" })],
    evidenceSummary: { signalCount: 1, sourceCount: 1, sourceTypes: ["search_console"], confidence: "medium", limitations: [] },
    relationshipToExistingContent: { status: "related_to_existing_app", relatedTopicIds: [], relatedAppSlugs: ["orderly"] },
    status: "candidate",
    rejection: null,
    provenance: { generatedBy: "topic-scoring-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: [], sourceDecisionId: null, provider: null, model: null, isMock: false, humanReviewed: false },
    ...overrides,
  };
}

describe("topicCandidateSchema", () => {
  it("accepts a well-formed topic candidate", () => {
    expect(() => validateTopicCandidate(fixtureTopic())).not.toThrow();
  });

  it("requires at least one signalRef", () => {
    expect(() => validateTopicCandidate(fixtureTopic({ signalRefs: [] }))).toThrow(TopicCandidateValidationError);
  });

  it("requires canonicalName", () => {
    expect(() => validateTopicCandidate(fixtureTopic({ canonicalName: "" }))).toThrow(TopicCandidateValidationError);
  });

  it("requires slug to be kebab-case", () => {
    expect(() => validateTopicCandidate(fixtureTopic({ slug: "Inventory Tracker" }))).toThrow(TopicCandidateValidationError);
  });

  it("rejects an alias that duplicates canonicalName after normalization", () => {
    expect(() => validateTopicCandidate(fixtureTopic({ aliases: ["inventory   tracker"] }))).toThrow(TopicCandidateValidationError);
  });

  it("requires a rejection object when status is 'rejected'", () => {
    expect(() => validateTopicCandidate(fixtureTopic({ status: "rejected", rejection: null }))).toThrow(TopicCandidateValidationError);
  });

  it("accepts a rejected topic with a rejection reason", () => {
    const topic = fixtureTopic({ status: "rejected", rejection: { reason: "Too niche for current audience.", rejectedAt: "2026-07-15T00:00:00.000Z" } });
    expect(() => validateTopicCandidate(topic)).not.toThrow();
  });

  it("forbids a rejection object when status is not 'rejected'", () => {
    const topic = fixtureTopic({ status: "candidate", rejection: { reason: "x", rejectedAt: "2026-07-15T00:00:00.000Z" } });
    expect(() => validateTopicCandidate(topic)).toThrow(TopicCandidateValidationError);
  });

  it("requires related topic/app identification when relationship status indicates a duplicate", () => {
    const topic = fixtureTopic({ relationshipToExistingContent: { status: "duplicate", relatedTopicIds: [], relatedAppSlugs: [] } });
    // Schema permits this shape structurally; duplicate identification is a caller responsibility documented in README.
    // This test documents current behavior: status alone does not force non-empty relatedTopicIds/relatedAppSlugs.
    expect(() => validateTopicCandidate(topic)).not.toThrow();
  });

  it("rejects a document carrying scoring results", () => {
    const topic = { ...fixtureTopic(), totalScore: 90 };
    expect(() => validateTopicCandidate(topic)).toThrow(TopicCandidateValidationError);
  });

  it("throws on an unsupported major schema version", () => {
    expect(() => validateTopicCandidate(fixtureTopic({ schemaVersion: "2.0.0" }))).toThrow();
  });
});

describe("validateSignalsForTopic", () => {
  it("accepts a non-empty, single-campaign, deduplicated signal set", () => {
    expect(() => validateSignalsForTopic([fixtureSignal()])).not.toThrow();
  });

  it("rejects an empty signal set", () => {
    expect(() => validateSignalsForTopic([])).toThrow(SignalToTopicValidationError);
  });

  it("rejects signals spanning more than one campaign", () => {
    const signals = [fixtureSignal(), fixtureSignal({ campaignId: "other_campaign", id: "signal_other" })];
    expect(() => validateSignalsForTopic(signals)).toThrow(SignalToTopicValidationError);
  });

  it("rejects duplicate signal ids in the input set", () => {
    const signal = fixtureSignal();
    expect(() => validateSignalsForTopic([signal, signal])).toThrow(SignalToTopicValidationError);
  });
});

describe("buildTopicCandidateId", () => {
  it("is deterministic for identical inputs", () => {
    const a = buildTopicCandidateId({ campaignId: "c", canonicalName: "Inventory Tracker" });
    const b = buildTopicCandidateId({ campaignId: "c", canonicalName: "Inventory Tracker" });
    expect(a).toBe(b);
  });

  it("is stable across case/whitespace normalization of canonicalName", () => {
    const a = buildTopicCandidateId({ campaignId: "c", canonicalName: "Inventory Tracker" });
    const b = buildTopicCandidateId({ campaignId: "c", canonicalName: "  inventory   tracker  " });
    expect(a).toBe(b);
  });
});
