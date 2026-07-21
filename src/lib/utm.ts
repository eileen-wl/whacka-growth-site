import type { AppToolData } from "./sanity";

/** The subset of AppToolData needed to build CTA/UTM links. */
export type UtmAppSource = Pick<
  AppToolData,
  "slug" | "prompt" | "demoUrl" | "remixUrl" | "buildUrl" | "utmContent"
>;

export interface UtmParams {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  [key: string]: string;
}

// Exported so src/lib/tracking.ts can report the exact same utm_source/
// utm_campaign values baked into these links, instead of duplicating them.
export const UTM_SOURCE = "growth_site";
export const UTM_CAMPAIGN = "small_business_toolkit";
/** The one shared, platform-wide "start building" destination — not tied to any specific app. Exported so growth/agents/asset-generation-agent.ts can reuse this exact, already-existing value as a newly generated app's buildUrl fallback instead of inventing one. */
export const HOMEPAGE_DASHBOARD_URL = "https://whacka.app/dashboard";

function hasValue(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Sets (or overwrites) query params on a URL, encoding values via
 * URLSearchParams. Returns undefined instead of throwing if `url` isn't a
 * valid absolute URL, so callers can hide a CTA rather than render "#".
 */
function withParams(url: string, params: Record<string, string>): string | undefined {
  try {
    const target = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      target.searchParams.set(key, value);
    }
    return target.toString();
  } catch {
    return undefined;
  }
}

/** Adds the growth-site UTM params to a URL. Returns undefined if `url` is invalid/empty. */
export function addUtmParams(url: string, params: UtmParams): string | undefined {
  return withParams(url, params);
}

/**
 * The utm_content value used for a given app's links. Exported so tracking
 * code can report the same value that's actually baked into the CTA's href.
 * Falls back to the app's slug so a link never ships an empty utm_content
 * param just because the CMS field hasn't been filled in yet.
 */
export function getUtmContent(app: Pick<UtmAppSource, "slug" | "utmContent">): string {
  return hasValue(app.utmContent) ? app.utmContent : app.slug;
}

/** "View demo" link, or undefined if the app has no demoUrl. */
export function createDemoUrl(app: UtmAppSource): string | undefined {
  if (!hasValue(app.demoUrl)) return undefined;

  return addUtmParams(app.demoUrl, {
    utm_source: UTM_SOURCE,
    utm_medium: "demo_click",
    utm_campaign: UTM_CAMPAIGN,
    utm_content: getUtmContent(app),
  });
}

/**
 * "Remix app" link. Prefers remixUrl; falls back to buildUrl with the app's
 * prompt pre-filled via a `prompt` query param. Returns undefined if neither
 * remixUrl nor buildUrl is set.
 */
export function createRemixUrl(app: UtmAppSource): string | undefined {
  const utmParams: UtmParams = {
    utm_source: UTM_SOURCE,
    utm_medium: "remix_click",
    utm_campaign: UTM_CAMPAIGN,
    utm_content: getUtmContent(app),
  };

  if (hasValue(app.remixUrl)) {
    return addUtmParams(app.remixUrl, utmParams);
  }

  if (hasValue(app.buildUrl)) {
    // Prompt prefill relies on Whacka's build flow reading a `prompt` query
    // param on page load. If that contract ever changes on Whacka's side,
    // this fallback needs to change with it. URLSearchParams handles the
    // encoding, so the raw prompt text is safe to pass in as-is.
    return withParams(app.buildUrl, { prompt: app.prompt, ...utmParams });
  }

  return undefined;
}

/** "Build your own app" link for a specific app, or undefined if buildUrl is unset. */
export function createBuildUrl(app: UtmAppSource): string | undefined {
  if (!hasValue(app.buildUrl)) return undefined;

  return addUtmParams(app.buildUrl, {
    utm_source: UTM_SOURCE,
    utm_medium: "build_click",
    utm_campaign: UTM_CAMPAIGN,
    utm_content: getUtmContent(app),
  });
}

/** Homepage hero "Build your own app with Whacka" link — not tied to a specific app. */
export function createHomepageBuildUrl(): string {
  return (
    addUtmParams(HOMEPAGE_DASHBOARD_URL, {
      utm_source: UTM_SOURCE,
      utm_medium: "build_click",
      utm_campaign: UTM_CAMPAIGN,
      utm_content: "homepage",
    }) ?? HOMEPAGE_DASHBOARD_URL
  );
}
