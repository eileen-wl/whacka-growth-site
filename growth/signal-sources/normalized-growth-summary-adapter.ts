import { deterministicId } from "../lib/ids";
import type { SignalSourceAdapter, SignalSourceContext } from "./provider";
import type { ByDimensionRow, GrowthSummary } from "../types/growth-summary";
import type { SignalSourceRecord, SignalSourceRecordMetric } from "../types/signal-mining";

function metric(name: string, value: number | null, unit: string | null, measurementBasis: string, period: string | null): SignalSourceRecordMetric[] {
  return value === null ? [] : [{ name, value, unit, measurementBasis, period }];
}

/**
 * Builds deterministic `SignalSourceRecord`s from an already-loaded,
 * already-validated normalized Growth Summary (growth/types/growth-summary.ts)
 * — never from raw PostHog/GA4/Search Console snapshots directly, mirroring
 * the same boundary the Growth Report Agent already respects. No LLM call,
 * no network call; same inputs always produce the same records in the same
 * order.
 */
export class NormalizedGrowthSummaryAdapter implements SignalSourceAdapter {
  readonly name = "normalized_growth_summary";

  constructor(private readonly summary: GrowthSummary) {}

  async collect(context: SignalSourceContext): Promise<SignalSourceRecord[]> {
    const { summary } = this;
    const periodLabel = `${summary.period.start}_to_${summary.period.end}`;
    const records: SignalSourceRecord[] = [];

    const baseSource = (type: SignalSourceRecord["source"]["type"], name: string, recordId: string | null) => ({
      type,
      name,
      recordId,
      url: null,
      publishedAt: null,
      retrievedAt: summary.generatedAt,
      isInternal: true,
    });

    // --- GA4 acquisition (traffic.topSources) ---
    for (const row of summary.traffic.topSources) {
      const recordId = `${row.source}/${row.medium}/${row.campaign}`;
      records.push({
        id: deterministicId("sourcerecord", "ga4_acquisition", context.campaign.id, recordId),
        source: baseSource("ga4", "GA4 traffic acquisition", recordId),
        title: `Traffic source: ${row.source} / ${row.medium}`,
        content:
          `GA4 recorded ${row.sessions} sessions (${row.engagedSessions} engaged, engagement rate ${row.engagementRate ?? "unavailable"}) ` +
          `from source="${row.source}", medium="${row.medium}", campaign="${row.campaign}" during ${summary.period.start} to ${summary.period.end}.`,
        entities: { keywords: [], topics: [], audiences: [], productsOrApps: [], channels: [`${row.source} / ${row.medium}`] },
        metrics: [
          ...metric("sessions", row.sessions, "count", "GA4 topSources sessions for this source/medium/campaign.", periodLabel),
          ...metric("engagedSessions", row.engagedSessions, "count", "GA4 topSources engagedSessions for this source/medium/campaign.", periodLabel),
          ...metric("engagementRate", row.engagementRate, "ratio", "engagedSessions / sessions for this source/medium/campaign. Null when sessions is 0.", periodLabel),
        ],
        references: { evidenceRefs: [], findingRefs: [], limitationRefs: [] },
        quality: { confidence: "medium", limitations: [] },
      });
    }

    // --- GA4 landing pages (traffic.topLandingPages) ---
    for (const row of summary.traffic.topLandingPages) {
      records.push({
        id: deterministicId("sourcerecord", "ga4_landing_page", context.campaign.id, row.landingPage),
        source: baseSource("ga4", "GA4 landing pages", row.landingPage),
        title: `Landing page: ${row.landingPage}`,
        content:
          `GA4 recorded ${row.sessions} sessions and ${row.screenPageViews} screen/page views on landing page "${row.landingPage}" ` +
          `during ${summary.period.start} to ${summary.period.end}.`,
        entities: { keywords: [], topics: [], audiences: [], productsOrApps: [], channels: [] },
        metrics: [
          ...metric("sessions", row.sessions, "count", "GA4 topLandingPages sessions for this landing page.", periodLabel),
          ...metric("screenPageViews", row.screenPageViews, "count", "GA4 topLandingPages screenPageViews for this landing page.", periodLabel),
          ...metric("engagedSessions", row.engagedSessions, "count", "GA4 topLandingPages engagedSessions for this landing page.", periodLabel),
          ...metric("engagementRate", row.engagementRate, "ratio", "engagedSessions / sessions for this landing page. Null when sessions is 0.", periodLabel),
        ],
        references: { evidenceRefs: [], findingRefs: [], limitationRefs: [] },
        quality: { confidence: "medium", limitations: [] },
      });
    }

    // --- PostHog per-app activity (behavior.byApp) ---
    for (const row of summary.behavior.byApp) {
      if (row.appSlug === "unassigned") continue;
      records.push({
        id: deterministicId("sourcerecord", "posthog_app", context.campaign.id, row.appSlug),
        source: baseSource("posthog", "PostHog app performance", row.appSlug),
        title: `App activity: ${row.appName ?? row.appSlug}`,
        content:
          `PostHog recorded ${row.pageViews} pageviews and ${row.totalCtaClicks} total CTA clicks for app "${row.appSlug}" during ` +
          `${summary.period.start} to ${summary.period.end}. eventBasedCtaRate=${row.eventBasedCtaRate ?? "unavailable"} — an event-count ratio, ` +
          "not a user or session conversion rate.",
        entities: { keywords: [], topics: [], audiences: [], productsOrApps: [row.appSlug], channels: [] },
        metrics: [
          ...metric("pageViews", row.pageViews, "count", "PostHog byApp pageViews for this app.", periodLabel),
          ...metric("viewDemoClicks", row.viewDemoClicks, "count", "PostHog byApp view_demo_click count for this app.", periodLabel),
          ...metric("remixClicks", row.remixClicks, "count", "PostHog byApp remix_click count for this app.", periodLabel),
          ...metric("buildClicks", row.buildClicks, "count", "PostHog byApp build_click count for this app.", periodLabel),
          ...metric("copyPromptClicks", row.copyPromptClicks, "count", "PostHog byApp copy_prompt_click count for this app.", periodLabel),
          ...metric("totalCtaClicks", row.totalCtaClicks, "count", "Sum of the four CTA event counts for this app.", periodLabel),
          ...metric("eventBasedCtaRate", row.eventBasedCtaRate, "ratio", "totalCtaClicks / pageViews for this app — an event-count ratio, not a user or session conversion rate. Null when pageViews is 0.", periodLabel),
        ],
        references: { evidenceRefs: [], findingRefs: [], limitationRefs: [] },
        quality: { confidence: "medium", limitations: [] },
      });
    }

    // --- PostHog UTM groups (behavior.byUtm*) ---
    const utmGroups: { dimension: string; rows: ByDimensionRow[] }[] = [
      { dimension: "source", rows: summary.behavior.byUtmSource },
      { dimension: "medium", rows: summary.behavior.byUtmMedium },
      { dimension: "campaign", rows: summary.behavior.byUtmCampaign },
      { dimension: "content", rows: summary.behavior.byUtmContent },
    ];
    for (const group of utmGroups) {
      for (const row of group.rows) {
        if (row.key === "unassigned") continue;
        records.push({
          id: deterministicId("sourcerecord", "posthog_utm", context.campaign.id, group.dimension, row.key),
          source: baseSource("posthog", `PostHog UTM ${group.dimension} group`, row.key),
          title: `UTM ${group.dimension}: ${row.key}`,
          content:
            `PostHog recorded ${row.pageViews} pageviews and ${row.totalCtaClicks} total CTA clicks for utm_${group.dimension}="${row.key}" ` +
            `during ${summary.period.start} to ${summary.period.end}.`,
          entities: { keywords: [], topics: [], audiences: [], productsOrApps: [], channels: [`utm_${group.dimension}=${row.key}`] },
          metrics: [
            ...metric("pageViews", row.pageViews, "count", `PostHog byUtm${group.dimension} pageViews for this group.`, periodLabel),
            ...metric("totalCtaClicks", row.totalCtaClicks, "count", `PostHog byUtm${group.dimension} totalCtaClicks for this group.`, periodLabel),
          ],
          references: { evidenceRefs: [], findingRefs: [], limitationRefs: [] },
          quality: { confidence: "medium", limitations: [] },
        });
      }
    }

    // --- Search Console queries/pages — only when status is "ok". Empty or
    //     missing Search Console data never fabricates a keyword signal. ---
    if (summary.search.status === "ok") {
      for (const row of summary.search.topQueries) {
        records.push({
          id: deterministicId("sourcerecord", "search_console_query", context.campaign.id, row.query),
          source: baseSource("search_console", "Search Console queries", row.query),
          title: `Search query: "${row.query}"`,
          content:
            `Search Console recorded ${row.clicks} clicks and ${row.impressions} impressions for query "${row.query}" ` +
            `(CTR ${row.ctr ?? "unavailable"}, average position ${row.position ?? "unavailable"}) during ${summary.period.start} to ${summary.period.end}.`,
          entities: { keywords: [row.query], topics: [], audiences: [], productsOrApps: [], channels: ["organic_search"] },
          metrics: [
            ...metric("clicks", row.clicks, "count", "Search Console queries report clicks for this query.", periodLabel),
            ...metric("impressions", row.impressions, "count", "Search Console queries report impressions for this query.", periodLabel),
            ...metric("ctr", row.ctr, "ratio", "clicks / impressions for this query. Null when impressions is 0.", periodLabel),
            ...metric("position", row.position, "rank", "Average result position for this query. Null when impressions is 0.", periodLabel),
          ],
          references: { evidenceRefs: [], findingRefs: [], limitationRefs: [] },
          quality: { confidence: "medium", limitations: [] },
        });
      }

      for (const row of summary.search.topPages) {
        records.push({
          id: deterministicId("sourcerecord", "search_console_page", context.campaign.id, row.page),
          source: baseSource("search_console", "Search Console pages", row.page),
          title: `Search-landed page: ${row.page}`,
          content:
            `Search Console recorded ${row.clicks} clicks and ${row.impressions} impressions for page "${row.page}" ` +
            `(CTR ${row.ctr ?? "unavailable"}, average position ${row.position ?? "unavailable"}) during ${summary.period.start} to ${summary.period.end}.`,
          entities: { keywords: [], topics: [], audiences: [], productsOrApps: [], channels: ["organic_search"] },
          metrics: [
            ...metric("clicks", row.clicks, "count", "Search Console pages report clicks for this page.", periodLabel),
            ...metric("impressions", row.impressions, "count", "Search Console pages report impressions for this page.", periodLabel),
            ...metric("ctr", row.ctr, "ratio", "clicks / impressions for this page. Null when impressions is 0.", periodLabel),
            ...metric("position", row.position, "rank", "Average result position for this page. Null when impressions is 0.", periodLabel),
          ],
          references: { evidenceRefs: [], findingRefs: [], limitationRefs: [] },
          quality: { confidence: "medium", limitations: [] },
        });
      }
    }

    return records;
  }
}
