import { ensureUniqueId, slugify } from "../lib/ids";
import { buildGrowthReportLLMRequest } from "../prompts/growth-report-prompt";
import { growthReportAnalysisSchema } from "../types/growth-report";
import type { LLMProvider } from "../llm/provider";
import type { ByDimensionRow, CampaignInfo, DataQuality, GrowthSummary } from "../types/growth-summary";
import type {
  EvidenceEntry,
  EvidenceSource,
  EvidenceValue,
  FinalGrowthReport,
  GrowthReportAnalysis,
  LLMStructuredResult,
  SupportedLanguage,
} from "../types/growth-report";

/** How many "top N" rows (sources/landing pages/queries/pages) become individual evidence entries. Keeps the catalog — and the prompt — a bounded size. */
const EVIDENCE_TOP_N = 5;

export class GrowthReportValidationError extends Error {}

/**
 * Builds the deterministic, citable evidence catalog from a normalized
 * growth summary. This is the ONLY numeric ground truth the LLM may
 * reference (by ID) — the Normalizer already computed every value here, so
 * the model is never asked to recalculate a metric.
 */
export function buildEvidenceCatalog(summary: GrowthSummary): EvidenceEntry[] {
  const entries: EvidenceEntry[] = [];
  const used = new Set<string>();

  function add(id: string, label: string, value: EvidenceValue, source: EvidenceSource, measurementBasis: string): void {
    entries.push({ id: ensureUniqueId(id, used), label, value, source, measurementBasis });
  }

  // --- Traffic (GA4) ---
  const { overview, topSources, topLandingPages } = summary.traffic;
  add("traffic.sessions", "GA4 sessions", overview.sessions, "GA4", "Sum of daily sessions during the selected period.");
  add(
    "traffic.screen_page_views",
    "GA4 screen/page views",
    overview.screenPageViews,
    "GA4",
    "Sum of daily screenPageViews during the selected period."
  );
  add(
    "traffic.engaged_sessions",
    "GA4 engaged sessions",
    overview.engagedSessions,
    "GA4",
    "Sum of daily engagedSessions during the selected period."
  );
  add(
    "traffic.engagement_rate",
    "GA4 engagement rate",
    overview.engagementRate,
    "GA4",
    "engagedSessions / sessions for the whole period — not an average of daily rates. Null when sessions is 0."
  );
  if (overview.activeUsers !== null) {
    add(
      "traffic.active_users",
      "GA4 active users (period total)",
      overview.activeUsers,
      "GA4",
      "A GA4-reported period-level total, not a sum of daily activeUsers (which would double-count returning visitors)."
    );
  }

  topSources.slice(0, EVIDENCE_TOP_N).forEach((s, i) => {
    add(
      `traffic.top_source.${i + 1}`,
      `Top traffic source #${i + 1} by sessions: ${s.source} / ${s.medium} (campaign: ${s.campaign})`,
      s.sessions,
      "GA4",
      "Sessions attributed to this source/medium/campaign combination during the period."
    );
  });

  topLandingPages.slice(0, EVIDENCE_TOP_N).forEach((p, i) => {
    add(
      `traffic.top_landing_page.${i + 1}`,
      `Top landing page #${i + 1} by sessions: ${p.landingPage}`,
      p.sessions,
      "GA4",
      "Sessions attributed to this landing page during the period."
    );
  });

  // --- Behavior (PostHog) ---
  const { eventTotals, byApp, byUtmSource, byUtmMedium, byUtmCampaign, byUtmContent } = summary.behavior;
  add("behavior.page_views", "PostHog pageviews", eventTotals.pageViews, "PostHog", "Sum of $pageview event counts during the period.");
  add(
    "behavior.total_cta_clicks",
    "PostHog total CTA clicks",
    eventTotals.totalCtaClicks,
    "PostHog",
    "Sum of view_demo_click + remix_click + build_click + copy_prompt_click event counts."
  );
  add(
    "behavior.event_based_cta_rate",
    "Event-based CTA rate (not a user or session conversion rate)",
    summary.funnel.growthSite.eventBasedCtaRate,
    "PostHog",
    "totalCtaClicks / pageViews — an event-count ratio, not a user or session conversion rate. Null when pageViews is 0."
  );
  add("behavior.view_demo_clicks", "PostHog view_demo_click events", eventTotals.viewDemoClicks, "PostHog", "Sum of view_demo_click event counts.");
  add("behavior.remix_clicks", "PostHog remix_click events", eventTotals.remixClicks, "PostHog", "Sum of remix_click event counts.");
  add("behavior.build_clicks", "PostHog build_click events", eventTotals.buildClicks, "PostHog", "Sum of build_click event counts.");
  add("behavior.copy_prompt_clicks", "PostHog copy_prompt_click events", eventTotals.copyPromptClicks, "PostHog", "Sum of copy_prompt_click event counts.");

  for (const app of byApp) {
    add(
      `behavior.by_app.${slugify(app.appSlug)}`,
      `App performance: ${app.appName ?? app.appSlug} (${app.appSlug})`,
      app.totalCtaClicks,
      "PostHog",
      `Total CTA clicks for app "${app.appSlug}" during the period (pageViews: ${app.pageViews}, eventBasedCtaRate: ${
        app.eventBasedCtaRate ?? "unavailable"
      }).`
    );
  }

  const addUtmGroup = (rows: ByDimensionRow[], dimension: string): void => {
    for (const row of rows) {
      add(
        `behavior.by_utm_${dimension}.${slugify(row.key)}`,
        `UTM ${dimension} group: ${row.key}`,
        row.totalCtaClicks,
        "PostHog",
        `Total CTA clicks attributed to utm_${dimension}="${row.key}" during the period (pageViews: ${row.pageViews}).`
      );
    }
  };
  addUtmGroup(byUtmSource, "source");
  addUtmGroup(byUtmMedium, "medium");
  addUtmGroup(byUtmCampaign, "campaign");
  addUtmGroup(byUtmContent, "content");

  // --- Search (Search Console) ---
  const { search } = summary;
  add("search.status", "Search Console data status", search.status, "Search Console", 'One of "ok", "empty", or "missing" for this period.');
  add("search.clicks", "Search Console clicks", search.totals.clicks, "Search Console", "Sum of daily clicks during the period.");
  add("search.impressions", "Search Console impressions", search.totals.impressions, "Search Console", "Sum of daily impressions during the period.");
  add(
    "search.ctr",
    "Search Console CTR",
    search.totals.ctr,
    "Search Console",
    "Total clicks / total impressions for the whole period — not an average of daily CTR. Null when impressions is 0."
  );
  add(
    "search.average_position",
    "Search Console average position",
    search.totals.averagePosition,
    "Search Console",
    "Impressions-weighted average position across the period. Null when impressions is 0."
  );

  search.topQueries.slice(0, EVIDENCE_TOP_N).forEach((q, i) => {
    add(
      `search.top_query.${i + 1}`,
      `Top search query #${i + 1} by clicks: "${q.query}"`,
      q.clicks,
      "Search Console",
      "Clicks for this query during the period."
    );
  });
  search.topPages.slice(0, EVIDENCE_TOP_N).forEach((p, i) => {
    add(
      `search.top_page.${i + 1}`,
      `Top search-landed page #${i + 1} by clicks: ${p.page}`,
      p.clicks,
      "Search Console",
      "Clicks for this page during the period."
    );
  });

  // --- Data quality & product conversions ---
  const { dataQuality, productConversions } = summary;
  add(
    "data_quality.overall_status",
    "Overall data-quality status",
    dataQuality.overallStatus,
    "Normalizer",
    'One of "complete", "partial", or "invalid", set deterministically by the Normalizer.'
  );
  add(
    "data_quality.missing_sources",
    "Missing data sources",
    dataQuality.missingSources.length > 0 ? dataQuality.missingSources : "none",
    "Normalizer",
    "Sources with no raw snapshot found for this period."
  );
  add(
    "data_quality.empty_sources",
    "Empty data sources",
    dataQuality.emptySources.length > 0 ? dataQuality.emptySources : "none",
    "Normalizer",
    "Sources whose raw snapshot(s) contained zero rows for this period."
  );
  add("data_quality.warnings", "Data-quality warnings", dataQuality.warnings, "Normalizer", "Factual, code-generated warnings about this period's data.");
  add(
    "data_quality.measurement_notes",
    "Measurement notes",
    dataQuality.measurementNotes,
    "Normalizer",
    "Explanations of metrics that could not be safely derived and were left null."
  );
  add(
    "data_quality.product_conversions",
    "Whacka product-conversion connection status",
    productConversions.status,
    "Normalizer",
    productConversions.note
  );

  add("product_conversions.signups", "Whacka signups", productConversions.signups, "Normalizer", "Not connected yet — always unavailable (null), never 0.");
  add(
    "product_conversions.first_app_created",
    "Whacka first app created",
    productConversions.firstAppCreated,
    "Normalizer",
    "Not connected yet — always unavailable (null), never 0."
  );
  add(
    "product_conversions.app_published",
    "Whacka app published",
    productConversions.appPublished,
    "Normalizer",
    "Not connected yet — always unavailable (null), never 0."
  );

  return entries;
}

