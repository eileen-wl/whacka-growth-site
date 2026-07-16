import { z } from "zod/v4";
import { deterministicId } from "../lib/ids";
import type { FinalExperimentDecision } from "../types/experiment-decision";
import {
  assertSupportedMajorVersion,
  campaignIdSchema,
  humanReviewStateSchema,
  isoTimestampSchema,
  refIdArraySchema,
  safeFileNameSchema,
  schemaVersionSchema,
} from "./common";

/**
 * GrowthLoopFeedback — not a new Agent. This is the deterministic adapter
 * that lets step 8's output (FinalExperimentDecision) feed step 1/2's next
 * cycle (Signal Mining / Topic Pool), closing the loop. Built entirely by
 * `buildGrowthLoopFeedback()` below: no LLM call, no network call, no file
 * write, and nothing here invents a topic/CTA/channel/evidence/finding/
 * limitation that wasn't already present in the source decision.
 */

export const GROWTH_LOOP_FEEDBACK_SUPPORTED_MAJOR_VERSION = 1;

export const feedbackDestinationSchema = z.enum(["signal_mining", "topic_pool"]);

/** Matches growth/types/experiment-decision.ts's CtaType value set exactly. */
export const feedbackCtaTypeSchema = z.enum(["view_demo", "remix", "build", "copy_prompt"]);

export const feedbackTypeSchema = z.enum([
  "expand_topic",
  "revisit_topic",
  "test_cta",
  "review_channel",
  "collect_more_data",
  "no_action",
]);

export const feedbackInstructionSchema = z.strictObject({
  destination: feedbackDestinationSchema,
  instruction: z.string().min(1).max(1000),
  topicOrApp: z.union([z.string().min(1).max(200), z.null()]),
  ctaType: z.union([feedbackCtaTypeSchema, z.null()]),
  channel: z.union([z.string().min(1).max(200), z.null()]),
  evidenceRefs: refIdArraySchema,
  findingRefs: refIdArraySchema,
  limitationRefs: refIdArraySchema,
});

export type FeedbackInstruction = z.infer<typeof feedbackInstructionSchema>;

export const feedbackSourceDecisionSchema = z.strictObject({
  filename: safeFileNameSchema,
  sha256: z.string().min(1).max(128),
  generatedAt: isoTimestampSchema,
  decisionStatus: z.enum(["proceed", "defer"]),
  isMock: z.boolean(),
});

export type FeedbackSourceDecision = z.infer<typeof feedbackSourceDecisionSchema>;

export const feedbackConstraintsSchema = z.strictObject({
  allowedTopics: z.array(z.string().min(1).max(200)).max(50),
  allowedCtaTypes: z.array(feedbackCtaTypeSchema).max(10),
  allowedChannels: z.array(z.string().min(1).max(200)).max(50),
  mustCollectEvidence: z.boolean(),
  mustNotClaim: z.array(z.string().min(1).max(500)).max(20),
});

export type FeedbackConstraints = z.infer<typeof feedbackConstraintsSchema>;

export const growthLoopFeedbackSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: z.string().min(1).max(160),
  createdAt: isoTimestampSchema,
  campaignId: campaignIdSchema,
  sourceDecision: feedbackSourceDecisionSchema,
  feedbackType: feedbackTypeSchema,
  instructions: z.array(feedbackInstructionSchema).max(20),
  constraints: feedbackConstraintsSchema,
  humanReview: humanReviewStateSchema,
});

export type GrowthLoopFeedback = z.infer<typeof growthLoopFeedbackSchema>;

export class GrowthLoopFeedbackValidationError extends Error {}

export function validateGrowthLoopFeedback(rawData: unknown): GrowthLoopFeedback {
  const result = growthLoopFeedbackSchema.safeParse(rawData);
  if (!result.success) {
    throw new GrowthLoopFeedbackValidationError(`Invalid GrowthLoopFeedback: ${result.error.message}`);
  }
  assertSupportedMajorVersion("GrowthLoopFeedback", result.data.schemaVersion, GROWTH_LOOP_FEEDBACK_SUPPORTED_MAJOR_VERSION);
  return result.data;
}

