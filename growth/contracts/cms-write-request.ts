import { z } from "zod/v4";
import { deterministicId } from "../lib/ids";
import { assetBundleSchema, type AssetBundle } from "./asset-bundle";
import { assertSupportedMajorVersion, campaignIdSchema, isoTimestampSchema, provenanceSchema, schemaVersionSchema } from "./common";

/**
 * CMSWriteRequest — step 4 input, an execution REQUEST consumed by the
 * CMS Writer (growth/cms/). This is deliberately not the Sanity write itself: no network
 * call happens anywhere in this file. `payload` mirrors the exact document
 * shape `scripts/seed.ts` sends to `client.createOrReplace()` today (same
 * `_id` convention — `appTool-{slug}` via `toDocId()` — same Sanity `slug`
 * object shape, same `_key`-bearing array items), so a future CMS Writer can
 * pass `payload` straight into `client.createOrReplace()` without reshaping it.
 */

/**
 * Bumped to 2 when `payload.seo` was added as a new required field (the
 * Sanity `appTool` schema now persists SEO metadata — see
 * studio/schemaTypes/appTool.ts and growth/contracts/README.md). A new
 * required field is a breaking change per growth/contracts/common.ts's own
 * versioning rule, so old (pre-SEO) CMSWriteRequest documents are no longer
 * schema-compatible. No real CMSWriteRequest documents existed before CMS
 * Writer shipped, so nothing needs migration.
 */
export const CMS_WRITE_REQUEST_SUPPORTED_MAJOR_VERSION = 2;

const DOC_ID_PREFIX = "appTool-";

/** Same convention as `scripts/seed.ts`'s local `toDocId()` — kept in sync deliberately, not re-exported, since seed.ts is not part of the growth/ pipeline. */
function toDocId(slug: string): string {
  return `${DOC_ID_PREFIX}${slug}`;
}

/** Deterministic replacement for `scripts/seed.ts`'s `withKeys()` (which uses `randomUUID()`). Same item content always yields the same `_key`, so rebuilding a request from an unchanged AssetBundle produces byte-identical array keys. */
function withDeterministicKeys<T extends Record<string, string>>(prefix: string, items: T[]): (T & { _key: string })[] {
  return items.map((item, index) => ({
    _key: deterministicId("key", prefix, String(index), Object.values(item).join(" ")),
    ...item,
  }));
}

export const sanitySlugSchema = z.strictObject({
  _type: z.literal("slug"),
  current: z.string().min(1).max(200),
});

export const cmsScreenshotPayloadSchema = z.strictObject({
  _key: z.string().min(1).max(80),
  image: z.string().min(1).max(300),
  caption: z.string().min(1).max(300),
});

export const cmsFaqPayloadSchema = z.strictObject({
  _key: z.string().min(1).max(80),
  question: z.string().min(1).max(300),
  answer: z.string().min(1).max(1000),
});

/** Mirrors studio/schemaTypes/appTool.ts's optional `seo` object field exactly. Required here because `buildCmsWriteRequest` always has a validated AssetBundle.seo to map from. */
export const cmsSeoPayloadSchema = z.strictObject({
  title: z.string().min(1).max(200),
  metaDescription: z.string().min(1).max(300),
  primaryKeyword: z.string().min(1).max(160),
  secondaryKeywords: z.array(z.string().min(1).max(160)).max(20),
});

export type CmsSeoPayload = z.infer<typeof cmsSeoPayloadSchema>;

