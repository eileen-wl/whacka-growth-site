import { describe, expect, it } from "vitest";
import {
  SignalCandidateValidationError,
  buildSignalCandidateId,
  signalCandidateSchema,
  validateSignalCandidate,
} from "../contracts/signal-candidate";
import type { SignalCandidate } from "../contracts/signal-candidate";

function fixtureSignal(overrides: Partial<SignalCandidate> = {}): SignalCandidate {
  return {
    schemaVersion: "1.0.0",
    id: buildSignalCandidateId({
      sourceType: "search_console",
      sourceName: "Google Search Console",
      sourceRecordId: "query-1",
      title: "inventory tracker for small shop",
    }),
    campaignId: "test_campaign",
    capturedAt: "2026-07-15T00:00:00.000Z",
    source: {
      type: "search_console",
      name: "Google Search Console",
      recordId: "query-1",
      url: null,
      publishedAt: null,
      retrievedAt: "2026-07-15T00:00:00.000Z",
      isInternal: true,
    },
    signalType: "search_query",
    title: "inventory tracker for small shop",
    summary: "Users are searching for a simple inventory tracker for small shops.",
    evidenceExcerpt: null,
    entities: { keywords: ["inventory tracker"], topics: [], audiences: [], productsOrApps: [], channels: [] },
    metrics: [{ name: "impressions", value: 120, unit: "count", measurementBasis: "GSC daily_overview sum", period: "2026-07-08_to_2026-07-14" }],
    quality: { confidence: "medium", freshness: "fresh", duplicateStatus: "unique", limitations: [] },
    humanReviewRequired: true,
    provenance: {
      generatedBy: "signal-mining-agent",
      sourceFileNames: ["gsc-queries-2026-07-08_to_2026-07-14.json"],
      sourceHashes: [],
      sourceRecordIds: ["query-1"],
      sourceDecisionId: null,
      provider: null,
      model: null,
      isMock: false,
      humanReviewed: false,
    },
    ...overrides,
  };
}

describe("signalCandidateSchema", () => {
  it("accepts a well-formed signal candidate", () => {
    expect(() => validateSignalCandidate(fixtureSignal())).not.toThrow();
  });

  it("rejects an empty title", () => {
    expect(() => validateSignalCandidate(fixtureSignal({ title: "" }))).toThrow(SignalCandidateValidationError);
  });

  it("rejects an empty summary", () => {
    expect(() => validateSignalCandidate(fixtureSignal({ summary: "" }))).toThrow(SignalCandidateValidationError);
  });

  it("allows evidenceExcerpt to be null", () => {
    expect(() => validateSignalCandidate(fixtureSignal({ evidenceExcerpt: null }))).not.toThrow();
  });

  it("allows an empty metrics array", () => {
    expect(() => validateSignalCandidate(fixtureSignal({ metrics: [] }))).not.toThrow();
  });

  it("accepts a metric value of exactly zero", () => {
    const signal = fixtureSignal({
      metrics: [{ name: "clicks", value: 0, unit: "count", measurementBasis: "GSC daily_overview sum", period: null }],
    });
    const validated = validateSignalCandidate(signal);
    expect(validated.metrics[0].value).toBe(0);
  });

  it("rejects a non-numeric metric value", () => {
    const signal = fixtureSignal();
    const raw = { ...signal, metrics: [{ name: "clicks", value: "5" as unknown as number, unit: null, measurementBasis: "x", period: null }] };
    expect(() => validateSignalCandidate(raw)).toThrow(SignalCandidateValidationError);
  });

  it("rejects an invalid URL when source.url is present", () => {
    const signal = fixtureSignal({ source: { ...fixtureSignal().source, url: "not-a-url" as unknown as null } });
    expect(() => validateSignalCandidate(signal)).toThrow(SignalCandidateValidationError);
  });

  it("accepts a valid URL when source.url is present", () => {
    const signal = fixtureSignal({ source: { ...fixtureSignal().source, url: "https://example.com/page" } });
    expect(() => validateSignalCandidate(signal)).not.toThrow();
  });

  it("supports the 'other' source type extensibility mechanism when source.name is specific", () => {
    const signal = fixtureSignal({ source: { ...fixtureSignal().source, type: "other", name: "New Analytics Platform" } });
    expect(() => validateSignalCandidate(signal)).not.toThrow();
  });

  it("rejects the 'other' source type when source.name is empty", () => {
    const signal = fixtureSignal({ source: { ...fixtureSignal().source, type: "other", name: "" } });
    expect(() => validateSignalCandidate(signal)).toThrow(SignalCandidateValidationError);
  });

  it("accepts a low-confidence signal as still valid", () => {
    const signal = fixtureSignal({ quality: { confidence: "low", freshness: "stale", duplicateStatus: "possible_duplicate", limitations: ["small sample size"] } });
    expect(() => validateSignalCandidate(signal)).not.toThrow();
  });

  it("rejects unknown top-level keys", () => {
    const signal = { ...fixtureSignal(), score: 42 };
    expect(() => validateSignalCandidate(signal)).toThrow(SignalCandidateValidationError);
  });

  it("rejects a document that carries a final topic score", () => {
    const signal = { ...fixtureSignal(), totalScore: 88 };
    expect(() => validateSignalCandidate(signal)).toThrow(SignalCandidateValidationError);
  });

  it("rejects credentials smuggled into provenance", () => {
    const signal = { ...fixtureSignal(), provenance: { ...fixtureSignal().provenance, apiKey: "sk-test" } };
    expect(() => validateSignalCandidate(signal)).toThrow(SignalCandidateValidationError);
  });

  it("rejects an absolute local path in sourceFileNames", () => {
    const signal = fixtureSignal({ provenance: { ...fixtureSignal().provenance, sourceFileNames: ["C:\\Users\\me\\data.json"] } });
    expect(() => validateSignalCandidate(signal)).toThrow(SignalCandidateValidationError);
  });

  it("throws on an unsupported major schema version", () => {
    const signal = fixtureSignal({ schemaVersion: "2.0.0" });
    expect(() => validateSignalCandidate(signal)).toThrow();
  });

  it("accepts a forward-compatible minor version bump", () => {
    const signal = fixtureSignal({ schemaVersion: "1.1.0" });
    expect(() => validateSignalCandidate(signal)).not.toThrow();
  });

  it("directly exposes the zod schema for callers that want safeParse", () => {
    const result = signalCandidateSchema.safeParse(fixtureSignal());
    expect(result.success).toBe(true);
  });
});

describe("buildSignalCandidateId", () => {
  it("is deterministic for identical inputs", () => {
    const a = buildSignalCandidateId({ sourceType: "posthog", sourceName: "PostHog", sourceRecordId: "1", title: "x" });
    const b = buildSignalCandidateId({ sourceType: "posthog", sourceName: "PostHog", sourceRecordId: "1", title: "x" });
    expect(a).toBe(b);
  });

  it("differs when the title differs", () => {
    const a = buildSignalCandidateId({ sourceType: "posthog", sourceName: "PostHog", sourceRecordId: "1", title: "x" });
    const b = buildSignalCandidateId({ sourceType: "posthog", sourceName: "PostHog", sourceRecordId: "1", title: "y" });
    expect(a).not.toBe(b);
  });

  it("does not depend on capturedAt (not part of the function's inputs)", () => {
    const id1 = buildSignalCandidateId({ sourceType: "ga4", sourceName: "GA4", sourceRecordId: null, title: "same" });
    const id2 = buildSignalCandidateId({ sourceType: "ga4", sourceName: "GA4", sourceRecordId: null, title: "same" });
    expect(id1).toBe(id2);
  });
});
