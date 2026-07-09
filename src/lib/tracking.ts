import { UTM_CAMPAIGN, UTM_SOURCE } from "./utm";

/** Growth Data Specification v1 event names. */
export type GrowthEventName =
  | "view_demo_click"
  | "remix_click"
  | "build_click"
  | "copy_prompt_click";

/** Per-click context supplied by the caller; trackGrowthEvent fills in the rest. */
export interface GrowthEventInput {
  pageType: string;
  appSlug?: string;
  appName?: string;
  utmContent?: string;
  destinationUrl?: string;
  ctaText?: string;
}

/** Full Growth Data Specification v1 event payload sent to analytics providers. */
export interface GrowthEventProperties {
  event_name: string;
  timestamp: string;
  page_url: string;
  page_slug: string;
  page_type: string;
  app_slug: string;
  app_name: string;
  campaign_id: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  destination_url: string;
  cta_text: string;
  [key: string]: string;
}

type GtagFn = (...args: unknown[]) => void;
type PosthogCaptureFn = (eventName: string, properties?: Record<string, unknown>) => void;

declare global {
  interface Window {
    gtag?: GtagFn;
    posthog?: { capture: PosthogCaptureFn };
  }
}

// Internal campaign identifier. Same value as UTM_CAMPAIGN today, kept as a
// separate field because campaign_id (internal/CRM-facing) and utm_campaign
// (the public querystring tag) are allowed to diverge later.
const CAMPAIGN_ID = UTM_CAMPAIGN;

// utm_medium doubles as the event's medium for consistency with the actual
// destination URLs built in src/lib/utm.ts.
const EVENT_UTM_MEDIUM: Record<GrowthEventName, string> = {
  view_demo_click: "demo_click",
  remix_click: "remix_click",
  build_click: "build_click",
  copy_prompt_click: "copy_prompt_click",
};

function derivePageSlug(pathname: string): string {
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  return trimmed.length > 0 ? trimmed : "home";
}

function buildProperties(
  eventName: GrowthEventName,
  input: GrowthEventInput
): GrowthEventProperties {
  return {
    event_name: eventName,
    timestamp: new Date().toISOString(),
    page_url: window.location.href,
    page_slug: derivePageSlug(window.location.pathname),
    page_type: input.pageType,
    app_slug: input.appSlug ?? "",
    app_name: input.appName ?? "",
    campaign_id: CAMPAIGN_ID,
    utm_source: UTM_SOURCE,
    utm_medium: EVENT_UTM_MEDIUM[eventName],
    utm_campaign: UTM_CAMPAIGN,
    utm_content: input.utmContent ?? "",
    destination_url: input.destinationUrl ?? "",
    cta_text: input.ctaText ?? "",
  };
}

/**
 * Sends a Growth Data Specification v1 event to whichever analytics
 * provider is already loaded on the page. Provider-agnostic by design:
 * this file never loads a GA4/PostHog script itself, it only calls the
 * global `gtag`/`posthog` hooks if something else on the page already set
 * them up. Safe to call with neither present — falls back to a dev-only
 * console log so CTAs never depend on analytics being configured, and
 * never throws, so callers never need to guard navigation on it.
 */
export function trackGrowthEvent(eventName: GrowthEventName, properties: GrowthEventInput): void {
  if (typeof window === "undefined") return;

  const payload = buildProperties(eventName, properties);
  let delivered = false;

  try {
    if (typeof window.gtag === "function") {
      window.gtag("event", eventName, payload);
      delivered = true;
    }

    if (typeof window.posthog?.capture === "function") {
      window.posthog.capture(eventName, payload);
      delivered = true;
    }
  } catch (err) {
    // A misbehaving analytics SDK should never break the CTA it's attached to.
    console.warn(`[growth-tracking] provider threw for "${eventName}":`, err);
    return;
  }

  if (!delivered && import.meta.env.DEV) {
    console.log(`[growth-tracking] ${eventName}`, payload);
  }
}
