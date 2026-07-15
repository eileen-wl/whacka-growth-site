export interface DateRange {
  start: string;
  end: string;
}

export interface CampaignInfo {
  id: string;
  name: string;
}

export type InputStatus = "ok" | "missing" | "invalid";
export type SearchConsoleInputStatus = "ok" | "empty" | "missing" | "invalid";

export interface PostHogInputMeta {
  status: InputStatus;
  filename?: string;
  collectedAt?: string;
  rowCount?: number;
}

export interface GA4ReportRowCounts {
  trafficOverview: number;
  trafficAcquisition: number;
  landingPages: number;
}

export interface GA4InputMeta {
  status: InputStatus;
  filename?: string;
  collectedAt?: string;
  reportRowCounts?: GA4ReportRowCounts;
}

export interface GSCReportRowCounts {
  dailyOverview: number;
  queries: number;
  queryPages: number;
  pages: number;
}

export interface SearchConsoleInputMeta {
  status: SearchConsoleInputStatus;
  filename?: string;
  collectedAt?: string;
  reportRowCounts?: GSCReportRowCounts;
}

export interface GrowthSummaryInputs {
  posthog: PostHogInputMeta;
  ga4: GA4InputMeta;
  searchConsole: SearchConsoleInputMeta;
}

export interface TrafficOverview {
  sessions: number;
  screenPageViews: number;
  engagedSessions: number;
  /** engagedSessions / sessions, recomputed from the additive totals — never an average of daily rates. Null when sessions is 0. */
  engagementRate: number | null;
  /**
   * Period-level unique active users, only populated when GA4 returns a
   * reliable period total (not derived by summing daily activeUsers, since
   * the same person can appear on multiple days). Null when unavailable.
   */
  activeUsers: number | null;
  activeUsersMeasurementNote: string | null;
}

export interface TrafficAcquisitionRow {
  date: string;
  source: string;
  medium: string;
  campaign: string;
  sessions: number;
  engagedSessions: number;
  engagementRate: number | null;
}

export interface LandingPageRow {
  date: string;
  landingPage: string;
  sessions: number;
  screenPageViews: number;
  engagedSessions: number;
  engagementRate: number | null;
}

export interface TopSourceAggregate {
  source: string;
  medium: string;
  campaign: string;
  sessions: number;
  engagedSessions: number;
  engagementRate: number | null;
}

export interface TopLandingPageAggregate {
  landingPage: string;
  sessions: number;
  screenPageViews: number;
  engagedSessions: number;
  engagementRate: number | null;
}

export interface Traffic {
  overview: TrafficOverview;
  acquisition: TrafficAcquisitionRow[];
  landingPages: LandingPageRow[];
  /** Acquisition rows grouped by source/medium/campaign, sorted by sessions descending. */
  topSources: TopSourceAggregate[];
  /** Landing-page rows grouped by landing page, sorted by sessions descending. */
  topLandingPages: TopLandingPageAggregate[];
}

export interface EventTotals {
  pageViews: number;
  viewDemoClicks: number;
  remixClicks: number;
  buildClicks: number;
  copyPromptClicks: number;
  totalCtaClicks: number;
}

export interface ByAppRow {
  appSlug: string;
  appName: string | null;
  pageViews: number;
  viewDemoClicks: number;
  remixClicks: number;
  buildClicks: number;
  copyPromptClicks: number;
  totalCtaClicks: number;
  /** totalCtaClicks / pageViews for this app group specifically. Null when pageViews is 0. */
  eventBasedCtaRate: number | null;
}

/** One group's event counts for a byPageType/byUtmSource/byUtmMedium/byUtmCampaign/byUtmContent breakdown. `key` is that dimension's value, or "unassigned" when absent. */
export interface ByDimensionRow {
  key: string;
  pageViews: number;
  viewDemoClicks: number;
  remixClicks: number;
  buildClicks: number;
  copyPromptClicks: number;
  totalCtaClicks: number;
}

export interface Behavior {
  eventTotals: EventTotals;
  /**
   * Always null in the current PostHog snapshot design: the raw snapshot
   * only contains unique_users grouped by dimension, and the same
   * distinct_id can appear in multiple groups, so grouped values cannot be
   * summed into a reliable site-wide unique-user count.
   */
  uniqueUsers: number | null;
  uniqueUsersMeasurementNote: string;
  byApp: ByAppRow[];
  byPageType: ByDimensionRow[];
  byUtmSource: ByDimensionRow[];
  byUtmMedium: ByDimensionRow[];
  byUtmCampaign: ByDimensionRow[];
  byUtmContent: ByDimensionRow[];
}

export interface SearchTotals {
  clicks: number;
  impressions: number;
  /** total clicks / total impressions, recomputed from the additive totals — never an average of row-level CTR. Null when impressions is 0. */
  ctr: number | null;
  /** Impressions-weighted average position. Null when total impressions is 0. */
  averagePosition: number | null;
}

export interface SearchDailyRow {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export interface SearchQueryRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export interface SearchPageRow {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export interface SearchQueryPageRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export type SearchStatus = "ok" | "empty" | "missing";

export interface Search {
  status: SearchStatus;
  totals: SearchTotals;
  daily: SearchDailyRow[];
  /** queries report rows, sorted by clicks desc then impressions desc, capped at 20. */
  topQueries: SearchQueryRow[];
  /** pages report rows, sorted by clicks desc then impressions desc, capped at 20. */
  topPages: SearchPageRow[];
  queryPages: SearchQueryPageRow[];
}

export interface GrowthSiteFunnel {
  pageViews: number;
  totalCtaClicks: number;
  /** totalCtaClicks / pageViews — an event-count ratio, not a user or session conversion rate. Null when pageViews is 0. */
  eventBasedCtaRate: number | null;
  viewDemoClicks: number;
  remixClicks: number;
  buildClicks: number;
  copyPromptClicks: number;
  measurementBasis: "PostHog event counts";
}

export interface Funnel {
  growthSite: GrowthSiteFunnel;
}

export interface ProductConversions {
  signups: null;
  firstAppCreated: null;
  appPublished: null;
  status: "not_connected";
  note: string;
}

export interface DataQuality {
  overallStatus: "complete" | "partial" | "invalid";
  dateRangeMatch: boolean;
  missingSources: string[];
  emptySources: string[];
  warnings: string[];
  measurementNotes: string[];
}

/** The on-disk shape written to growth/data/processed/growth-summary-{start}_to_{end}.json. */
export interface GrowthSummary {
  schemaVersion: "1.0.0";
  source: "normalized_growth_summary";
  generatedAt: string;
  period: DateRange;
  campaign: CampaignInfo;
  inputs: GrowthSummaryInputs;
  traffic: Traffic;
  behavior: Behavior;
  search: Search;
  funnel: Funnel;
  productConversions: ProductConversions;
  dataQuality: DataQuality;
}
