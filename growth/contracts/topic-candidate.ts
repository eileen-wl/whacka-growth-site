import { z } from "zod/v4";
import { deterministicId, slugify } from "../lib/ids";
import type { SignalCandidate } from "./signal-candidate";
import {
  assertSupportedMajorVersion,
  campaignIdSchema,
  confidenceSchema,
  isoTimestampSchema,
  provenanceSchema,
  refIdArraySchema,
  schemaVersionSchema,
} from "./common";

/**
 * TopicCandidate — step 2 output (Topic Scoring Agent's input material, built
 * from one or more SignalCandidates). A normalized, deduplicated potential
 * topic — still no score, no recommendation, no generated content.
 */

export const TOPIC_CANDIDATE_SUPPORTED_MAJOR_VERSION = 1;

export const topicStatusSchema = z.enum(["candidate", "needs_review", "rejected", "archived"]);

export const topicRejectionSchema = z.strictObject({
  reason: z.string().min(1).max(500),
  rejectedAt: isoTimestampSchema,
});

export type TopicRejection = z.infer<typeof topicRejectionSchema>;

export const topicEvidenceSummarySchema = z.strictObject({
  signalCount: z.number().int().min(1),
  sourceCount: z.number().int().min(1),
  sourceTypes: z.array(z.string().min(1).max(80)).min(1).max(30),
  confidence: confidenceSchema,
  limitations: z.array(z.string().min(1).max(500)).max(20),
});

export type TopicEvidenceSummary = z.infer<typeof topicEvidenceSummarySchema>;

export const topicRelationshipSchema = z.strictObject({
  status: z.enum(["new", "related_to_existing_topic", "related_to_existing_app", "duplicate"]),
  relatedTopicIds: z.array(z.string().min(1).max(160)).max(20),
  relatedAppSlugs: z.array(z.string().min(1).max(200)).max(20),
});

export type TopicRelationship = z.infer<typeof topicRelationshipSchema>;

export const topicCandidateSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: z.string().min(1).max(160),
    campaignId: campaignIdSchema,
    createdAt: isoTimestampSchema,
    canonicalName: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase kebab-case."),
    aliases: z.array(z.string().min(1).max(200)).max(20),
    problemStatement: z.string().min(1).max(1000),
    targetAudience: z.string().min(1).max(500),
    useCases: z.array(z.string().min(1).max(500)).max(20),
    desiredOutcome: z.string().min(1).max(500),
    signalRefs: refIdArraySchema.min(1),
    evidenceSummary: topicEvidenceSummarySchema,
    relationshipToExistingContent: topicRelationshipSchema,
    status: topicStatusSchema,
    rejection: z.union([topicRejectionSchema, z.null()]),
    provenance: provenanceSchema,
  })
  .refine((topic) => topic.status !== "rejected" || topic.rejection !== null, {
    message: "rejection is required when status is 'rejected'.",
    path: ["rejection"],
  })
  .refine((topic) => topic.status === "rejected" || topic.rejection === null, {
    message: "rejection must be null unless status is 'rejected'.",
    path: ["rejection"],
  })
  .refine(
    (topic) => {
      const canonical = slugify(topic.canonicalName);
      return !topic.aliases.some((alias) => slugify(alias) === canonical);
    },
    { message: "aliases must not duplicate canonicalName after normalization.", path: ["aliases"] }
  );

export type TopicCandidate = z.infer<typeof topicCandidateSchema>;

export class TopicCandidateValidationError extends Error {}

export function validateTopicCandidate(rawData: unknown): TopicCandidate {
  const result = topicCandidateSchema.safeParse(rawData);
  if (!result.success) {
    throw new TopicCandidateValidationError(`Invalid TopicCandidate: ${result.error.message}`);
  }
  assertSupportedMajorVersion("TopicCandidate", result.data.schemaVersion, TOPIC_CANDIDATE_SUPPORTED_MAJOR_VERSION);
  return result.data;
}

/** Deterministic identity: same campaign + same canonical slug always yields the same TopicCandidate id, so re-deriving from an overlapping signal set overwrites rather than duplicates. */
export function buildTopicCandidateId(args: { campaignId: string; canonicalName: string }): string {
  return deterministicId("topic", args.campaignId, slugify(args.canonicalName));
}

export class SignalToTopicValidationError extends Error {}

/**
 * Validates that `signals` are a non-empty, well-formed set of
 * SignalCandidates that could legitimately back a TopicCandidate — pure
 * input validation, not topic generation. It does NOT invent a topic; the
 * caller (Topic Scoring Agent, not in scope here) still decides the
 * canonicalName/problemStatement/etc.
 */
export function validateSignalsForTopic(signals: SignalCandidate[]): SignalCandidate[] {
  if (signals.length === 0) {
    throw new SignalToTopicValidationError("At least one SignalCandidate is required to build a TopicCandidate.");
  }
  const campaignIds = new Set(signals.map((signal) => signal.campaignId));
  if (campaignIds.size > 1) {
    throw new SignalToTopicValidationError(
      `All SignalCandidates backing one TopicCandidate must share a campaignId; found: ${[...campaignIds].join(", ")}.`
    );
  }
  const seenIds = new Set<string>();
  for (const signal of signals) {
    if (seenIds.has(signal.id)) {
      throw new SignalToTopicValidationError(`Duplicate SignalCandidate id in input set: ${signal.id}.`);
    }
    seenIds.add(signal.id);
  }
  return signals;
}
