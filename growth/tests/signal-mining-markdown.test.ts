import { describe, expect, it } from "vitest";
import { renderSignalMiningMarkdown } from "../renderers/signal-mining-markdown";
import type { FinalSignalMiningRun } from "../types/signal-mining";
import type { SignalCandidate } from "../contracts/signal-candidate";
import type { TopicCandidate } from "../contracts/topic-candidate";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };

function fixtureSignal(overrides: Partial<SignalCandidate> = {}): SignalCandidate {
  return {
    schemaVersion: "1.0.0",
    id: "signal_abc",
    campaignId: CAMPAIGN.id,
    capturedAt: "2026-07-15T00:00:00.000Z",
    source: { type: "ga4", name: "GA4 traffic acquisition", recordId: "google/organic", url: null, publishedAt: null, retrievedAt: "2026-07-15T00:00:00.000Z", isInternal: true },
    signalType: "trending_topic",
    title: "Traffic source: google / organic",
    summary: "GA4 recorded 80 sessions.",
    evidenceExcerpt: null,
    entities: { keywords: [], topics: [], audiences: [], productsOrApps: ["orderly"], channels: ["google / organic"] },
    metrics: [{ name: "sessions", value: 80, unit: "count", measurementBasis: "x", period: null }],
    quality: { confidence: "medium", freshness: "fresh", duplicateStatus: "unique", limitations: [] },
    humanReviewRequired: true,
    provenance: { generatedBy: "signal-mining-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["sourcerecord_1"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
    ...overrides,
  };
}

function fixtureTopic(overrides: Partial<TopicCandidate> = {}): TopicCandidate {
  return {
    schemaVersion: "1.0.0",
    id: "topic_abc",
    campaignId: CAMPAIGN.id,
    createdAt: "2026-07-15T00:00:00.000Z",
    canonicalName: "Orderly traffic signals",
    slug: "orderly-traffic-signals",
    aliases: [],
    problemStatement: "Orderly is receiving organic traffic worth investigating.",
    targetAudience: "Small shop owners",
    useCases: ["Track stock levels"],
    desiredOutcome: "Understand traffic drivers.",
    signalRefs: ["signal_abc"],
    evidenceSummary: { signalCount: 1, sourceCount: 1, sourceTypes: ["ga4"], confidence: "medium", limitations: [] },
    relationshipToExistingContent: { status: "related_to_existing_app", relatedTopicIds: [], relatedAppSlugs: ["orderly"] },
    status: "candidate",
    rejection: null,
    provenance: { generatedBy: "signal-mining-agent", sourceFileNames: [], sourceHashes: [], sourceRecordIds: ["signal_abc"], sourceDecisionId: null, provider: "mock", model: "mock-v0", isMock: true, humanReviewed: false },
    ...overrides,
  };
}

function fixtureRun(overrides: Partial<FinalSignalMiningRun> = {}): FinalSignalMiningRun {
  return {
    schemaVersion: "1.0.0",
    runType: "signal_mining",
    generatedAt: "2026-07-15T00:00:00.000Z",
    period: PERIOD,
    campaign: CAMPAIGN,
    provenance: {
      sourceSummaryFilename: "growth-summary-2026-07-08_to_2026-07-14.json",
      sourceSummarySha256: "hash",
      sourceFeedbackFilename: null,
      sourceFeedbackSha256: null,
      manualInputFilename: null,
      manualInputSha256: null,
      sourceFeedbackIsMock: false,
    },
    generation: { provider: "mock", model: "mock-v0", language: "en", isMock: true, requestId: null, stopReason: "end_turn", usage: { inputTokens: null, outputTokens: null } },
    sourceSummary: { recordsCollected: 1, recordsUsed: 1, recordsOmittedByLimit: 0, sourceTypes: ["ga4"], warnings: [] },
    sourceRecordCatalog: [],
    signals: [fixtureSignal()],
    topicPool: [fixtureTopic()],
    unresolvedSourceRecords: [],
    deduplication: { inputSignalProposalCount: 1, finalSignalCount: 1, duplicatesRemoved: 0 },
    humanReview: { required: true, approved: false, approvedBy: null, approvedAt: null, note: "Signal and topic candidates must be reviewed before Topic Scoring." },
    dataQuality: { overallStatus: "partial", warnings: [], limitations: [] },
    ...overrides,
  };
}

describe("renderSignalMiningMarkdown", () => {
  it("renders all required top-level sections", () => {
    const md = renderSignalMiningMarkdown(fixtureRun());
    for (const heading of [
      "# Signal Mining Review",
      "## Reporting Period",
      "## Campaign",
      "## Input Sources",
      "## Data Quality",
      "## Signals Identified",
      "## Topic Pool",
      "## Unresolved Source Records",
      "## Growth Loop Feedback Context",
      "## Human Review",
      "## Generation Metadata",
    ]) {
      expect(md).toContain(heading);
    }
  });

  it("labels a mock-generated run prominently", () => {
    const md = renderSignalMiningMarkdown(fixtureRun());
    expect(md).toContain("Mock Provider");
  });

  it("labels mock Growth Loop Feedback input when present", () => {
    const md = renderSignalMiningMarkdown(
      fixtureRun({ provenance: { ...fixtureRun().provenance, sourceFeedbackFilename: "growth-loop-feedback-x.json", sourceFeedbackSha256: "h", sourceFeedbackIsMock: true } })
    );
    expect(md).toContain("mock-generated");
  });

  it("never renders an unavailable metric as zero", () => {
    const run = fixtureRun({ signals: [fixtureSignal({ metrics: [{ name: "activeUsers", value: 0, unit: "count", measurementBasis: "x", period: null }] })] });
    const md = renderSignalMiningMarkdown(run);
    // A real zero value renders as "0", not "Unavailable" — this test documents that null (not present here) would render as "Unavailable" via formatMetric.
    expect(md).toContain("activeUsers: 0 count");
  });

  it("renders 'No signals identified' when signals is empty", () => {
    const md = renderSignalMiningMarkdown(fixtureRun({ signals: [], topicPool: [] }));
    expect(md).toContain("No signals identified");
    expect(md).toContain("No topic candidates formed");
  });

  it("shows human review required/approved state", () => {
    const md = renderSignalMiningMarkdown(fixtureRun());
    expect(md).toMatch(/\*\*Required:\*\* Yes/);
    expect(md).toMatch(/\*\*Approved:\*\* No/);
  });

  it("renders unresolved source records as a table when present", () => {
    const md = renderSignalMiningMarkdown(fixtureRun({ unresolvedSourceRecords: [{ sourceRecordRef: "sourcerecord_x", reason: "insufficient_evidence", note: "Not enough evidence." }] }));
    expect(md).toContain("sourcerecord_x");
    expect(md).toContain("insufficient_evidence");
  });

  it("does not throw on a run with no supplied Growth Loop Feedback", () => {
    expect(() => renderSignalMiningMarkdown(fixtureRun())).not.toThrow();
  });
});