function collectEvidenceRefs(analysis: GrowthReportAnalysis): string[] {
  const refs: string[] = [];
  for (const f of analysis.findings) refs.push(...f.evidenceRefs);
  for (const f of analysis.funnelObservations) refs.push(...f.evidenceRefs);
  for (const c of analysis.channelAndContentObservations) refs.push(...c.evidenceRefs);
  for (const a of analysis.anomaliesOrNotableSignals) refs.push(...a.evidenceRefs);
  for (const d of analysis.dataLimitations) refs.push(...d.relatedEvidenceRefs);
  for (const s of analysis.decisionInputs.signalsWorthReviewing) refs.push(...s.evidenceRefs);
  for (const q of analysis.decisionInputs.questionsForDecisionAgent) refs.push(...q.evidenceRefs);
  return refs;
}

/**
 * Validates a provider's raw response before it's trusted downstream. Two
 * layers: (1) the static Zod schema — required/optional fields, enums,
 * string/array length bounds, no unknown keys; the Anthropic SDK already
 * enforces this client-side via `zodOutputFormat`, but the Mock Provider
 * (and any future provider) gets no such automatic check, so the agent
 * re-validates every provider's output here, not just Anthropic's.
 * (2) Cross-referential rules the static schema can't express: every cited
 * evidence ID must actually exist in the catalog, and a partial/invalid
 * data-quality status must come with at least one disclosed limitation.
 * Throws GrowthReportValidationError on any failure (never silently drops
 * or repairs anything) — callers must not write a final report when this
 * throws.
 */
