// Populates process.env from the root .env file — necessary because
// Astro's Vite instance sets envPrefix: "PUBLIC_" (see
// node_modules/astro/dist/core/create-vite.js), so import.meta.env never
// carries a non-PUBLIC_-prefixed var like SANITY_API_TOKEN or
// SANITY_PREVIEW_DRAFTS, in dev OR build. process.env is the only reliable
// channel for those two. dotenv never overwrites a value already present
// in process.env (its own documented default), so a shell-set
// $env:SANITY_PREVIEW_DRAFTS="true" always wins over whatever .env says —
// see resolveRuntimeSanityEnv below for the full documented precedence.
import "dotenv/config";
import { createClient } from "@sanity/client";
import { apps as fallbackApps } from "../data/apps";
import { applyImageFallbacks } from "./images";
import {
  APP_TOOLS_QUERY,
  buildClientConfig,
  buildPreviewDiagnostics,
  dedupeDraftsAndPublished,
  resolveSanityConfig,
  SanityPreviewConfigError,
} from "./sanity-shared";
import type { AppToolData, RawAppToolDoc, SanityEnvLike } from "./sanity-shared";

export { APP_TOOLS_QUERY, SanityPreviewConfigError };
export type { AppToolData };

/**
 * Resolves the effective env this module reads from, with an explicit,
 * documented precedence per var:
 *
 * - `PUBLIC_SANITY_PROJECT_ID` / `PUBLIC_SANITY_DATASET` /
 *   `PUBLIC_SANITY_API_VERSION`: read from `import.meta.env` — Astro/Vite
 *   DOES populate these correctly (they match the `PUBLIC_` envPrefix),
 *   so this is unchanged from before this fix.
 * - `SANITY_PREVIEW_DRAFTS` / `SANITY_API_TOKEN` (server-only, never
 *   `PUBLIC_`-prefixed, never exposed to the browser): (1) `process.env`
 *   — an explicit shell-set value (e.g. PowerShell's `$env:X="true"`)
 *   always wins; (2) `import.meta.env` — kept as a fallback since it's
 *   what this project's own Vitest suite stubs via `vi.stubEnv`, and a
 *   future envPrefix change could populate it too; (3) `undefined`, which
 *   `resolveSanityConfig` treats as "preview disabled" / "no token".
 */
function resolveRuntimeSanityEnv(): SanityEnvLike {
  const meta = (import.meta.env ?? {}) as Record<string, string | undefined>;
  const proc: NodeJS.ProcessEnv = typeof process !== "undefined" && process.env ? process.env : {};

  return {
    PUBLIC_SANITY_PROJECT_ID: meta.PUBLIC_SANITY_PROJECT_ID,
    PUBLIC_SANITY_DATASET: meta.PUBLIC_SANITY_DATASET,
    PUBLIC_SANITY_API_VERSION: meta.PUBLIC_SANITY_API_VERSION,
    SANITY_PREVIEW_DRAFTS: proc.SANITY_PREVIEW_DRAFTS ?? meta.SANITY_PREVIEW_DRAFTS,
    SANITY_API_TOKEN: proc.SANITY_API_TOKEN ?? meta.SANITY_API_TOKEN,
  };
}

const resolvedConfig = resolveSanityConfig(resolveRuntimeSanityEnv());

/** True only when SANITY_PREVIEW_DRAFTS=true and SANITY_API_TOKEN is resolved — see resolveRuntimeSanityEnv. Read by BaseLayout.astro to show a preview banner; never used to alter production behavior implicitly. */
export const SANITY_PREVIEW_MODE = resolvedConfig.previewMode;

const client =
  resolvedConfig.projectId && resolvedConfig.dataset ? createClient(buildClientConfig(resolvedConfig)) : null;

if (SANITY_PREVIEW_MODE) {
  // Server-only console log — built from buildPreviewDiagnostics, which
  // never includes the token or any credential value, only booleans and
  // the non-secret perspective/useCdn/project-configured-or-not fields.
  const diagnostics = buildPreviewDiagnostics(resolvedConfig);
  console.log("[sanity] Preview mode diagnostics:", JSON.stringify(diagnostics));
}

let cachedApps: Promise<AppToolData[]> | null = null;

async function resolveRawAppList(): Promise<AppToolData[]> {
  if (!client) {
    return fallbackApps;
  }

  try {
    const docs = await client.fetch<RawAppToolDoc[]>(APP_TOOLS_QUERY);
    if (!docs || docs.length === 0) return fallbackApps;

    const deduped = dedupeDraftsAndPublished(docs);
    if (SANITY_PREVIEW_MODE) {
      console.log(
        `[sanity] Preview fetch: ${docs.length} raw appTool record(s), slugs: [${docs.map((d) => d.slug).join(", ")}], ` +
          `${deduped.length} after deduplication.`
      );
    }
    return deduped;
  } catch (err) {
    console.warn("[sanity] Could not fetch app data, falling back to src/data/apps.ts:", err);
    return fallbackApps;
  }
}

/**
 * Resolves every app's `image`/`screenshot.image` to a path guaranteed to
 * exist under `public/` (see src/lib/images.ts) — applied once here so no
 * component needs its own existence check, and so a generated draft whose
 * cover image was never illustrated never causes a missing-file request.
 */
async function fetchApps(): Promise<AppToolData[]> {
  return applyImageFallbacks(await resolveRawAppList());
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