/** 1:1 with the document `scripts/seed.ts` writes via `client.createOrReplace()` — see studio/schemaTypes/appTool.ts for the authoritative field list. */
export const appToolPayloadSchema = z.strictObject({
  _id: z.string().min(1).max(200),
  _type: z.literal("appTool"),
  name: z.string().min(1).max(200),
  slug: sanitySlugSchema,
  tagline: z.string().min(1).max(200),
  category: z.string().min(1).max(120),
  shortDescription: z.string().min(1).max(500),
  image: z.string().min(1).max(300),
  screenshots: z.array(cmsScreenshotPayloadSchema).max(20),
  problem: z.string().min(1).max(2000),
  solution: z.string().min(1).max(2000),
  whoItsFor: z.array(z.string().min(1).max(300)).max(20),
  prompt: z.string().min(1).max(4000),
  ctaLabel: z.string().min(1).max(200),
  ctaHref: z.string().min(1).max(500),
  relatedSlugs: z.array(z.string().min(1).max(200)).max(20),
  faq: z.array(cmsFaqPayloadSchema).max(20),
  /** Always "draft" coming out of this contract — CMSWriteRequest never proposes a published document. */
  status: z.literal("draft"),
  notes: z.union([z.string().min(1).max(1000), z.null()]),
  demoUrl: z.union([z.url(), z.null()]),
  remixUrl: z.union([z.url(), z.null()]),
  buildUrl: z.union([z.url(), z.null()]),
  utmContent: z.union([z.string().min(1).max(160), z.null()]),
  seo: cmsSeoPayloadSchema,
});

export type AppToolPayload = z.infer<typeof appToolPayloadSchema>;

export const cmsWriteTargetSchema = z.strictObject({
  cms: z.literal("sanity"),
  documentType: z.literal("appTool"),
  documentId: z.string().min(1).max(200),
  operation: z.enum(["create_or_replace", "create", "update"]),
  dataset: z.union([z.string().min(1).max(80), z.null()]),
});

export type CmsWriteTarget = z.infer<typeof cmsWriteTargetSchema>;

export const cmsWriteModeSchema = z.enum(["dry_run", "draft_write"]);

/** `publishRequested`/`publishAllowed` are pinned to the literal `false` — no code path in this version of the contract can set either to `true`. Publishing is a decision for a future, explicitly-scoped write path, not this one. */
export const cmsWritePublishingSchema = z.strictObject({
  publishRequested: z.literal(false),
  publishAllowed: z.literal(false),
});

export const cmsWriteValidationSchema = z.strictObject({
  assetBundleValidated: z.boolean(),
  humanReviewed: z.boolean(),
  warnings: z.array(z.string().min(1).max(500)).max(50),
});

export const cmsWriteRequestSchema = z
  .strictObject({
    schemaVersion: schemaVersionSchema,
    id: z.string().min(1).max(160),
    createdAt: isoTimestampSchema,
    assetBundleId: z.string().min(1).max(160),
    campaignId: campaignIdSchema,
    target: cmsWriteTargetSchema,
    mode: cmsWriteModeSchema,
    payload: appToolPayloadSchema,
    publishing: cmsWritePublishingSchema,
    idempotencyKey: z.string().min(1).max(200),
    validation: cmsWriteValidationSchema,
    provenance: provenanceSchema,
  })
  .refine((request) => request.payload._id === request.target.documentId, {
    message: "payload._id must equal target.documentId.",
    path: ["payload", "_id"],
  })
  .refine((request) => request.target.documentId === toDocId(request.payload.slug.current), {
    message: 'target.documentId must equal "appTool-{payload.slug.current}".',
    path: ["target", "documentId"],
  })
  .refine((request) => request.mode !== "dry_run" || request.target.dataset === null, {
    message: "dry_run requests must not name a target dataset (no credential-bearing target should be implied).",
    path: ["target", "dataset"],
  });

export type CMSWriteRequest = z.infer<typeof cmsWriteRequestSchema>;

export class CMSWriteRequestValidationError extends Error {}

export function validateCmsWriteRequest(rawData: unknown): CMSWriteRequest {
  const result = cmsWriteRequestSchema.safeParse(rawData);
  if (!result.success) {
    throw new CMSWriteRequestValidationError(`Invalid CMSWriteRequest: ${result.error.message}`);
  }
  assertSupportedMajorVersion("CMSWriteRequest", result.data.schemaVersion, CMS_WRITE_REQUEST_SUPPORTED_MAJOR_VERSION);
  return result.data;
}

