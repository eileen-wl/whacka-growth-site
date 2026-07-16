import { z } from "zod/v4";
import { deterministicId } from "../lib/ids";
import {
  campaignIdSchema,
  confidenceSchema,
  humanReviewRequiredFlagSchema,
  isoTimestampSchema,
  provenanceSchema,
  refIdArraySchema,
  schemaVersionSchema,
  assertSupportedMajorVersion,
} from "./common";

/**
 * SignalCandidate — step 1 output (Signal Mining Agent). Represents one
 * observed piece of evidence (a search query, a support ticket, a competitor
 * page, ...) — NOT yet a topic decision. No score, no ranking, no CTA. See
 * growth/contracts/README.md for how this differs from TopicCandidate.
 */

export const SIGNAL_CANDIDATE_SUPPORTED_MAJOR_VERSION = 1;

/**
 * Known source types today. `"other"` is the deliberate escape hatch for a
 * future integration (a new analytics tool, a new social platform, ...) that
 * doesn't warrant a schema change just to be recorded — pair it with
 * `source.name` to say what it actually is.
 */
export const signalSourceTypeSchema = z.enum([
  "search_console",
  "posthog",
  "ga4",
  "user_feedback",
  "mentor_input",
  "competitor_page",
  "social_discussion",
  "keyword_source",
  "manual",
  "other",
]);

export const signalSourceSchema = z
  .strictObject({
    type: signalSourceTypeSchema,
    /** Specific source name, e.g. "Google Search Console", "r/smallbusiness". Required when type is "other". */
    name: z.string().min(1).max(160),
    recordId: z.union([z.string().min(1).max(200), z.null()]),
    url: z.union([z.url(), z.null()]),
    publishedAt: z.union([isoTimestampSchema, z.null()]),
    retrievedAt: isoTimestampSchema,
    isInternal: z.boolean(),
  })
  .refine((source) => source.type !== "other" || source.name.trim().length > 0, {
    message: 'source.name is required (and must be specific) when source.type is "other".',
    path: ["name"],
  });

export type SignalSource = z.infer<typeof signalSourceSchema>;

export const signalTypeSchema = z.enum([
  "search_query",
  "feature_request",
  "pain_point",
  "competitor_gap",
  "trending_topic",
  "user_question",
  "churn_reason",
  "positive_feedback",
  "other",
]);

/** A single named metric attached to a signal. Values stay numeric — including zero — and are never fabricated when unknown; omit the metric instead. */
export const signalMetricSchema = z.strictObject({
  name: z.string().min(1).max(120),
  value: z.number(),
  unit: z.union([z.string().min(1).max(40), z.null()]),
  measurementBasis: z.string().min(1).max(200),
  period: z.union([z.string().min(1).max(120), z.null()]),
});

export type SignalMetric = z.infer<typeof signalMetricSchema>;

export const signalEntitiesSchema = z.strictObject({
  keywords: z.array(z.string().min(1).max(120)).max(50),
  topics: z.array(z.string().min(1).max(160)).max(50),
  audiences: z.array(z.string().min(1).max(160)).max(50),
  productsOrApps: z.array(z.string().min(1).max(160)).max(50),
  channels: z.array(z.string().min(1).max(120)).max(50),
});

export type SignalEntities = z.infer<typeof signalEntitiesSchema>;

export const signalQualitySchema = z.strictObject({
  confidence: confidenceSchema,
  freshness: z.enum(["fresh", "recent", "stale", "unknown"]),
  duplicateStatus: z.enum(["unique", "possible_duplicate", "confirmed_duplicate"]),
  limitations: z.array(z.string().min(1).max(500)).max(20),
});

export type SignalQuality = z.infer<typeof signalQualitySchema>;

export const signalCandidateSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: z.string().min(1).max(160),
  campaignId: campaignIdSchema,
  capturedAt: isoTimestampSchema,
  source: signalSourceSchema,
  signalType: signalTypeSchema,
  title: z.string().min(1).max(300),
  summary: z.string().min(1).max(2000),
  evidenceExcerpt: z.union([z.string().min(1).max(2000), z.null()]),
  entities: signalEntitiesSchema,
  metrics: z.array(signalMetricSchema).max(50),
  quality: signalQualitySchema,
  humanReviewRequired: humanReviewRequiredFlagSchema,
  provenance: provenanceSchema,
});

export type SignalCandidate = z.infer<typeof signalCandidateSchema>;

export class SignalCandidateValidationError extends Error {}

export function validateSignalCandidate(rawData: unknown): SignalCandidate {
  const result = signalCandidateSchema.safeParse(rawData);
  if (!result.success) {
    throw new SignalCandidateValidationError(`Invalid SignalCandidate: ${result.error.message}`);
  }
  assertSupportedMajorVersion("SignalCandidate", result.data.schemaVersion, SIGNAL_CANDIDATE_SUPPORTED_MAJOR_VERSION);
  return result.data;
}

/**
 * Deterministic identity: the same underlying observation (same source,
 * record, and title) always yields the same ID, so re-running Signal Mining
 * over overlapping windows dedupes instead of accumulating duplicates.
 * `capturedAt` is deliberately excluded — it changes on every re-run even
 * when the observation itself hasn't.
 */
export function buildSignalCandidateId(args: {
  sourceType: string;
  sourceName: string;
  sourceRecordId?: string | null;
  title: string;
}): string {
  return deterministicId("signal", args.sourceType, args.sourceName, args.sourceRecordId ?? "", args.title);
}

/** Non-empty reference array reused by downstream contracts to cite one or more SignalCandidate ids. */
export const signalRefArraySchema = refIdArraySchema;
