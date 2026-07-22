import { createClient } from "@sanity/client";
import { apps as fallbackApps, type AppData } from "../data/apps";
import type { ClientConfig } from "@sanity/client";

export interface AppToolData extends AppData {
  demoUrl?: string;
  remixUrl?: string;
  buildUrl?: string;
  status?: string;
  notes?: string;
  utmContent?: string;
}

/**
 * The raw shape `APP_TOOLS_QUERY` actually returns — `_id` exists only to
 * let `dedupeDraftsAndPublished` tell a draft apart from its published
 * counterpart. It is never part of `AppToolData`/`AppData` and is always
 * stripped before a document leaves this module, so a `drafts.`-prefixed
 * id can never reach a route, a rendered page, or any downstream consumer.
 */
interface RawAppToolDoc extends AppToolData {
  _id: string;
}

export class SanityPreviewConfigError extends Error {}

/** Minimal env shape this module actually reads — lets tests inject a plain object instead of mutating real `import.meta.env`. */
export interface SanityEnvLike {
  PUBLIC_SANITY_PROJECT_ID?: string;
  PUBLIC_SANITY_DATASET?: string;
  PUBLIC_SANITY_API_VERSION?: string;
  SANITY_PREVIEW_DRAFTS?: string;
  SANITY_API_TOKEN?: string;
}

export interface ResolvedSanityConfig {
  projectId: string | undefined;
  dataset: string | undefined;
  apiVersion: string;
  previewMode: boolean;
  previewToken: string | undefined;
}

const DEFAULT_API_VERSION = "2024-01-01";

/**
 * Pure, injectable resolution of Sanity client configuration — never reads
 * `import.meta.env` itself, so it's fully unit-testable with a plain
 * object. Reuses the existing `PUBLIC_SANITY_PROJECT_ID`/
 * `PUBLIC_SANITY_DATASET`/`SANITY_API_TOKEN` variables — no duplicate
 * credential is introduced for preview mode.
 *
 * `SANITY_PREVIEW_DRAFTS=true` requires `SANITY_API_TOKEN`: draft content
 * is only ever visible to an authenticated request, and this project's
 * dataset is not public for unauthenticated draft reads. Throws a
 * sanitized `SanityPreviewConfigError` (the token itself is never part of
 * the message, since when this throws the token is absent by definition)
 * rather than silently falling back to published-only content, so a
 * misconfigured preview attempt fails loudly instead of quietly showing
 * the wrong thing.
 */
export function resolveSanityConfig(env: SanityEnvLike): ResolvedSanityConfig {
  const previewMode = env.SANITY_PREVIEW_DRAFTS === "true";
  const previewToken = env.SANITY_API_TOKEN && env.SANITY_API_TOKEN.trim().length > 0 ? env.SANITY_API_TOKEN : undefined;

  if (previewMode && !previewToken) {
    throw new SanityPreviewConfigError(
      "SANITY_PREVIEW_DRAFTS=true requires SANITY_API_TOKEN to be set in .env — preview mode cannot read draft content without it. " +
        "Set SANITY_API_TOKEN (see .env.example), or unset SANITY_PREVIEW_DRAFTS to use normal published-only mode."
    );
  }

  return {
    projectId: env.PUBLIC_SANITY_PROJECT_ID,
    dataset: env.PUBLIC_SANITY_DATASET,
    apiVersion: env.PUBLIC_SANITY_API_VERSION && env.PUBLIC_SANITY_API_VERSION.trim().length > 0 ? env.PUBLIC_SANITY_API_VERSION : DEFAULT_API_VERSION,
    previewMode,
    previewToken,
  };
}

/**
 * Builds the actual `@sanity/client` config for a resolved Sanity config —
 * pure, so tests can assert on the shape without constructing a real
 * client or making a network call. Preview mode uses the `"drafts"`
 * perspective (the current, non-deprecated value for this installed
 * `@sanity/client` version and API version — `"previewDrafts"` is marked
 * `@deprecated use 'drafts' instead` in the SDK's own type definitions)
 * and `useCdn: false` (the CDN never serves draft content). Normal mode's
 * `useCdn: true` is completely unchanged from before this feature existed.
 */
