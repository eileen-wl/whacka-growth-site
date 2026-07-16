import type { FinalSignalMiningRun } from "../types/signal-mining";

function formatMetric(value: number | null): string {
  return value === null ? "Unavailable" : String(value);
}

function formatList(values: string[], emptyLabel = "None"): string {
  return values.length === 0 ? emptyLabel : values.join(", ");
}

/**
 * Renders a validated FinalSignalMiningRun into readable Markdown. Pure
 * formatting only — the LLM never generates Markdown directly, and this
 * function never re-derives or recalculates anything.
 */
export function renderSignalMiningMarkdown(run: FinalSignalMiningRun): string {
  const lines: string[] = [];

  lines.push("# Signal Mining Review", "");

  if (run.generation.isMock) {
    lines.push("> ⚠ This run was produced by the **Mock Provider** — not a real market signal assessment.", "");
  }
  if (run.provenance.sourceFeedbackIsMock) {
    lines.push("> ⚠ The supplied Growth Loop Feedback was **mock-generated** — treated as a low-confidence, non-strategic instruction.", "");
  }

  lines.push("## Reporting Period", "", `${run.period.start} to ${run.period.end}`, "");

  lines.push("## Campaign", "", `**${run.campaign.name}** (\`${run.campaign.id}\`)`, "");

  lines.push("## Input Sources", "");
  lines.push(`- **Growth Summary:** ${run.provenance.sourceSummaryFilename ?? "None supplied"}`);
  lines.push(`- **Growth Loop Feedback:** ${run.provenance.sourceFeedbackFilename ?? "None supplied"}${run.provenance.sourceFeedbackIsMock ? " (MOCK)" : ""}`);
  lines.push(`- **Manual input:** ${run.provenance.manualInputFilename ?? "None supplied"}`);
  lines.push(`- **Source records collected:** ${run.sourceSummary.recordsCollected}`);
  lines.push(`- **Source records used:** ${run.sourceSummary.recordsUsed}`);
  lines.push(`- **Source records omitted by limit:** ${run.sourceSummary.recordsOmittedByLimit}`);
  lines.push(`- **Source types:** ${formatList(run.sourceSummary.sourceTypes)}`);
  lines.push("");

  lines.push("## Data Quality", "");
  lines.push(`- **Overall status:** ${run.dataQuality.overallStatus}`);
  if (run.dataQuality.warnings.length > 0) {
    lines.push("- **Warnings:**");
    for (const warning of run.dataQuality.warnings) lines.push(`  - ${warning}`);
  }
  if (run.dataQuality.limitations.length > 0) {
    lines.push("- **Limitations:**");
    for (const limitation of run.dataQuality.limitations) lines.push(`  - ${limitation}`);
  }
  lines.push("");

  lines.push("## Signals Identified", "");
  if (run.signals.length === 0) {
    lines.push("_No signals identified — evidence was insufficient for this run._", "");
  } else {
    for (const signal of run.signals) {
      lines.push(`### ${signal.title}`, "");
      lines.push(`- **Signal type:** ${signal.signalType}`);
      lines.push(`- **Summary:** ${signal.summary}`);
      lines.push(`- **Confidence:** ${signal.quality.confidence}`);
      lines.push(`- **Freshness:** ${signal.quality.freshness}`);
      lines.push(`- **Duplicate status:** ${signal.quality.duplicateStatus}`);
      lines.push(`- **Source:** ${signal.source.name} (\`${signal.source.type}\`)`);
      lines.push(
        `- **Keywords:** ${formatList(signal.entities.keywords)} | **Topics:** ${formatList(signal.entities.topics)} | **Audiences:** ${formatList(signal.entities.audiences)} | **Products/apps:** ${formatList(signal.entities.productsOrApps)} | **Channels:** ${formatList(signal.entities.channels)}`
      );
      if (signal.metrics.length > 0) {
        lines.push("- **Metrics:**");
        for (const metric of signal.metrics) {
          lines.push(`  - ${metric.name}: ${formatMetric(metric.value)}${metric.unit ? ` ${metric.unit}` : ""}`);
        }
      }
      if (signal.quality.limitations.length > 0) {
        lines.push(`- **Limitations:** ${formatList(signal.quality.limitations)}`);
      }
      lines.push(`- **Source record references:** ${formatList(signal.provenance.sourceRecordIds)}`);
      lines.push(`- **Signal ID:** \`${signal.id}\``);
      lines.push("");
    }
  }

  lines.push("## Topic Pool", "");
  if (run.topicPool.length === 0) {
    lines.push("_No topic candidates formed — evidence was insufficient for this run._", "");
  } else {
    for (const topic of run.topicPool) {
      lines.push(`### ${topic.canonicalName}`, "");
      lines.push(`- **Slug:** \`${topic.slug}\``);
      lines.push(`- **Review status:** ${topic.status}`);
      lines.push(`- **Problem statement:** ${topic.problemStatement}`);
      lines.push(`- **Target audience:** ${topic.targetAudience}`);
      lines.push(`- **Use cases:** ${formatList(topic.useCases)}`);
      lines.push(`- **Desired outcome:** ${topic.desiredOutcome}`);
      lines.push(`- **Supporting signal IDs:** ${formatList(topic.signalRefs)}`);
      lines.push(`- **Evidence confidence:** ${topic.evidenceSummary.confidence} (signals: ${topic.evidenceSummary.signalCount}, sources: ${topic.evidenceSummary.sourceCount}, source types: ${formatList(topic.evidenceSummary.sourceTypes)})`);
      lines.push(
        `- **Relationship to existing content:** ${topic.relationshipToExistingContent.status}${topic.relationshipToExistingContent.relatedAppSlugs.length > 0 ? ` (${formatList(topic.relationshipToExistingContent.relatedAppSlugs)})` : ""}`
      );
      if (topic.evidenceSummary.limitations.length > 0) {
        lines.push(`- **Limitations:** ${formatList(topic.evidenceSummary.limitations)}`);
      }
      lines.push(`- **Topic ID:** \`${topic.id}\``);
      lines.push("");
    }
  }

  lines.push("## Unresolved Source Records", "");
  if (run.unresolvedSourceRecords.length === 0) {
    lines.push("_None reported._", "");
  } else {
    lines.push("| Source Record | Reason | Note |");
    lines.push("| --- | --- | --- |");
    for (const entry of run.unresolvedSourceRecords) {
      lines.push(`| \`${entry.sourceRecordRef}\` | ${entry.reason} | ${entry.note} |`);
    }
    lines.push("");
  }

  lines.push("## Growth Loop Feedback Context", "");
  if (!run.provenance.sourceFeedbackFilename) {
    lines.push("_No Growth Loop Feedback was supplied for this run._", "");
  } else {
    lines.push(`- **Source decision status:** ${run.provenance.sourceFeedbackSha256 ? "loaded" : "unavailable"}`);
    lines.push(`- **Mock-generated:** ${run.provenance.sourceFeedbackIsMock ? "Yes" : "No"}`);
    lines.push(`- **File:** ${run.provenance.sourceFeedbackFilename} (sha256: \`${run.provenance.sourceFeedbackSha256 ?? "unavailable"}\`)`);
    lines.push("");
  }

  lines.push("## Human Review", "");
  lines.push(`- **Required:** ${run.humanReview.required ? "Yes" : "No"}`);
  lines.push(`- **Approved:** ${run.humanReview.approved ? "Yes" : "No"}`);
  lines.push(`- **Approved by:** ${run.humanReview.approvedBy ?? "Unavailable"}`);
  lines.push(`- **Approved at:** ${run.humanReview.approvedAt ?? "Unavailable"}`);
  lines.push(`- **Note:** ${run.humanReview.note}`);
  lines.push("");

  lines.push("## Deduplication", "");
  lines.push(`- **Input signal proposals:** ${run.deduplication.inputSignalProposalCount}`);
  lines.push(`- **Final signal count:** ${run.deduplication.finalSignalCount}`);
  lines.push(`- **Duplicates removed:** ${run.deduplication.duplicatesRemoved}`);
  lines.push("");

  lines.push("## Generation Metadata", "");
  lines.push(`- **Provider:** ${run.generation.provider}${run.generation.isMock ? " (MOCK — not a real analysis)" : ""}`);
  lines.push(`- **Model:** ${run.generation.model}`);
  lines.push(`- **Language:** ${run.generation.language}`);
  lines.push(`- **Stop reason:** ${run.generation.stopReason ?? "Unavailable"}`);
  lines.push(`- **Request ID:** ${run.generation.requestId ?? "Unavailable"}`);
  lines.push(`- **Input tokens:** ${formatMetric(run.generation.usage.inputTokens)}`);
  lines.push(`- **Output tokens:** ${formatMetric(run.generation.usage.outputTokens)}`);
  lines.push(`- **Generated at:** ${run.generatedAt}`);
  lines.push("");

  return lines.join("\n");
}
