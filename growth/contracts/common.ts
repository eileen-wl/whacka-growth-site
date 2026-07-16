import { z } from "zod/v4";

/**
 * Shared building blocks for every front-half Growth Loop contract
 * (SignalCandidate, TopicCandidate, ScoredTopic, AssetBundle,
 * CMSWriteRequest, GrowthLoopFeedback). Keeping these in one place means
 * "what counts as a valid evidence reference" or "what a provenance block
 * looks like" is defined once, not six times with six chances to drift.
 */

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

export class UnsupportedSchemaVersionError extends Error {}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Validates the *shape* of a schemaVersion string (e.g. "1.0.0") without
 * pinning an exact value. A literal `z.literal("1.0.0")` would reject a
 * forward-compatible "1.1.0" (an additive minor bump per the versioning
 * rules below) even though a 1.x consumer should still be able to read it —
 * so structural validation and major-version compatibility are deliberately
 * two separate checks. See `assertSupportedMajorVersion`.
 */
export const schemaVersionSchema = z.string().regex(SEMVER_PATTERN, 'schemaVersion must look like "1.0.0" (MAJOR.MINOR.PATCH).');

export function parseMajorVersion(version: string): number {
  const major = Number(version.split(".")[0]);
  if (!Number.isInteger(major)) {
    throw new UnsupportedSchemaVersionError(`Cannot parse a major version number from schemaVersion "${version}".`);
  }
  return major;
}

/**
 * Versioning rules for every contract in this directory:
 * - a breaking change (removed/renamed/retyped field, new required field) requires a MAJOR bump
 * - an additive optional field may ship as a MINOR bump
 * - a validation-only fix (tightening a regex, fixing a typo'd message) may ship as a PATCH bump
 *
 * Downstream modules must call this (or a contract's own `validate*`
 * function, which already does) before trusting a document — an
 * unsupported major version is rejected clearly rather than silently
 * mis-parsed.
 */
export function assertSupportedMajorVersion(contractName: string, version: string, supportedMajor: number): void {
  const major = parseMajorVersion(version);
  if (major !== supportedMajor) {
    throw new UnsupportedSchemaVersionError(
      `${contractName} has schemaVersion "${version}" (major ${major}), but this code only supports major version ` +
        `${supportedMajor}.x.x. A different major version is a breaking change — the consumer must be upgraded before it can read this document.`
    );
  }
}

// ---------------------------------------------------------------------------
// Primitive building blocks
// ---------------------------------------------------------------------------

/** Full ISO 8601 timestamp, e.g. "2026-07-16T00:00:00.000Z" — always what `new Date().toISOString()` produces. */
export const isoTimestampSchema = z.iso.datetime({ offset: true });

/** ISO calendar date only, e.g. "2026-07-16". */
export const isoDateSchema = z.iso.date();

export const dateRangeSchema = z.strictObject({ start: isoDateSchema, end: isoDateSchema });

export const confidenceSchema = z.enum(["high", "medium", "low"]);

export const campaignIdSchema = z.string().min(1).max(120);
export const campaignNameSchema = z.string().min(1).max(200);

/**
 * A stable, non-empty reference ID (evidenceRef / findingRef / limitationRef
 * / signalRef / topicId / ...). Must never itself carry a measured value —
 * that belongs in the catalog entry the ID points at, not in the ID string.
 */
export const refIdSchema = z.string().min(1).max(160);
export const refIdArraySchema = z.array(refIdSchema).max(100);

// ---------------------------------------------------------------------------
// Human review
// ---------------------------------------------------------------------------

/** Every generated (non-human-authored) record in this directory must require review — this is always the literal `true`, never a variable. */
export const humanReviewRequiredFlagSchema = z.literal(true);

export const humanReviewStateSchema = z.strictObject({
  required: z.literal(true),
  approved: z.boolean(),
  approvedBy: z.union([z.string().min(1).max(160), z.null()]),
  approvedAt: z.union([isoTimestampSchema, z.null()]),
});

export type HumanReviewState = z.infer<typeof humanReviewStateSchema>;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** Rejects absolute paths (`/...`, `C:\...`) and backslash path separators — sourceFileNames must be plain filenames, never a local filesystem path. */
function isSafeFileNameLike(value: string): boolean {
  if (value.startsWith("/")) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.includes("\\")) return false;
  return true;
}

/** Exported for reuse anywhere a filename (never a path) is expected, e.g. GrowthLoopFeedback's `sourceDecision.filename`. */
export const safeFileNameSchema = z
  .string()
  .min(1)
  .max(300)
  .refine(isSafeFileNameLike, { message: "Filename fields must be plain filenames, never an absolute local path." });

export const provenanceSchema = z.strictObject({
  /** Which pipeline step produced this record, e.g. "signal-mining-agent", "topic-scoring-agent". */
  generatedBy: z.string().min(1).max(160),
  sourceFileNames: z.array(safeFileNameSchema).max(50),
  sourceHashes: z.array(z.string().min(1).max(128)).max(50),
  sourceRecordIds: z.array(z.string().min(1).max(160)).max(200),
  sourceDecisionId: z.union([z.string().min(1).max(160), z.null()]),
  provider: z.union([z.string().min(1).max(80), z.null()]),
  model: z.union([z.string().min(1).max(160), z.null()]),
  isMock: z.boolean(),
  humanReviewed: z.boolean(),
});

export type Provenance = z.infer<typeof provenanceSchema>;
