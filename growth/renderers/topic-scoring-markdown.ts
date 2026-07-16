import type { FinalTopicScoringRun } from "../types/topic-scoring";
import type { TopicCandidate } from "../contracts/topic-candidate";

function formatMetric(value: number | null): string {
  return value === null ? "Unavailable" : String(value);
}

function formatList(values: string[], emptyLabel = "None"): string {
  return values.length === 0 ? emptyLabel : values.join(", ");
}

/**
 * Renders a validated FinalTopicScoringRun into readable Markdown. Pure
 * formatting only — the LLM never generates Markdown directly, and this
 * function never re-derives or recalculates a score.
 */
export function renderTopicScoringMarkdown(run: FinalTopicScoringRun): string {
  const topicsById = new Map<string, TopicCandidate>(run.topicCatalog.map((topic) => [topic.id, topic]));
  const adjustmentsByTopicId = new Map(run.confidenceAdjustments.map((adjustment) => [adjustment.topicId, adjustment]));

  const lines: string[] = [];

  lines.push("# Topic Scoring Review", "");

  if (run.generation.isMock) {
    lines.push("> ⚠ This run was produced by the **Mock Provider** — not a real market ranking.", "");
  }
  if (run.provenance.sourceSignalMiningIsMock) {
    lines.push("> ⚠ The source Signal Mining run was **mock-generated** — every score here is derived from placeholder evidence.", "");
  }
  if (!run.provenance.sourceSignalsHumanReviewed) {
    lines.push("> ⚠ The source signals/topics have **not been human-approved** — this reduces final confidence and blocks automatic advancement.", "");
  }
  lines.push("> An **advance** recommendation is not approval and does not trigger Asset Generation. A human must still review and select topics.", "");

  lines.push("## Reporting Period", "", `${run.period.start} to ${run.period.end}`, "");

  lines.push("## Campaign", "", `**${run.campaign.name}** (\`${run.campaign.id}\`)`, "");

  lines.push("## Input Status", "");
  lines.push(`- **Source Signal Mining file:** ${run.provenance.sourceSignalMiningFilename}`);
  lines.push(`- **Source mock-generated:** ${run.provenance.sourceSignalMiningIsMock ? "Yes" : "No"}`);
  lines.push(`- **Source human-approved:** ${run.provenance.sourceSignalsHumanReviewed ? "Yes" : "No"}`);
  lines.push(`- **Data-quality status:** ${run.dataQuality.overallStatus}`);
  lines.push(`- **Scoring profile:** ${run.scoringProfile.id}@${run.scoringProfile.version}`);
  lines.push("");

  lines.push("## Scoring Rubric", "");
  lines.push("| Dimension | Weight | Meaning |");
  lines.push("| --- | --- | --- |");
  for (const dimension of run.scoringProfile.dimensions) {
    lines.push(`| ${dimension.label} (\`${dimension.key}\`) | ${dimension.weight} | ${dimension.description} |`);
  }
  lines.push("");
  lines.push(
    `A dimension using the policy-default fallback score (**${run.scoringProfile.insufficientEvidenceFallbackScore}**) means ` +
      "insufficient evidence to move the score positively or negatively — never a measured average.",
    ""
  );
  lines.push("**Recommendation rules:**", "");
  lines.push(`- **advance:** ${run.scoringProfile.recommendationRules.advance}`);
  lines.push(`- **needs_human_review:** ${run.scoringProfile.recommendationRules.needsHumanReview}`);
  lines.push(`- **hold:** ${run.scoringProfile.recommendationRules.hold}`);
  lines.push(`- **reject:** ${run.scoringProfile.recommendationRules.reject}`);
  lines.push("");

  lines.push("## Ranked Topics", "");
  if (run.scoredTopics.length === 0) {
    lines.push("_No topics were scored — the source topic pool was empty._", "");
  } else {
    for (const scored of run.scoredTopics) {
      const topic = topicsById.get(scored.topicId);
      const adjustment = adjustmentsByTopicId.get(scored.topicId);
      lines.push(`### #${scored.ranking?.rank ?? "?"} — ${topic?.canonicalName ?? scored.topicId}`, "");
      lines.push(`- **Total score:** ${scored.totalScore} / 100`);
      lines.push(`- **Recommendation:** ${scored.recommendation}`);
      lines.push(`- **Final confidence:** ${scored.confidence}`);
      if (adjustment) {
        lines.push(`- **Confidence adjusted from:** ${adjustment.originalConfidence} → ${adjustment.finalConfidence} (${formatList(adjustment.reasons)})`);
      }
      lines.push(`- **Supporting signals:** ${topic?.signalRefs.length ?? "Unavailable"}`);
      lines.push(
        `- **Relationship to existing content:** ${topic?.relationshipToExistingContent.status ?? "Unavailable"}${
          topic && topic.relationshipToExistingContent.relatedAppSlugs.length > 0
            ? ` (${formatList(topic.relationshipToExistingContent.relatedAppSlugs)})`
            : ""
        }`
      );
      lines.push(`- **Blockers:** ${scored.blockers.length === 0 ? "None" : formatList(scored.blockers)}`);
      lines.push(`- **Topic ID:** \`${scored.topicId}\` · **ScoredTopic ID:** \`${scored.id}\``);
      lines.push("");
    }
  }

  lines.push("## Dimension Breakdown", "");
  for (const scored of run.scoredTopics) {
    const topic = topicsById.get(scored.topicId);
    lines.push(`### ${topic?.canonicalName ?? scored.topicId}`, "");
    lines.push("| Dimension | Score | Weight | Weighted | Basis | Rationale |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const dimension of scored.dimensions) {
      const basis = dimension.scoreBasis === "policy_default" ? "policy-default" : "evidence-based";
      lines.push(
        `| ${dimension.label} | ${dimension.score} | ${dimension.weight} | ${dimension.weightedScore} | ${basis} | ${dimension.rationale} |`
      );
    }
    lines.push("");
    for (const dimension of scored.dimensions) {
      if (dimension.limitations.length > 0 || dimension.signalRefs.length > 0 || dimension.evidenceRefs.length > 0) {
        lines.push(
          `- **${dimension.label}:** signals: ${formatList(dimension.signalRefs)}; evidence: ${formatList(dimension.evidenceRefs)}; limitations: ${formatList(dimension.limitations)}`
        );
      }
    }
    lines.push("");
  }

  lines.push("## Portfolio Observations", "");
  lines.push(`- **Topic coverage:** ${run.portfolioObservations.topicCoverage}`);
  lines.push(`- **Evidence coverage:** ${run.portfolioObservations.evidenceCoverage}`);
  if (run.portfolioObservations.majorLimitations.length > 0) {
    lines.push("- **Major limitations:**");
    for (const limitation of run.portfolioObservations.majorLimitations) lines.push(`  - ${limitation}`);
  }
  lines.push("");

  lines.push("## Data and Evidence Limitations", "");
  if (run.dataQuality.warnings.length > 0) {
    lines.push("- **Warnings:**");
    for (const warning of run.dataQuality.warnings) lines.push(`  - ${warning}`);
  }
  if (run.dataQuality.limitations.length > 0) {
    lines.push("- **Limitations:**");
    for (const limitation of run.dataQuality.limitations) lines.push(`  - ${limitation}`);
  }
  lines.push(
    "- Competition scores reflect only supplied evidence and content overlap with this campaign's own catalog — no external market data was used.",
    "- No Whacka product-side conversion data was invented for any dimension.",
    ""
  );

  lines.push("## Human Review Required", "");
  lines.push(`- **Required:** ${run.humanReview.required ? "Yes" : "No"}`);
  lines.push(`- **Approved:** ${run.humanReview.approved ? "Yes" : "No"}`);
  lines.push(`- **Selected topic IDs:** ${formatList(run.humanReview.selectedTopicIds)}`);
  lines.push(`- **Approved by:** ${run.humanReview.approvedBy ?? "Unavailable"}`);
  lines.push(`- **Approved at:** ${run.humanReview.approvedAt ?? "Unavailable"}`);
  lines.push(`- **Note:** ${run.humanReview.note}`);
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
  lines.push(
    `- **Source Signal Mining run:** ${run.provenance.sourceSignalMiningFilename} (sha256: \`${run.provenance.sourceSignalMiningSha256}\`, mock: ${run.provenance.sourceSignalMiningIsMock ? "Yes" : "No"})`
  );
  lines.push("");

  return lines.join("\n");
}