// ---------------------------------------------------------------------------
// Deterministic ref classification
// ---------------------------------------------------------------------------

/**
 * Every ref array mixed together in `FinalExperimentDecision` (e.g.
 * `requiredNextObservations[].relatedEvidenceOrLimitationRefs`) is split back
 * into evidence/finding/limitation buckets using the catalog ID prefixes
 * already established by growth/agents/experiment-decision-agent.ts and
 * growth/agents/growth-report-agent.ts (`finding.*`, `data_limit.*`; anything
 * else is an evidence catalog ID). This is a read of an existing, stable
 * convention — not a new one invented here.
 */
function classifyRef(ref: string): "finding" | "limitation" | "evidence" {
  if (ref.startsWith("finding.")) return "finding";
  if (ref.startsWith("data_limit.")) return "limitation";
  return "evidence";
}

function splitRefs(refs: string[]): { evidenceRefs: string[]; findingRefs: string[]; limitationRefs: string[] } {
  const evidenceRefs: string[] = [];
  const findingRefs: string[] = [];
  const limitationRefs: string[] = [];
  for (const ref of refs) {
    const kind = classifyRef(ref);
    if (kind === "finding") findingRefs.push(ref);
    else if (kind === "limitation") limitationRefs.push(ref);
    else evidenceRefs.push(ref);
  }
  return { evidenceRefs, findingRefs, limitationRefs };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class GrowthLoopFeedbackBuildError extends Error {}

export interface BuildGrowthLoopFeedbackOptions {
  /** The decision's own output filename/hash — like `DecisionProvenance.sourceGrowthReportFilename`, the decision object doesn't know these about itself; they're assigned when written to disk. */
  sourceDecisionFilename: string;
  sourceDecisionSha256: string;
}

/**
 * Pure, deterministic FinalExperimentDecision -> GrowthLoopFeedback adapter.
 * No LLM call, no network call, no file write. Every topic/CTA/channel and
 * every evidence/finding/limitation reference in the output is copied
 * verbatim from the source decision — nothing here is invented.
 */
export function buildGrowthLoopFeedback(
  decision: FinalExperimentDecision,
  options: BuildGrowthLoopFeedbackOptions
): GrowthLoopFeedback {
  const decisionStatus = decision.decision.decisionSummary.decisionStatus;
  const instructions: FeedbackInstruction[] = [];

  // 1. Preserve every handoff item explicitly destined for Signal Mining or
  //    the Topic Pool (a handoff item aimed at asset_generation/manual_review
  //    is out of GrowthLoopFeedback's scope and intentionally dropped here,
  //    not lost — it stays in the source FinalExperimentDecision on disk).
  for (const item of decision.decision.handoff.forNextLoop) {
    if (item.destination !== "signal_mining" && item.destination !== "topic_pool") continue;
    instructions.push({
      destination: item.destination,
      instruction: `${item.item} — ${item.reason}`,
      topicOrApp: null,
      ctaType: null,
      channel: null,
      evidenceRefs: [],
      findingRefs: [],
      limitationRefs: [],
    });
  }

  let feedbackType: z.infer<typeof feedbackTypeSchema>;

  if (decisionStatus === "defer") {
    const deferDecision = decision.decision.deferDecision;
    if (!deferDecision) {
      throw new GrowthLoopFeedbackBuildError(
        "decisionStatus is 'defer' but decision.deferDecision is null — the source FinalExperimentDecision is inconsistent."
      );
    }
    for (const observation of deferDecision.requiredNextObservations) {
      const { evidenceRefs, findingRefs, limitationRefs } = splitRefs(observation.relatedEvidenceOrLimitationRefs);
      instructions.push({
        destination: "signal_mining",
        instruction: observation.observation,
        topicOrApp: null,
        ctaType: null,
        channel: null,
        evidenceRefs,
        findingRefs,
        limitationRefs,
      });
    }
    feedbackType = deferDecision.missingEvidence.length > 0 ? "collect_more_data" : "no_action";
  } else {
    const recommended = decision.decision.recommendedExperiment;
    if (!recommended) {
      throw new GrowthLoopFeedbackBuildError(
        "decisionStatus is 'proceed' but decision.recommendedExperiment is null — the source FinalExperimentDecision is inconsistent."
      );
    }
    const matchedOption = decision.decision.rankedExperimentOptions.find((option) => option.id === recommended.experimentId) ?? null;
    instructions.push({
      destination: "topic_pool",
      instruction: recommended.objective,
      topicOrApp: matchedOption?.target.topicOrApp ?? null,
      ctaType: matchedOption?.target.ctaType ?? null,
      channel: matchedOption?.target.channel ?? null,
      evidenceRefs: recommended.evidenceRefs,
      findingRefs: recommended.findingRefs,
      limitationRefs: [],
    });

    if (matchedOption?.lever === "cta") feedbackType = "test_cta";
    else if (matchedOption?.lever === "channel") feedbackType = "review_channel";
    else if (matchedOption?.lever === "topic") feedbackType = "expand_topic";
    else feedbackType = "revisit_topic";
  }

  if (instructions.length === 0) feedbackType = "no_action";

  // Guardrail text is reused verbatim from the decision's own limitation
  // catalog (only the entries actually cited by an instruction above) —
  // never freshly authored here.
  const citedLimitationIds = new Set(instructions.flatMap((instruction) => instruction.limitationRefs));
  const mustNotClaim = decision.limitationCatalog
    .filter((limitation) => citedLimitationIds.has(limitation.id))
    .map((limitation) => limitation.title);

  const feedback: GrowthLoopFeedback = {
    schemaVersion: "1.0.0",
    id: deterministicId("loopfeedback", decision.campaign.id, options.sourceDecisionSha256),
    createdAt: new Date().toISOString(),
    campaignId: decision.campaign.id,
    sourceDecision: {
      filename: options.sourceDecisionFilename,
      sha256: options.sourceDecisionSha256,
      generatedAt: decision.generatedAt,
      decisionStatus,
      isMock: decision.generation.isMock,
    },
    feedbackType,
    instructions,
    constraints: {
      allowedTopics: decision.decisionScope.availableTopics,
      allowedCtaTypes: decision.decisionScope.availableCtaTypes,
      allowedChannels: decision.decisionScope.availableChannels,
      mustCollectEvidence: feedbackType === "collect_more_data",
      mustNotClaim,
    },
    humanReview: { required: true, approved: false, approvedBy: null, approvedAt: null },
  };

  assertAllRefsExistInDecision(feedback, decision);

  return validateGrowthLoopFeedback(feedback);
}

/** Defensive check: every ref this adapter emitted must trace back to a catalog entry that actually exists in the source decision. Should never fire given the extraction logic above — it's a guard against future edits silently breaking that guarantee. */
function assertAllRefsExistInDecision(feedback: GrowthLoopFeedback, decision: FinalExperimentDecision): void {
  const evidenceIds = new Set(decision.evidenceCatalog.map((entry) => entry.id));
  const findingIds = new Set(decision.findingCatalog.map((entry) => entry.id));
  const limitationIds = new Set(decision.limitationCatalog.map((entry) => entry.id));

  for (const instruction of feedback.instructions) {
    for (const ref of instruction.evidenceRefs) {
      if (!evidenceIds.has(ref)) {
        throw new GrowthLoopFeedbackBuildError(`evidenceRef "${ref}" does not exist in the source decision's evidenceCatalog.`);
      }
    }
    for (const ref of instruction.findingRefs) {
      if (!findingIds.has(ref)) {
        throw new GrowthLoopFeedbackBuildError(`findingRef "${ref}" does not exist in the source decision's findingCatalog.`);
      }
    }
    for (const ref of instruction.limitationRefs) {
      if (!limitationIds.has(ref)) {
        throw new GrowthLoopFeedbackBuildError(`limitationRef "${ref}" does not exist in the source decision's limitationCatalog.`);
      }
    }
  }
}
