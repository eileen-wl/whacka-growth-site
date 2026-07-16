import { describe, expect, it } from "vitest";
import { GrowthLoopFeedbackAdapter } from "../signal-sources/growth-loop-feedback-adapter";
import type { GrowthLoopFeedback } from "../contracts/loop-feedback";

const PERIOD = { start: "2026-07-08", end: "2026-07-14" };
const CAMPAIGN = { id: "test_campaign", name: "Test Campaign" };
const CONTEXT = { period: PERIOD, campaign: CAMPAIGN, now: "2026-07-15T00:00:00.000Z" };

function fixtureFeedback(overrides: Partial<GrowthLoopFeedback> = {}): GrowthLoopFeedback {
  return {
    schemaVersion: "1.0.0",
    id: "loopfeedback_abc123",
    createdAt: "2026-07-15T00:00:00.000Z",
    campaignId: CAMPAIGN.id,
    sourceDecision: {
      filename: "experiment-decision-2026-07-08_to_2026-07-14.json",
      sha256: "decision-hash",
      generatedAt: "2026-07-15T00:00:00.000Z",
      decisionStatus: "defer",
      isMock: false,
    },
    feedbackType: "collect_more_data",
    instructions: [
      {
        destination: "signal_mining",
        instruction: "Collect another full reporting period of GA4 traffic data.",
        topicOrApp: "orderly",
        ctaType: null,
        channel: null,
        evidenceRefs: ["traffic.sessions"],
        findingRefs: [],
        limitationRefs: ["data_limit.partial_data_quality"],
      },
    ],
    constraints: { allowedTopics: ["orderly"], allowedCtaTypes: ["build"], allowedChannels: ["organic_search"], mustCollectEvidence: true, mustNotClaim: [] },
    humanReview: { required: true, approved: false, approvedBy: null, approvedAt: null },
    ...overrides,
  };
}

describe("GrowthLoopFeedbackAdapter", () => {
  it("returns [] when feedback is null", async () => {
    const records = await new GrowthLoopFeedbackAdapter(null).collect(CONTEXT);
    expect(records).toEqual([]);
  });

  it("returns [] when feedback has zero instructions (e.g. no_action)", async () => {
    const feedback = fixtureFeedback({ feedbackType: "no_action", instructions: [] });
    const records = await new GrowthLoopFeedbackAdapter(feedback).collect(CONTEXT);
    expect(records).toEqual([]);
  });

  it("builds one record per instruction, always at low confidence", async () => {
    const records = await new GrowthLoopFeedbackAdapter(fixtureFeedback()).collect(CONTEXT);
    expect(records).toHaveLength(1);
    expect(records[0].quality.confidence).toBe("low");
    expect(records[0].source.type).toBe("growth_loop_feedback");
  });

  it("discloses that this is a prior decision instruction, not observed evidence", async () => {
    const records = await new GrowthLoopFeedbackAdapter(fixtureFeedback()).collect(CONTEXT);
    expect(records[0].content).toContain("not a directly observed market signal");
    expect(records[0].quality.limitations.some((l) => l.includes("not directly observed evidence"))).toBe(true);
  });

  it("adds an explicit mock disclosure when the source decision was mock-generated", async () => {
    const feedback = fixtureFeedback({ sourceDecision: { ...fixtureFeedback().sourceDecision, isMock: true } });
    const records = await new GrowthLoopFeedbackAdapter(feedback).collect(CONTEXT);
    expect(records[0].content).toContain("MOCK-GENERATED");
    expect(records[0].quality.limitations.some((l) => l.includes("mock-generated"))).toBe(true);
  });

  it("preserves evidenceRefs/findingRefs/limitationRefs from the instruction", async () => {
    const records = await new GrowthLoopFeedbackAdapter(fixtureFeedback()).collect(CONTEXT);
    expect(records[0].references.evidenceRefs).toEqual(["traffic.sessions"]);
    expect(records[0].references.limitationRefs).toEqual(["data_limit.partial_data_quality"]);
  });

  it("carries topicOrApp/channel through into entities", async () => {
    const records = await new GrowthLoopFeedbackAdapter(fixtureFeedback()).collect(CONTEXT);
    expect(records[0].entities.productsOrApps).toEqual(["orderly"]);
  });

  it("produces deterministic ids across repeated runs on the same feedback", async () => {
    const feedback = fixtureFeedback();
    const first = await new GrowthLoopFeedbackAdapter(feedback).collect(CONTEXT);
    const second = await new GrowthLoopFeedbackAdapter(feedback).collect(CONTEXT);
    expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
  });

  it("never assigns a metric to an instruction-derived record", async () => {
    const records = await new GrowthLoopFeedbackAdapter(fixtureFeedback()).collect(CONTEXT);
    expect(records[0].metrics).toEqual([]);
  });
});