export class AssetBundleToCmsWriteRequestValidationError extends Error {}

export interface BuildCmsWriteRequestOptions {
  generatedBy: string;
  mode?: "dry_run" | "draft_write";
  dataset?: string | null;
  humanReviewed?: boolean;
  operation?: "create_or_replace" | "create" | "update";
}

/**
 * Deterministic AssetBundle -> CMSWriteRequest builder. Pure field mapping
 * and ID derivation only — it never invents copy, never contacts Sanity, and
 * never sets `publishing.publishRequested`/`publishAllowed` to true. Rejects
 * an AssetBundle that fails its own contract validation, so an invalid
 * bundle can never produce a valid write request.
 */
export function buildCmsWriteRequest(assetBundle: AssetBundle, options: BuildCmsWriteRequestOptions): CMSWriteRequest {
  const parsedBundle = assetBundleSchema.safeParse(assetBundle);
  if (!parsedBundle.success) {
    throw new AssetBundleToCmsWriteRequestValidationError(
      `Cannot build a CMSWriteRequest from an invalid AssetBundle: ${parsedBundle.error.message}`
    );
  }
  const bundle = parsedBundle.data;
  const mode = options.mode ?? "dry_run";
  const documentId = toDocId(bundle.app.slug);

  const payload: AppToolPayload = {
    _id: documentId,
    _type: "appTool",
    name: bundle.app.name,
    slug: { _type: "slug", current: bundle.app.slug },
    tagline: bundle.app.tagline,
    category: bundle.app.category,
    shortDescription: bundle.app.shortDescription,
    image: bundle.app.image,
    screenshots: withDeterministicKeys(`${bundle.id}_screenshot`, bundle.app.screenshots),
    problem: bundle.app.problem,
    solution: bundle.app.solution,
    whoItsFor: bundle.app.whoItsFor,
    prompt: bundle.app.appPrompt,
    ctaLabel: bundle.app.ctaLabel,
    ctaHref: bundle.app.ctaHref,
    relatedSlugs: bundle.app.relatedSlugs,
    faq: withDeterministicKeys(`${bundle.id}_faq`, bundle.app.faq),
    status: "draft",
    notes: null,
    demoUrl: bundle.cta.demoUrl,
    remixUrl: bundle.cta.remixUrl,
    buildUrl: bundle.cta.buildUrl,
    utmContent: bundle.cta.utmContent,
    seo: {
      title: bundle.seo.title,
      metaDescription: bundle.seo.metaDescription,
      primaryKeyword: bundle.seo.primaryKeyword,
      secondaryKeywords: bundle.seo.secondaryKeywords,
    },
  };

  const request: CMSWriteRequest = {
    schemaVersion: "2.0.0",
    id: deterministicId("cmswriterequest", bundle.id, mode),
    createdAt: new Date().toISOString(),
    assetBundleId: bundle.id,
    campaignId: bundle.campaignId,
    target: {
      cms: "sanity",
      documentType: "appTool",
      documentId,
      operation: options.operation ?? "create_or_replace",
      dataset: mode === "dry_run" ? null : options.dataset ?? null,
    },
    mode,
    payload,
    publishing: { publishRequested: false, publishAllowed: false },
    idempotencyKey: deterministicId("idempotency", documentId, bundle.id),
    validation: {
      assetBundleValidated: true,
      humanReviewed: options.humanReviewed ?? false,
      warnings: bundle.validation.warnings,
    },
    provenance: {
      generatedBy: options.generatedBy,
      sourceFileNames: [],
      sourceHashes: [],
      sourceRecordIds: [bundle.id],
      sourceDecisionId: null,
      provider: bundle.generation.provider,
      model: bundle.generation.model,
      isMock: bundle.generation.isMock,
      humanReviewed: options.humanReviewed ?? false,
    },
  };

  return validateCmsWriteRequest(request);
}
