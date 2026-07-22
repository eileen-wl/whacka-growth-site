/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_SANITY_PROJECT_ID?: string;
  readonly PUBLIC_SANITY_DATASET?: string;
  readonly PUBLIC_SANITY_API_VERSION?: string;
  readonly PUBLIC_POSTHOG_KEY?: string;
  readonly PUBLIC_POSTHOG_HOST?: string;
  readonly PUBLIC_SITE_URL?: string;
  readonly PUBLIC_GOOGLE_SITE_VERIFICATION?: string;
  readonly PUBLIC_GA_MEASUREMENT_ID?: string;
  /** Server-only — deliberately NOT PUBLIC_-prefixed, so Astro/Vite never inlines it into a client bundle. See src/lib/sanity.ts. */
  readonly SANITY_API_TOKEN?: string;
  /** Server-only local preview flag, default false. See "Sanity draft preview mode" in growth/README.md. */
  readonly SANITY_PREVIEW_DRAFTS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
