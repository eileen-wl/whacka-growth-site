import type { ClientConfig } from "@sanity/client";
import type { AppData } from "../data/apps";

/**
 * Framework-neutral Sanity preview configuration/query/dedup logic, shared
 * between the Astro site (src/lib/sanity.ts) and the read-only diagnostic
 * CLI (growth/scripts/check-sanity-preview.ts). Deliberately has NO
 * dependency on `import.meta.env` or any Astro/Vite-only mechanism, so it
 * is safe to import from plain tsx/Node — Astro's Vite instance sets
 * `envPrefix: "PUBLIC_"` (see node_modules/astro/dist/core/create-vite.js),
 * which means `import.meta.env` never carries a non-`PUBLIC_`-prefixed
 * custom var like `SANITY_API_TOKEN`/`SANITY_PREVIEW_DRAFTS` in the first
 * place; `import.meta.env` is also simply undefined outside Vite's
 * transform pipeline (e.g. under tsx). Every caller of this module
 * resolves its own env (src/lib/sanity.ts via process.env + a local
 * `dotenv/config` load; the CLI via plain process.env) and passes it in
 * explicitly as a `SanityEnvLike` object — nothing here ever reads an
 * environment source directly, which is also what makes every function in
 * this file trivially unit-testable with a plain object.
 */

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
export interface RawAppToolDoc extends AppToolData {
  _id: string;
}

export class SanityPreviewConfigError extends Error {}

/** Minimal env shape this module actually reads — lets every caller (Astro site, CLI, tests) inject a plain object instead of depending on a specific runtime's env mechanism. */
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
 * Normalizes `SANITY_PREVIEW_DRAFTS` case-insensitively and trims
 * whitespace before comparing — a shell-set value should not silently
 * fail to activate preview mode over an incidental trailing space or a
 * differently-cased "TRUE"/"True".
 */
function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && value.trim().toLowerCase() === "true";
}

/**
 * Pure, injectable resolution of Sanity client configuration — never reads
 * any environment source itself, so it's fully unit-testable with a plain
 * object. Reuses the existing `PUBLIC_SANITY_PROJECT_ID`/
 * `PUBLIC_SANITY_DATASET`/`SANITY_API_TOKEN` variables — no duplicate
 * credential is introduced for preview mode.
 *
 * `SANITY_PREVIEW_DRAFTS=true` requires `SANITY_API_TOKEN`: draft content
 * is only ever visible to an authenticated request. Throws a sanitized
 * `SanityPreviewConfigError` (the token itself is never part of the
 * message, since when this throws the token is absent by definition)
 * rather than silently falling back to published-only content, so a
 * misconfigured preview attempt fails loudly instead of quietly showing
 * the wrong thing.
 */
export function resolveSanityConfig(env: SanityEnvLike): ResolvedSanityConfig {
  const previewMode = isTruthyFlag(env.SANITY_PREVIEW_DRAFTS);
  const previewToken = env.SANITY_API_TOKEN && env.SANITY_API_TOKEN.trim().length > 0 ? env.SANITY_API_TOKEN : undefined;

  if (previewMode && !previewToken) {
    throw new SanityPreviewConfigError(
      "SANITY_PREVIEW_DRAFTS=true requires SANITY_API_TOKEN to be set — preview mode cannot read draft content without it. " +
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
 * perspective (the current, non-deprecated value for the installed
 * `@sanity/client@7.23.0` — `"previewDrafts"` is marked `@deprecated use
 * 'drafts' instead` in the SDK's own type definitions) and
 * `useCdn: false` (the CDN never serves draft content). Normal mode's
 * `useCdn: true` is completely unchanged. Published mode never attaches a
 * `token`/`perspective` key at all — not even `undefined` — so a
 * `JSON.stringify`/`Object.keys` inspection of the config structurally
 * proves no credential is present.
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

/**
 * GROQ projection for every `appTool` document. Deliberately has NO
 * published-only filter (no `!(_id in path("drafts.**"))`, no
 * `_id match "drafts.*"` exclusion, nothing that would defeat
 * `perspective: "drafts"`) — the perspective alone controls draft
 * visibility; the query only ever asks for every document of this type.
 * `_id` is selected solely for `dedupeDraftsAndPublished` and is never
 * part of `AppToolData`.
 */
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

/** Only the fields explicitly considered safe to print/log — never a token, never a full env dump, never document body content. */
export interface SanityPreviewDiagnostics {
  previewMode: boolean;
  projectConfigured: boolean;
  datasetConfigured: boolean;
  tokenConfigured: boolean;
  perspective: "published" | "drafts";
  useCdn: boolean;
}

/** Pure, safe-by-construction diagnostics summary — shared by the Astro server log and the CLI so "what's safe to print" is defined in exactly one place. */
export function buildPreviewDiagnostics(config: ResolvedSanityConfig): SanityPreviewDiagnostics {
  const clientConfig = buildClientConfig(config);
  return {
    previewMode: config.previewMode,
    projectConfigured: Boolean(config.projectId),
    datasetConfigured: Boolean(config.dataset),
    tokenConfigured: Boolean(config.previewToken),
    perspective: config.previewMode ? "drafts" : "published",
    useCdn: clientConfig.useCdn ?? true,
  };
}
