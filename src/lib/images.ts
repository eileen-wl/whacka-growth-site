import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppToolData } from "./sanity-shared";

/**
 * Deterministic, build/render-time cover-image fallback.
 *
 * Generated apps (growth/agents/asset-generation-agent.ts) used to write a
 * guessed `/images/{slug}/cover.svg` path without ever creating the file —
 * that path only ever gets a real file once a bespoke illustration is
 * commissioned for the app. This module is the single place that turns any
 * `image`/`screenshot.image` path with no real file under `public/` into
 * the shared neutral fallback asset, so no page ever requests a missing
 * image. It never guesses existence from a slug — it checks the real
 * filesystem — so old Sanity documents, new generated drafts, and the
 * five hand-authored apps are all handled by the same rule.
 */

export const FALLBACK_COVER_IMAGE = "/images/_fallback/cover.svg";

export interface ImageExistenceDeps {
  /** Absolute path to the Astro `public/` directory. Defaults to `<cwd>/public`. Injectable for tests. */
  publicDir?: string;
  /** Defaults to `node:fs`'s `existsSync`. Injectable for tests so no real filesystem access is required. */
  exists?: (absolutePath: string) => boolean;
}

function defaultPublicDir(): string {
  return join(process.cwd(), "public");
}

/**
 * Resolves a single image path to something guaranteed to exist under
 * `public/`: the path unchanged if a real file backs it, otherwise
 * `FALLBACK_COVER_IMAGE`. A remote `http(s)://` URL is passed through
 * unchanged — it isn't a local asset this project owns, so there is
 * nothing on disk to verify.
 */
export function resolveImageSrc(path: string | undefined | null, deps: ImageExistenceDeps = {}): string {
  if (!path || path.trim().length === 0) return FALLBACK_COVER_IMAGE;
  if (/^https?:\/\//i.test(path)) return path;

  const exists = deps.exists ?? existsSync;
  const publicDir = deps.publicDir ?? defaultPublicDir();
  const normalized = path.startsWith("/") ? path : `/${path}`;

  return exists(join(publicDir, normalized)) ? normalized : FALLBACK_COVER_IMAGE;
}

/**
 * Applies `resolveImageSrc` to an app's cover image and every screenshot.
 * Called once, in `src/lib/sanity.ts`, for every app list returned to a
 * page or component — so `AppCard.astro`/`AppDetail.astro` never need
 * their own existence check and can keep rendering `app.image` as-is.
 */
export function applyImageFallbacks(apps: AppToolData[], deps: ImageExistenceDeps = {}): AppToolData[] {
  return apps.map((app) => ({
    ...app,
    image: resolveImageSrc(app.image, deps),
    screenshots: app.screenshots.map((shot) => ({ ...shot, image: resolveImageSrc(shot.image, deps) })),
  }));
}
