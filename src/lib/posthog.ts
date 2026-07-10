import posthog from "posthog-js";

let initialized = false;

/**
 * Initializes PostHog in the browser only. If PUBLIC_POSTHOG_KEY or
 * PUBLIC_POSTHOG_HOST is unset, this is a no-op — the site (and every CTA)
 * works identically with or without analytics configured; src/lib/
 * tracking.ts falls back to a dev-only console log when window.posthog
 * never gets set here.
 *
 * Sets window.posthog so the provider-agnostic trackGrowthEvent() in
 * src/lib/tracking.ts can find it without importing posthog-js directly —
 * that file stays unaware of which analytics SDKs are actually installed.
 */
export function initPostHog(): void {
  if (typeof window === "undefined" || initialized) return;

  const apiKey = import.meta.env.PUBLIC_POSTHOG_KEY;
  const apiHost = import.meta.env.PUBLIC_POSTHOG_HOST;

  if (!apiKey || !apiHost) return;

  try {
    posthog.init(apiKey, {
      api_host: apiHost,
      capture_pageview: true,
      // Growth Data Specification v1 events are captured explicitly via
      // trackGrowthEvent/data-track-event; autocapture would double up on
      // every click site-wide with untyped, unrelated events.
      autocapture: false,
    });
    window.posthog = posthog;
    initialized = true;
  } catch (err) {
    console.warn("[posthog] failed to initialize:", err);
  }
}
