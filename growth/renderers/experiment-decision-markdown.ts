import type { EvidenceEntry } from "../types/growth-report";
import type { FinalExperimentDecision, FindingCatalogEntry, LimitationCatalogEntry } from "../types/experiment-decision";

function formatEvidenceValue(value: EvidenceEntry["value"]): string {
  if (value === null) return "Unavailable";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function formatMetric(value: number | null): string {
  return value === null ? "Unavailable" : String(value);
}

interface RefMaps {
  evidenceById: Map<string, EvidenceEntry>;
  findingById: Map<string, FindingCatalogEntry>;
  limitationById: Map<string, LimitationCatalogEntry>;
}

function resolveRef(id: string, maps: RefMaps): string {
  const evidence = maps.evidenceById.get(id);
  if (evidence) return `\`${id}\` (${evidence.label}: ${formatEvidenceValue(evidence.value)})`;
  const finding = maps.findingById.get(id);
  if (finding) return `\`${id}\` (${finding.title})`;
  const limitation = maps.limitationById.get(id);
  if (limitation) return `\`${id}\` (${limitation.title})`;
  return `\`${id}\` (unresolved)`;
}

function resolveRefs(ids: string[], maps: RefMaps): string {
  return ids.length === 0 ? "_none cited_" : ids.map((id) => resolveRef(id, maps)).join(", ");
}

/**
 * Renders a validated FinalExperimentDecision into readable Markdown. Pure
 * formatting only — the LLM never generates Markdown directly, and this
 * function never re-derives or recalculates a decision.
 */
export function renderExperimentDecisionMarkdown(decision: FinalExperimentDecision): string {
  const maps: RefMaps = {
    evidenceById: new Map(decision.evidenceCatalog.map((entry) => [entry.id, entry])),
    findingById: new Map(decision.findingCatalog.map((entry) => [entry.id, entry])),
    limitationById: new Map(decision.limitationCatalog.map((entry) => [entry.id, entry])),
  };
  const { decision: analysis } = decision;
  const isProceed = analysis.decisionSummary.decisionStatus === "proceed";
  const lines: string[] = [];

  lines.push("# Experiment Decision Brief", "");

  lines.push("## Decision Status", "", `**${analysis.decisionSummary.decisionStatus.toUpperCase()}**`, "");
  if (decision.provenance.sourceGrowthReportIsMock) {
    lines.push("> ⚠ The source Growth Report was **mock-generated** — this decision is derived from placeholder analysis, not real strategic input.", "");
  }
  if (decision.generation.isMock) {
    lines.push("> ⚠ This decision itself was produced by the **Mock Provider** — not a real analysis.", "");
  }

  lines.push("## Reporting Period", "", `${decision.period.start} to ${decision.period.end}`, "");

  lines.push("## Campaign", "", `**${decision.campaign.name}** (\`${decision.campaign.id}\`)`, "");

  if (isProceed && analysis.recommendedExperiment) {
    const r = analysis.recommendedExperiment;
    lines.push("## Recommendation", "", `**${analysis.decisionSummary.headline}**`, "");
    lines.push(`- **Experiment ID:** ${r.experimentId}`);
    lines.push(`- **Confidence:** ${r.confidence}`);
    lines.push("");

    lines.push("## Why This Decision", "", analysis.decisionSummary.rationale, "");

    lines.push("## Ranked Experiment Options", "");
    if (analysis.rankedExperimentOptions.length === 0) {
      lines.push("_None reported._", "");
    }
    for (const option of analysis.rankedExperimentOptions) {
      lines.push(`### #${option.rank} — ${option.title} (${option.lever})${option.id === r.experimentId ? " — RECOMMENDED" : ""}`, "");
      lines.push(`- **Target:** topic/app: ${option.target.topicOrApp ?? "Unavailable"}, CTA: ${option.target.ctaType ?? "Unavailable"}, channel: ${option.target.channel ?? "Unavailable"}`);
      lines.push(`- **Hypothesis:** ${option.hypothesis}`);
      lines.push(`- **Confidence:** ${option.confidence}`);
      lines.push(`- **Evidence:** ${resolveRefs(option.evidenceRefs, maps)}`);
      lines.push(`- **Findings:** ${resolveRefs(option.findingRefs, maps)}`);
      lines.push(`- **Limitations:** ${resolveRefs(option.limitationRefs, maps)}`);
      if (option.whyNotHigherRanked) lines.push(`- **Why not higher ranked:** ${option.whyNotHigherRanked}`);
      lines.push("");
    }

    lines.push("## Recommended Experiment Brief", "", r.objective, "");

    lines.push("## Hypothesis", "", r.hypothesis, "");

    lines.push("## Proposed Change", "", r.implementationBrief.change, "");
    if (r.implementationBrief.unchangedElements.length > 0) {
      lines.push("Unchanged elements:");
      for (const item of r.implementationBrief.unchangedElements) lines.push(`- ${item}`);
      lines.push("");
    }
    lines.push(`- **Target pages/apps:** ${r.implementationBrief.targetPagesOrApps.length > 0 ? r.implementationBrief.targetPagesOrApps.join(", ") : "Unavailable"}`);
    lines.push(`- **Target CTA:** ${r.implementationBrief.targetCta ?? "Unavailable"}`);
    lines.push(`- **Target channel:** ${r.implementationBrief.targetChannel ?? "Unavailable"}`);
    lines.push("");

    const recommendedOption = analysis.rankedExperimentOptions.find((option) => option.id === r.experimentId);
    lines.push("## Control and Variant", "");
    lines.push(`- **Control:** ${recommendedOption?.controlDescription ?? "Unavailable"}`);
    lines.push(`- **Variant:** ${recommendedOption?.variantDescription ?? "Unavailable"}`);
    lines.push("");

    lines.push("## Measurement Plan", "");
    lines.push(`- **Primary metric:** ${resolveRef(r.measurementPlan.primaryMetricRef, maps)}`);
    lines.push(`- **Secondary metrics:** ${resolveRefs(r.measurementPlan.secondaryMetricRefs, maps)}`);
    lines.push(`- **Guardrail metrics:** ${resolveRefs(r.measurementPlan.guardrailMetricRefs, maps)}`);
    lines.push(`- **Success criterion:** ${r.measurementPlan.successCriterion}`);
    lines.push(`- **Failure criterion:** ${r.measurementPlan.failureCriterion}`);
    lines.push(`- **Minimum observation requirement:** ${r.measurementPlan.minimumObservationRequirement}`);
    if (r.measurementPlan.knownMeasurementLimitations.length > 0) {
      lines.push("- **Known measurement limitations:**");
      for (const item of r.measurementPlan.knownMeasurementLimitations) lines.push(`  - ${item}`);
    }
    lines.push("");

    lines.push("## Evidence", "");
    lines.push(`- **Evidence:** ${resolveRefs(r.evidenceRefs, maps)}`);
    lines.push(`- **Findings:** ${resolveRefs(r.findingRefs, maps)}`);
    lines.push("");

    lines.push("## Risks and Dependencies", "");
    if (recommendedOption) {
      lines.push(`- **Dependencies:** ${recommendedOption.dependencies.length > 0 ? recommendedOption.dependencies.join("; ") : "None"}`);
      lines.push(`- **Risks:** ${recommendedOption.risks.length > 0 ? recommendedOption.risks.join("; ") : "None"}`);
    } else {
      lines.push("_Unavailable — the recommended option's own entry was not found in rankedExperimentOptions._");
    }
    lines.push("");
  } else {
    lines.push("## Decision Deferred", "", `**${analysis.decisionSummary.headline}**`, "");

    lines.push("## Why the Decision Was Deferred", "", analysis.decisionSummary.rationale, "");

    if (analysis.deferDecision) {
      lines.push("## Missing Evidence", "");
      for (const item of analysis.deferDecision.missingEvidence) lines.push(`- ${item}`);
      lines.push("");

      lines.push("## Required Next Observations", "");
      for (const observation of analysis.deferDecision.requiredNextObservations) {
        lines.push(`- ${observation.observation} (related: ${resolveRefs(observation.relatedEvidenceOrLimitationRefs, maps)})`);
      }
      lines.push("");

      lines.push("## Earliest Decision Condition", "", analysis.deferDecision.earliestDecisionCondition, "");
    } else {
      lines.push("## Missing Evidence", "", "_Unavailable._", "");
      lines.push("## Required Next Observations", "", "_Unavailable._", "");
      lines.push("## Earliest Decision Condition", "", "_Unavailable._", "");
    }

    if (analysis.rankedExperimentOptions.length > 0) {
      lines.push("## Ranked Experiment Options", "", "_Provisional options considered but not recommended:_", "");
      for (const option of analysis.rankedExperimentOptions) {
        lines.push(`### #${option.rank} — ${option.title} (${option.lever})`, "");
        lines.push(`- **Hypothesis:** ${option.hypothesis}`);
        lines.push(`- **Confidence:** ${option.confidence}`);
        lines.push(`- **Evidence:** ${resolveRefs(option.evidenceRefs, maps)}`);
        lines.push("");
      }
    }
  }

  lines.push("## Rejected or Deferred Options", "");
  if (analysis.rejectedOrDeferredOptions.length === 0) {
    lines.push("_None reported._", "");
  } else {
    for (const option of analysis.rejectedOrDeferredOptions) {
      lines.push(`- **${option.title}:** ${option.reason} (evidence: ${resolveRefs(option.evidenceRefs, maps)}; limitations: ${resolveRefs(option.limitationRefs, maps)})`);
    }
    lines.push("");
  }

  lines.push("## Data Limitations", "");
  lines.push("| ID | Title | Impact |");
  lines.push("| --- | --- | --- |");
  for (const entry of decision.limitationCatalog) {
    lines.push(`| \`${entry.id}\` | ${entry.title} | ${entry.impact} |`);
  }
  lines.push("");
  lines.push(`- **Overall data-quality status:** ${decision.dataQuality.overallStatus}`);
  if (decision.dataQuality.warnings.length > 0) {
    lines.push("- **Warnings:**");
    for (const warning of decision.dataQuality.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");

  lines.push("## Handoff to the Next Growth Loop Stage", "");
  if (analysis.handoff.forNextLoop.length === 0) {
    lines.push("_Nothing handed off._", "");
  } else {
    for (const item of analysis.handoff.forNextLoop) {
      lines.push(`- **[${item.destination}]** ${item.item} — ${item.reason}`);
    }
    lines.push("");
  }

  lines.push("## Human Review", "");
  lines.push(`- **Required:** ${decision.humanReview.required ? "Yes" : "No"}`);
  lines.push(`- **Approved:** ${decision.humanReview.approved ? "Yes" : "No"}`);
  lines.push(`- **Approved by:** ${decision.humanReview.approvedBy ?? "Unavailable"}`);
  lines.push(`- **Approved at:** ${decision.humanReview.approvedAt ?? "Unavailable"}`);
  lines.push(`- **Note:** ${decision.humanReview.note}`);
  lines.push("");

  lines.push("## Generation Metadata", "");
  lines.push(`- **Provider:** ${decision.generation.provider}${decision.generation.isMock ? " (MOCK — not a real analysis)" : ""}`);
  lines.push(`- **Model:** ${decision.generation.model}`);
  lines.push(`- **Language:** ${decision.generation.language}`);
  lines.push(`- **Stop reason:** ${decision.generation.stopReason ?? "Unavailable"}`);
  lines.push(`- **Request ID:** ${decision.generation.requestId ?? "Unavailable"}`);
  lines.push(`- **Input tokens:** ${formatMetric(decision.generation.usage.inputTokens)}`);
  lines.push(`- **Output tokens:** ${formatMetric(decision.generation.usage.outputTokens)}`);
  lines.push(`- **Generated at:** ${decision.generatedAt}`);
  lines.push(
    `- **Source Growth Report:** ${decision.provenance.sourceGrowthReportFilename} (sha256: \`${decision.provenance.sourceGrowthReportSha256}\`, mock: ${decision.provenance.sourceGrowthReportIsMock ? "Yes" : "No"})`
  );
  lines.push("");

  return lines.join("\n");
}
