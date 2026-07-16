import { z } from "zod/v4";
import { deterministicId } from "../lib/ids";
import type { ScoredTopic } from "./scored-topic";
import {
  assertSupportedMajorVersion,
  campaignIdSchema,
  isoTimestampSchema,
  provenanceSchema,
  refIdArraySchema,
  schemaVersionSchema,
} from "./common";

/**
 * AssetBundle — step 4 output (Asset Generation Agent), the complete
 * generated content for one approved ScoredTopic. Field names inside `app`
 * intentionally mirror the REAL Sanity `appTool` schema (studio/schemaTypes/appTool.ts)
 * and the REAL frontend `AppData` type (src/data/apps.ts) 1:1 — see
 * growth/contracts/README.md for the full field-by-field mapping table and
 * the handful of fields (`seo.*`) that do NOT correspond to any current CMS
 * field yet.
 *
 * Two deliberate departures from the Sanity field names:
 * - `app.appPrompt` maps to Sanity's `prompt` field. Renamed here only to
 *   avoid colliding with the unrelated LLM "prompt" vocabulary used
 *   elsewhere in growth/ (promptVersion, system prompts, ...).
 * - Non-CMS scaffolding content (hook/persona/scenario/steps) that helped
 *   produce `app.problem`/`app.solution` but has no Sanity field of its own
 *   lives in `creativeBrief`, kept separate so `app` stays a clean,
 *   1:1-with-Sanity payload.
 */

export const ASSET_BUNDLE_SUPPORTED_MAJOR_VERSION = 1;

const kebabSlugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase kebab-case to satisfy Astro routing.");

/** Mirrors src/data/apps.ts `Screenshot`. */
export const assetScreenshotSchema = z.strictObject({
  image: z.string().min(1).max(300),
  caption: z.string().min(1).max(300),
});

/** Mirrors src/data/apps.ts `FaqItem`. */
export const assetFaqItemSchema = z.strictObject({
  question: z.string().min(1).max(300),
  answer: z.string().min(1).max(1000),
});

/**
 * 1:1 with the real Sanity `appTool` document / frontend `AppData` type.
 * Every field Sanity marks `Rule.required()` is required here too — nothing
 * that's mandatory in the CMS can be absent from a generated bundle.
 * `status` is pinned to "draft": Asset Generation never publishes.
 */
export const assetAppSchema = z.strictObject({
  name: z.string().min(1).max(200),
  slug: kebabSlugSchema,
  tagline: z.string().min(1).max(200),
  category: z.string().min(1).max(120),
  shortDescription: z.string().min(1).max(500),
  image: z.string().min(1).max(300),
  screenshots: z.array(assetScreenshotSchema).max(20),
  problem: z.string().min(1).max(2000),
  solution: z.string().min(1).max(2000),
  whoItsFor: z.array(z.string().min(1).max(300)).max(20),
  /** Maps to Sanity's `prompt` ("Whacka Prompt") field. Must never be empty. */
  appPrompt: z.string().min(1).max(4000),
  ctaLabel: z.string().min(1).max(200),
  ctaHref: z.string().min(1).max(500),
  relatedSlugs: z.array(kebabSlugSchema).max(20),
  faq: z.array(assetFaqItemSchema).max(20),
  status: z.literal("draft"),
});

export type AssetApp = z.infer<typeof assetAppSchema>;

/** Scaffolding that shaped `app.problem`/`app.solution`/`app.appPrompt` but has no Sanity field of its own. */
export const assetCreativeBriefSchema = z.strictObject({
  hook: z.string().min(1).max(300),
  persona: z.union([z.string().min(1).max(300), z.null()]),
  scenario: z.union([z.string().min(1).max(1000), z.null()]),
  steps: z.array(z.string().min(1).max(500)).max(20),
});

export type AssetCreativeBrief = z.infer<typeof assetCreativeBriefSchema>;

/**
 * Useful intermediate SEO content. NOTE: as of this schema version, the
 * Sanity `appTool` document has no metaTitle/metaDescription/keywords
 * fields — only `seo.faq`'s counterpart (`app.faq` above) maps to a real
 * CMS field. This section is kept for future use and for renderers that
 * consume AssetBundle directly, but a CMSWriteRequest built from an
 * AssetBundle today cannot persist `seo.title`/`seo.metaDescription`/
 * `seo.primaryKeyword`/`seo.secondaryKeywords` anywhere in Sanity. Documented
 * as a known gap in growth/contracts/README.md.
 */
export const assetSeoSchema = z.strictObject({
  title: z.string().min(1).max(200),
  metaDescription: z.string().min(1).max(300),
  primaryKeyword: z.string().min(1).max(160),
  secondaryKeywords: z.array(z.string().min(1).max(160)).max(20),
});

