import { describe, expect, it } from "vitest";
import { MockSignalMiningProvider } from "../llm/mock-signal-mining-provider";
import type { ExistingContentCatalogEntry, SignalMiningLLMRequest, SignalSourceRecord } from "../types/signal-mining";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

const GA4_RECORD: SignalSourceRecord = {
  id: "sourcerecord_ga4",
  source: { type: "ga4", name: "GA4 traffic acquisition", recordId: "google/organic", url: null, publishedAt: null, retrievedAt: "2026-07-15T00:00:00.000Z", isInternal: true },
  title: "Traffic source: google / organic",
  content: "GA4 recorded 80 sessions.",
  entities: { keywords: [], topics: [], audiences: [], productsOrApps: ["orderly"], channels: ["google / organic"] },
  metrics: [{ name: "sessions", value: 80, unit: "count", measurementBasis: "x", period: null }],
  references: { evidenceRefs: [], findingRefs: [], limitationRefs: [] },
  quality: { confidence: "medium", limitations: [] },
};

const SEARCH_RECORD: SignalSourceRecord = {
  id: "sourcerecord_search",
  source: { type: "search_console", name: "Search Console queries", recordId: "inventory tracker", url: null, publishedAt: null, retrievedAt: "2026-07-15T00:00:00.000Z", isInternal: true },
  title: 'Search query: "inventory tracker"',
  content: "Search Console recorded 12 clicks.",
  entities: { keywords: ["inventory tracker"], topics: [], audiences: [], productsOrApps: [], channels: ["organic_search"] },
  metrics: [{ name: "clicks", value: 12, unit: "count", measurementBasis: "x", period: null }],
  references: { evidenceRefs: [], findingRefs: [], limitationRefs: [] },
  quality: { confidence: "medium", limitations: [] },
};

const FEEDBACK_RECORD: SignalSourceRecord = {
  id: "sourcerecord_feedback",
  source: { type: "growth_loop_feedback", name: "Growth Loop Feedback", recordId: "loopfeedback_1", url: null, publishedAt: null, retrievedAt: "2026-07-15T00:00:00.000Z", isInternal: true },
  title: "Feedback instruction (signal_mining): Collect more data.",
  content: "Collect more data. — This is a decision instruction, not a directly observed market signal.",
  entities: { keywords: [], topics: [], audiences: [], productsOrApps: [], channels: [] },
  metrics: [],
  references: { evidenceRefs: [], findingRefs: [], limitationRefs: [] },
  quality: { confidence: "low", limitations: ["Derived from a prior Experiment Decision instruction, not directly observed evidence."] },
};

const EXISTING_CONTENT: ExistingContentCatalogEntry[] = [
  { appSlug: "orderly", appName: "Orderly", hook: "Order tracker", status: "unknown", route: "/apps/orderly", availableCtaTypes: ["build", "copy_prompt"] },
];

function fixtureRequest(overrides: Partial<SignalMiningLLMRequest> = {}): SignalMiningLLMRequest {
  return {
    purpose: "purpose",
    campaign: CAMPAIGN,
    period: PERIOD,
    language: "en",
    sourceRecordCatalog: [GA4_RECORD, SEARCH_RECORD],
    existingContentCatalog: EXISTING_CONTENT,
    feedbackContext: null,
    dataQualityWarnings: [],
    reportingRules: [],
    responseSchemaDescription: "desc",
    maxTokens: 8000,
    systemPrompt: "SYSTEM",
    userPrompt: "USER",
    ...overrides,
  };
}