export function validateAnalysis(
  rawData: unknown,
  evidenceCatalog: EvidenceEntry[],
  dataQualityStatus: DataQuality["overallStatus"]
): GrowthReportAnalysis {
  const parsed = growthReportAnalysisSchema.safeParse(rawData);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new GrowthReportValidationError(`Model response did not match the required schema: ${issues.join("; ")}`);
  }
  const analysis = parsed.data;

  const catalogIds = new Set(evidenceCatalog.map((entry) => entry.id));
  const unknownIds = [...new Set(collectEvidenceRefs(analysis).filter((id) => !catalogIds.has(id)))];

  if (unknownIds.length > 0) {
    throw new GrowthReportValidationError(
      `Model response referenced unknown evidence ID(s): ${unknownIds.join(", ")}. Every evidenceRefs value must exist in the evidence catalog.`
    );
  }

  if (dataQualityStatus !== "complete" && analysis.dataLimitations.length === 0) {
    throw new GrowthReportValidationError(
      `Data quality is "${dataQualityStatus}" but the response included no dataLimitations entries; at least one is required.`
    );
  }

  return analysis;
}

export interface RunGrowthReportAgentParams {
  summary: GrowthSummary;
  sourceSummaryFilename: string;
  sourceSummarySha256: string;
  language: SupportedLanguage;
  maxTokens: number;
  provider: LLMProvider;
  /** Injectable for deterministic tests; defaults to the current time. */
  generatedAt?: string;
}

/**
 * Runs the full Growth Report Agent pipeline against an already-loaded,
 * already-validated growth summary: build the evidence catalog, build the
 * LLM request, call the given provider, validate the response, and
 * assemble the final report. Depends only on the provider-neutral
 * LLMProvider interface — never imports an SDK directly.
 */
export async function runGrowthReportAgent(params: RunGrowthReportAgentParams): Promise<FinalGrowthReport> {
  const evidenceCatalog = buildEvidenceCatalog(params.summary);

  const request = buildGrowthReportLLMRequest({
    period: params.summary.period,
    campaign: params.summary.campaign,
    language: params.language,
    evidenceCatalog,
    dataQualityWarnings: params.summary.dataQuality.warnings,
    measurementNotes: params.summary.dataQuality.measurementNotes,
    maxTokens: params.maxTokens,
  });

  const result = await params.provider.generateStructuredReport(request);

  const analysis = validateAnalysis(result.data, evidenceCatalog, params.summary.dataQuality.overallStatus);

  return assembleFinalReport({
    summary: params.summary,
    campaign: params.summary.campaign,
    evidenceCatalog,
    result: { ...result, data: analysis },
    sourceSummaryFilename: params.sourceSummaryFilename,
    sourceSummarySha256: params.sourceSummarySha256,
    language: params.language,
    isMock: params.provider.name === "mock",
    generatedAt: params.generatedAt,
  });
}

interface AssembleFinalReportParams {
  summary: GrowthSummary;
  campaign: CampaignInfo;
  evidenceCatalog: EvidenceEntry[];
  result: LLMStructuredResult<GrowthReportAnalysis>;
  sourceSummaryFilename: string;
  sourceSummarySha256: string;
  language: SupportedLanguage;
  isMock: boolean;
  generatedAt?: string;
}

function assembleFinalReport(params: AssembleFinalReportParams): FinalGrowthReport {
  const { summary } = params;

  return {
    schemaVersion: "1.0.0",
    reportType: "growth_report",
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    period: summary.period,
    campaign: params.campaign,
    provenance: {
      sourceSummaryFilename: params.sourceSummaryFilename,
      sourceSummarySha256: params.sourceSummarySha256,
      sourceSummaryGeneratedAt: summary.generatedAt,
      dataQualityStatus: summary.dataQuality.overallStatus,
    },
    generation: {
      provider: params.result.provider,
      model: params.result.model,
      language: params.language,
      isMock: params.isMock,
      requestId: params.result.requestId,
      stopReason: params.result.stopReason,
      usage: { inputTokens: params.result.inputTokens, outputTokens: params.result.outputTokens },
    },
    metrics: {
      traffic: summary.traffic,
      behavior: summary.behavior,
      search: summary.search,
      productConversions: summary.productConversions,
    },
    evidenceCatalog: params.evidenceCatalog,
    analysis: params.result.data,
    dataQuality: summary.dataQuality,
  };
}