export type AssetSeo = z.infer<typeof assetSeoSchema>;

/** Must match growth/types/experiment-decision.ts's CtaType value set exactly. */
export const assetCtaTypeSchema = z.enum(["view_demo", "remix", "build", "copy_prompt"]);

export const assetCtaLabelsSchema = z.strictObject({
  viewDemo: z.union([z.string().min(1).max(200), z.null()]),
  remix: z.union([z.string().min(1).max(200), z.null()]),
  build: z.union([z.string().min(1).max(200), z.null()]),
  copyPrompt: z.union([z.string().min(1).max(200), z.null()]),
});

/**
 * `demoUrl`/`remixUrl`/`buildUrl`/`utmContent` mirror the real optional
 * Sanity fields of the same name. URLs may be null when no real target
 * exists yet — the frontend already hides unavailable CTAs — and null must
 * never be replaced with a fabricated or placeholder-looking URL.
 */
export const assetCtaSchema = z.strictObject({
  primaryType: assetCtaTypeSchema,
  demoUrl: z.union([z.url(), z.null()]),
  remixUrl: z.union([z.url(), z.null()]),
  buildUrl: z.union([z.url(), z.null()]),
  labels: assetCtaLabelsSchema,
  utmContent: z.union([z.string().min(1).max(160), z.null()]),
});

export type AssetCta = z.infer<typeof assetCtaSchema>;

export const assetSocialPostSchema = z.strictObject({
  channel: z.string().min(1).max(80),
  text: z.string().min(1).max(2000),
});

export const assetSocialSchema = z.strictObject({
  posts: z.array(assetSocialPostSchema).max(50),
});

export type AssetSocial = z.infer<typeof assetSocialSchema>;

export const assetGenerationMetaSchema = z.strictObject({
  provider: z.string().min(1).max(80),
  model: z.union([z.string().min(1).max(160), z.null()]),
  isMock: z.boolean(),
  promptVersion: z.string().min(1).max(40),
  evidenceRefs: refIdArraySchema,
  signalRefs: refIdArraySchema,
  findingRefs: refIdArraySchema,
});

export type AssetGenerationMeta = z.infer<typeof assetGenerationMetaSchema>;

export const assetValidationSchema = z.strictObject({
  /** Never "approved"/"ready" by construction — publish readiness is a human decision outside this contract. */
  status: z.enum(["draft", "needs_review"]),
  warnings: z.array(z.string().min(1).max(500)).max(50),
  humanReviewRequired: z.literal(true),
});

export type AssetValidation = z.infer<typeof assetValidationSchema>;

export const assetBundleSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  id: z.string().min(1).max(160),
  scoredTopicId: z.string().min(1).max(160),
  topicId: z.string().min(1).max(160),
  campaignId: campaignIdSchema,
  generatedAt: isoTimestampSchema,
  app: assetAppSchema,
  creativeBrief: assetCreativeBriefSchema,
  seo: assetSeoSchema,
  cta: assetCtaSchema,
  social: assetSocialSchema,
  generation: assetGenerationMetaSchema,
  validation: assetValidationSchema,
  provenance: provenanceSchema,
});

export type AssetBundle = z.infer<typeof assetBundleSchema>;

export class AssetBundleValidationError extends Error {}

export function validateAssetBundle(rawData: unknown): AssetBundle {
  const result = assetBundleSchema.safeParse(rawData);
  if (!result.success) {
    throw new AssetBundleValidationError(`Invalid AssetBundle: ${result.error.message}`);
  }
  assertSupportedMajorVersion("AssetBundle", result.data.schemaVersion, ASSET_BUNDLE_SUPPORTED_MAJOR_VERSION);
  return result.data;
}

/** Deterministic identity: same ScoredTopic + same promptVersion always yields the same AssetBundle id, so regenerating under an unchanged prompt overwrites rather than duplicates. */
export function buildAssetBundleId(args: { scoredTopicId: string; promptVersion: string }): string {
  return deterministicId("assetbundle", args.scoredTopicId, args.promptVersion);
}

export class ScoredTopicToAssetBundleValidationError extends Error {}

/**
 * Validates that a ScoredTopic is a legitimate asset-generation target —
 * pure input validation, not content generation. It does NOT write app
 * copy, SEO copy, or CTAs; the caller (Asset Generation Agent, not in scope
 * here) still decides those.
 */
export function validateScoredTopicForAssetGeneration(scoredTopic: ScoredTopic): ScoredTopic {
  if (scoredTopic.recommendation === "reject") {
    throw new ScoredTopicToAssetBundleValidationError(
      `ScoredTopic ${scoredTopic.id} has recommendation "reject" and cannot proceed to asset generation.`
    );
  }
  return scoredTopic;
}