export function buildClientConfig(config: ResolvedSanityConfig): ClientConfig {
  if (config.previewMode) {
    return {
      projectId: config.projectId,
      dataset: config.dataset,
      apiVersion: config.apiVersion,
      useCdn: false,
      perspective: "drafts",
      token: config.previewToken,
    };
  }
  return {
    projectId: config.projectId,
    dataset: config.dataset,
    apiVersion: config.apiVersion,
    useCdn: true,
  };
}

/**
 * Deterministically collapses a draft and its published counterpart (same
 * `slug`) into a single entry, preferring the draft — the whole point of
 * preview mode. In normal (non-preview) mode this is a no-op, since the
 * default `"published"` perspective never returns a `drafts.`-prefixed
 * document in the first place. `_id` is stripped from every returned
 * entry, so a `drafts.` prefix can never leak into `AppToolData.slug` or
 * any route.
 */
export function dedupeDraftsAndPublished(docs: RawAppToolDoc[]): AppToolData[] {
  const bySlug = new Map<string, RawAppToolDoc>();

  for (const doc of docs) {
    const existing = bySlug.get(doc.slug);
    if (!existing) {
      bySlug.set(doc.slug, doc);
      continue;
    }
    const isDraft = doc._id.startsWith("drafts.");
    const existingIsDraft = existing._id.startsWith("drafts.");
    if (isDraft && !existingIsDraft) {
      bySlug.set(doc.slug, doc);
    }
  }

  return [...bySlug.values()].map((doc) => {
    const { _id, ...rest } = doc;
    return rest;
  });
}

const resolvedConfig = resolveSanityConfig(import.meta.env as unknown as SanityEnvLike);

/** True only when SANITY_PREVIEW_DRAFTS=true and SANITY_API_TOKEN is set — see resolveSanityConfig. Read by AppDetail.astro to show a preview banner; never used to alter production behavior implicitly. */
export const SANITY_PREVIEW_MODE = resolvedConfig.previewMode;

const client =
  resolvedConfig.projectId && resolvedConfig.dataset ? createClient(buildClientConfig(resolvedConfig)) : null;

if (SANITY_PREVIEW_MODE) {
  // Server-only console log — never includes the token or any credential value.
  console.log(`[sanity] Preview mode active (perspective: "drafts", useCdn: false). Unpublished draft content will be visible.`);
}

export const APP_TOOLS_QUERY = `*[_type == "appTool"] | order(name asc) {
  _id,
  "slug": slug.current,
  name,
  tagline,
  category,
  shortDescription,
  image,
  screenshots[]{ image, caption },
  problem,
  solution,
  whoItsFor,
  prompt,
  ctaLabel,
  ctaHref,
  relatedSlugs,
  faq[]{ question, answer },
  demoUrl,
  remixUrl,
  buildUrl,
  status,
  notes,
  utmContent,
  seo{ title, metaDescription, primaryKeyword, secondaryKeywords }
}`;

let cachedApps: Promise<AppToolData[]> | null = null;

async function fetchApps(): Promise<AppToolData[]> {
  if (!client) {
    return fallbackApps;
  }

  try {
    const docs = await client.fetch<RawAppToolDoc[]>(APP_TOOLS_QUERY);
    if (!docs || docs.length === 0) return fallbackApps;
    return dedupeDraftsAndPublished(docs);
  } catch (err) {
    console.warn("[sanity] Could not fetch app data, falling back to src/data/apps.ts:", err);
    return fallbackApps;
  }
}

/** All appTool records, fetched from Sanity when configured and falling back to the static data otherwise. Cached per build/request. */
export function getApps(): Promise<AppToolData[]> {
  if (!cachedApps) {
    cachedApps = fetchApps();
  }
  return cachedApps;
}

export async function getAppBySlug(slug: string): Promise<AppToolData | undefined> {
  const apps = await getApps();
  return apps.find((app) => app.slug === slug);
}
