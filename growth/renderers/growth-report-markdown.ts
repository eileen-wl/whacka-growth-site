import type { EvidenceEntry, FinalGrowthReport } from "../types/growth-report";

function formatEvidenceValue(value: EvidenceEntry["value"]): string {
  if (value === null) return "Unavailable";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function formatMetric(value: number | null): string {
  return value === null ? "Unavailable" : String(value);
}

function resolveEvidenceRefs(ids: string[], catalogById: Map<string, EvidenceEntry>): string {
  if (ids.length === 0) return "_none cited_";
  return ids
    .map((id) => {
      const entry = catalogById.get(id);
      return entry ? `\`${id}\` (${entry.label}: ${formatEvidenceValue(entry.value)})` : `\`${id}\` (unresolved)`;
    })
    .join(", ");
}

/**
 * Renders a validated FinalGrowthReport into readable Markdown. Pure
 * formatting only — the LLM never generates Markdown directly, and this
 * function never re-derives or recalculates a metric.
 */
export function renderGrowthReportMarkdown(report: FinalGrowthReport): string {
  const catalogById = new Map(report.evidenceCatalog.map((entry) => [entry.id, entry]));
  const { analysis } = report;
  const lines: string[] = [];

  lines.push("# Growth Report", "");

  lines.push("## Reporting Period", "", `${report.period.start} to ${report.period.end}`, "");

  lines.push("## Campaign", "", `**${report.campaign.name}** (\`${report.campaign.id}\`)`, "");

  lines.push(
    "## Executive Summary",
    "",
    `**${analysis.executiveSummary.headline}**`,
    "",
    analysis.executiveSummary.summary,
    "",
    `Confidence: ${analysis.executiveSummary.confidence}`,
    ""
  );

  lines.push(
    "## Performance Snapshot",
    "",
    "### Traffic (GA4)",
    "",
    `- Sessions: ${formatMetric(report.metrics.traffic.overview.sessions)}`,
    `- Screen/page views: ${formatMetric(report.metrics.traffic.overview.screenPageViews)}`,
    `- Engaged sessions: ${formatMetric(report.metrics.traffic.overview.engagedSessions)}`,
    `- Engagement rate: ${formatMetric(report.metrics.traffic.overview.engagementRate)}`,
    `- Active users: ${formatMetric(report.metrics.traffic.overview.activeUsers)}`,
    "",
    "### Behavior (PostHog)",
    "",
    `- Pageviews: ${formatMetric(report.metrics.behavior.eventTotals.pageViews)}`,
    `- Total CTA clicks: ${formatMetric(report.metrics.behavior.eventTotals.totalCtaClicks)}`,
    `- View demo clicks: ${formatMetric(report.metrics.behavior.eventTotals.viewDemoClicks)}`,
    `- Remix clicks: ${formatMetric(report.metrics.behavior.eventTotals.remixClicks)}`,
    `- Build clicks: ${formatMetric(report.metrics.behavior.eventTotals.buildClicks)}`,
    `- Copy prompt clicks: ${formatMetric(report.metrics.behavior.eventTotals.copyPromptClicks)}`,
    "",
    "### Search (Search Console)",
    "",
    `- Status: ${report.metrics.search.status}`,
    `- Clicks: ${formatMetric(report.metrics.search.totals.clicks)}`,
    `- Impressions: ${formatMetric(report.metrics.search.totals.impressions)}`,
    `- CTR: ${formatMetric(report.metrics.search.totals.ctr)}`,
    `- Average position: ${formatMetric(report.metrics.search.totals.averagePosition)}`,
    "",
    "### Product Conversions (Whacka)",
    "",
    `- Status: ${report.metrics.productConversions.status}`,
    `- Signups: ${formatMetric(report.metrics.productConversions.signups)}`,
    `- First app created: ${formatMetric(report.metrics.productConversions.firstAppCreated)}`,
    `- App published: ${formatMetric(report.metrics.productConversions.appPublished)}`,
    ""
  );

  lines.push("## Key Findings", "");
  if (analysis.findings.length === 0) lines.push("_No findings reported._", "");
  for (const finding of analysis.findings) {
    lines.push(`### ${finding.title} (${finding.category})`, "");
    lines.push(`- **Observation:** ${finding.observation}`);
    lines.push(`- **Interpretation:** ${finding.interpretation}`);
    lines.push(`- **Confidence:** ${finding.confidence}`);
    lines.push(`- **Evidence:** ${resolveEvidenceRefs(finding.evidenceRefs, catalogById)}`);
    if (finding.caveats.length > 0) lines.push(`- **Caveats:** ${finding.caveats.join("; ")}`);
    lines.push("");
  }

  lines.push("## Funnel Observations", "");
  if (analysis.funnelObservations.length === 0) lines.push("_None reported._", "");
  for (const obs of analysis.funnelObservations) {
    lines.push(`- **${obs.stage}:** ${obs.observation} (confidence: ${obs.confidence}; evidence: ${resolveEvidenceRefs(obs.evidenceRefs, catalogById)})`);
  }
  lines.push("");

  lines.push("## Channel and Content Observations", "");
  if (analysis.channelAndContentObservations.length === 0) lines.push("_None reported._", "");
  for (const obs of analysis.channelAndContentObservations) {
    lines.push(`### ${obs.title}`, "");
    lines.push(`- **Observation:** ${obs.observation}`);
    lines.push(`- **Confidence:** ${obs.confidence}`);
    lines.push(`- **Evidence:** ${resolveEvidenceRefs(obs.evidenceRefs, catalogById)}`);
    if (obs.caveats.length > 0) lines.push(`- **Caveats:** ${obs.caveats.join("; ")}`);
    lines.push("");
  }

  lines.push("## Anomalies or Notable Signals", "");
  if (analysis.anomaliesOrNotableSignals.length === 0) lines.push("_None reported._", "");
  for (const anomaly of analysis.anomaliesOrNotableSignals) {
    lines.push(`### ${anomaly.title} (severity: ${anomaly.severity})`, "");
    lines.push(`- **Description:** ${anomaly.description}`);
    lines.push(`- **Requires further validation:** ${anomaly.requiresFurtherValidation ? "Yes" : "No"}`);
    lines.push(`- **Evidence:** ${resolveEvidenceRefs(anomaly.evidenceRefs, catalogById)}`);
    lines.push("");
  }

  lines.push("## Data Limitations", "");
  if (analysis.dataLimitations.length === 0) {
    lines.push("_None reported by the analysis._", "");
  } else {
    for (const limitation of analysis.dataLimitations) {
      lines.push(`### ${limitation.title}`, "");
      lines.push(`- **Impact:** ${limitation.impact}`);
      lines.push(`- **Related evidence:** ${resolveEvidenceRefs(limitation.relatedEvidenceRefs, catalogById)}`);
      lines.push("");
    }
  }
  lines.push("### Deterministic Data-Quality Summary", "");
  lines.push(`- **Overall status:** ${report.dataQuality.overallStatus}`);
  lines.push(`- **Missing sources:** ${report.dataQuality.missingSources.length > 0 ? report.dataQuality.missingSources.join(", ") : "None"}`);
  lines.push(`- **Empty sources:** ${report.dataQuality.emptySources.length > 0 ? report.dataQuality.emptySources.join(", ") : "None"}`);
  if (report.dataQuality.warnings.length > 0) {
    lines.push("- **Warnings:**");
    for (const warning of report.dataQuality.warnings) lines.push(`  - ${warning}`);
  }
  if (report.dataQuality.measurementNotes.length > 0) {
    lines.push("- **Measurement notes:**");
    for (const note of report.dataQuality.measurementNotes) lines.push(`  - ${note}`);
  }
  lines.push("");

  lines.push("## Signals for the Decision Agent", "");
  if (analysis.decisionInputs.signalsWorthReviewing.length === 0) lines.push("_None reported._", "");
  for (const signal of analysis.decisionInputs.signalsWorthReviewing) {
    lines.push(
      `- **${signal.signal}:** ${signal.whyItMatters} (confidence: ${signal.confidence}; evidence: ${resolveEvidenceRefs(signal.evidenceRefs, catalogById)})`
    );
  }
  lines.push("");

  lines.push("## Questions for the Decision Agent", "");
  for (const question of analysis.decisionInputs.questionsForDecisionAgent) {
    lines.push(`- **${question.question}** — ${question.reason} (evidence: ${resolveEvidenceRefs(question.evidenceRefs, catalogById)})`);
  }
  lines.push("");

  lines.push("## Evidence Index", "");
  lines.push("| ID | Label | Value | Source | Measurement basis |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const entry of report.evidenceCatalog) {
    lines.push(`| \`${entry.id}\` | ${entry.label} | ${formatEvidenceValue(entry.value)} | ${entry.source} | ${entry.measurementBasis} |`);
  }
  lines.push("");

  lines.push("## Generation Metadata", "");
  lines.push(`- **Provider:** ${report.generation.provider}${report.generation.isMock ? " (MOCK — not a real analysis)" : ""}`);
  lines.push(`- **Model:** ${report.generation.model}`);
  lines.push(`- **Language:** ${report.generation.language}`);
  lines.push(`- **Stop reason:** ${report.generation.stopReason ?? "Unavailable"}`);
  lines.push(`- **Request ID:** ${report.generation.requestId ?? "Unavailable"}`);
  lines.push(`- **Input tokens:** ${formatMetric(report.generation.usage.inputTokens)}`);
  lines.push(`- **Output tokens:** ${formatMetric(report.generation.usage.outputTokens)}`);
  lines.push(`- **Generated at:** ${report.generatedAt}`);
  lines.push(`- **Source summary:** ${report.provenance.sourceSummaryFilename} (sha256: \`${report.provenance.sourceSummarySha256}\`)`);
  lines.push("");

  return lines.join("\n");
}
