import { apps } from "../../src/data/apps";
import type { ExistingContentCatalogEntry } from "../types/signal-mining";

/**
 * Builds the existing-content catalog from the real `src/data/apps.ts`
 * fixture data — the same file `scripts/seed.ts` seeds into Sanity and
 * `src/lib/sanity.ts` falls back to when Sanity isn't configured — never a
 * hardcoded duplicate list. Deliberately reads this static file rather than
 * calling `getApps()` (which may hit Sanity over the network when
 * configured): Signal Mining must stay fully offline and deterministic, and
 * this file already IS the project's source-of-truth app fixture data. If
 * Sanity content ever diverges meaningfully from this file, a future
 * revision can add a Sanity-backed variant — not in scope here.
 *
 * `AppData` (src/data/apps.ts) only has `ctaLabel`/`ctaHref`/`prompt` — no
 * `demoUrl`/`remixUrl`/`buildUrl` (those are Sanity-only `AppToolData`
 * fields, and no `status` field either). `availableCtaTypes` and `status`
 * below are derived strictly from what's actually present, never invented:
 * every app has a prompt (`copy_prompt` always available) and a ctaLabel/
 * ctaHref pair (treated as a `build`-type CTA, matching every current
 * fixture's "Build {App} with Whacka" label) — `view_demo`/`remix` are never
 * claimed available since no app data field currently supports them.
 */
export function buildExistingContentCatalog(): ExistingContentCatalogEntry[] {
  return apps.map((app) => ({
    appSlug: app.slug,
    appName: app.name,
    hook: app.tagline,
    status: "unknown",
    route: `/apps/${app.slug}`,
    availableCtaTypes: ["build", "copy_prompt"],
  }));
}