describe("MockSignalMiningProvider", () => {
  it("is named 'mock' and requires no API key or network call to construct/run", async () => {
    const provider = new MockSignalMiningProvider();
    expect(provider.name).toBe("mock");
    await expect(provider.generateStructuredSignals(fixtureRequest())).resolves.toBeDefined();
  });

  it("only cites sourceRecordRefs that exist in the supplied catalog", async () => {
    const provider = new MockSignalMiningProvider();
    const result = await provider.generateStructuredSignals(fixtureRequest());
    const knownIds = new Set(fixtureRequest().sourceRecordCatalog.map((r) => r.id));
    for (const proposal of result.data.signalProposals) {
      for (const ref of proposal.sourceRecordRefs) expect(knownIds.has(ref)).toBe(true);
    }
  });

  it("only cites signalProposalRefs that exist among its own signalProposals", async () => {
    const provider = new MockSignalMiningProvider();
    const result = await provider.generateStructuredSignals(fixtureRequest());
    const knownTempIds = new Set(result.data.signalProposals.map((p) => p.temporaryId));
    for (const cluster of result.data.topicClusters) {
      for (const ref of cluster.signalProposalRefs) expect(knownTempIds.has(ref)).toBe(true);
    }
  });

  it("only proposes related app slugs that exist in the supplied existing content catalog", async () => {
    const provider = new MockSignalMiningProvider();
    const result = await provider.generateStructuredSignals(fixtureRequest());
    for (const cluster of result.data.topicClusters) {
      for (const slug of cluster.relationshipToExistingContent.relatedAppSlugs) expect(slug).toBe("orderly");
    }
  });

  it("clusters the GA4 record (tied to 'orderly') as related_to 'existing'", async () => {
    const provider = new MockSignalMiningProvider();
    const result = await provider.generateStructuredSignals(fixtureRequest());
    const orderlyCluster = result.data.topicClusters.find((c) => c.relationshipToExistingContent.relatedAppSlugs.includes("orderly"));
    expect(orderlyCluster?.relationshipToExistingContent.status).toBe("existing");
  });

  it("never turns a growth_loop_feedback source record into a signal proposal on its own", async () => {
    const provider = new MockSignalMiningProvider();
    const result = await provider.generateStructuredSignals(fixtureRequest({ sourceRecordCatalog: [GA4_RECORD, FEEDBACK_RECORD] }));
    const citedFeedback = result.data.signalProposals.some((p) => p.sourceRecordRefs.includes(FEEDBACK_RECORD.id));
    expect(citedFeedback).toBe(false);
    expect(result.data.unresolvedSourceRecords.some((u) => u.sourceRecordRef === FEEDBACK_RECORD.id)).toBe(true);
  });

  it("adapts to an empty Search Console (no search-typed source records)", async () => {
    const provider = new MockSignalMiningProvider();
    const result = await provider.generateStructuredSignals(fixtureRequest({ sourceRecordCatalog: [GA4_RECORD] }));
    expect(result.data.signalProposals.every((p) => p.signalType !== "search_pattern")).toBe(true);
  });

  it("adapts to no feedback context supplied", async () => {
    const provider = new MockSignalMiningProvider();
    const result = await provider.generateStructuredSignals(fixtureRequest({ feedbackContext: null }));
    expect(result.data.analysisNotes.majorLimitations.some((l) => l.includes("mock-generated"))).toBe(false);
  });

  it("discloses mock feedback in analysisNotes when feedbackContext.isMock is true", async () => {
    const provider = new MockSignalMiningProvider();
    const result = await provider.generateStructuredSignals(
      fixtureRequest({
        feedbackContext: {
          sourceDecisionSha256: "h",
          decisionStatus: "defer",
          isMock: true,
          feedbackType: "collect_more_data",
          instructions: [],
          constraints: { allowedTopics: [], allowedCtaTypes: [], allowedChannels: [], mustCollectEvidence: true, mustNotClaim: [] },
        },
      })
    );
    expect(result.data.analysisNotes.majorLimitations.some((l) => l.toLowerCase().includes("mock"))).toBe(true);
  });

  it("adapts to absent manual input (nothing manual-typed in the catalog)", async () => {
    const provider = new MockSignalMiningProvider();
    const result = await provider.generateStructuredSignals(fixtureRequest({ sourceRecordCatalog: [GA4_RECORD, SEARCH_RECORD] }));
    expect(result.data.signalProposals.every((p) => p.signalType !== "manual_input")).toBe(true);
  });

  it("returns zero signals and zero topics when the source record catalog is empty", async () => {
    const provider = new MockSignalMiningProvider();
    const result = await provider.generateStructuredSignals(fixtureRequest({ sourceRecordCatalog: [] }));
    expect(result.data.signalProposals).toEqual([]);
    expect(result.data.topicClusters).toEqual([]);
  });

  it("always sets analysisNotes.requiresHumanReview to true", async () => {
    const provider = new MockSignalMiningProvider();
    const result = await provider.generateStructuredSignals(fixtureRequest());
    expect(result.data.analysisNotes.requiresHumanReview).toBe(true);
  });

  it("never invents a metric on a signal proposal beyond what its cited source records carry", async () => {
    const provider = new MockSignalMiningProvider();
    const result = await provider.generateStructuredSignals(fixtureRequest());
    // SignalProposal has no metrics field of its own — metrics only ever flow from cited source records at assembly time.
    for (const proposal of result.data.signalProposals) {
      expect((proposal as unknown as Record<string, unknown>).metrics).toBeUndefined();
    }
  });
});
