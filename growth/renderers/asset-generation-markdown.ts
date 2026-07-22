import type { FinalAssetGenerationRun } from "../types/asset-generation";

function formatMetric(value: number | null): string {
  return value === null ? "Unavailable" : String(value);
}

function formatUrl(value: string | null): string {
  return value === null ? "Unavailable" : value;
}

function formatList(values: string[], emptyLabel = "None"): string {
  return values.length === 0 ? emptyLabel : values.join(", ");
}

/**
 * Renders a validated FinalAssetGenerationRun into readable Markdown. Pure
 * formatting only — the provider never generates Markdown directly, and
 * this function never re-derives or recalculates anything.
 */
export function renderAssetGenerationMarkdown(run: FinalAssetGenerationRun): string {
  const { assetBundle: bundle, selectedTopic, selectedScoredTopic } = run;
  const lines: string[] = [];

  lines.push("# Asset Generation Review", "");

  if (run.executionPurpose === "integration_test") {
    lines.push(
      "> 🛑 **ENGINEERING INTEGRATION TEST** — this run exists only to validate the Asset Generation → human review → CMS Writer " +
        "pipeline end-to-end. It is **not** a business-approved growth experiment.",
      `> Source topic recommendation: **${run.integrationTestReview?.sourceRecommendation ?? "unknown"}** — Topic Scoring was not overridden or mutated.`,
      `> Reviewed by: **${run.integrationTestReview?.reviewedBy ?? "unknown"}**${run.integrationTestReview?.reviewNote ? ` — "${run.integrationTestReview.reviewNote}"` : ""}`,
      "> Business approval: **not granted**. CMS write was not performed. The site was not modified. Publication is not approved.",
      ""
    );
  }
  if (run.generation.isMock) {
    lines.push("> ⚠ This content was produced by the **Mock Provider** — for engineering validation only, not real market copy.", "");
  }
  if (!run.provenance.sourceTopicsHumanReviewed) {
    lines.push("> ⚠ The selected topic was **not automatically approved** — a ranking or 'advance' recommendation is not human approval.", "");
  }
  if (run.provenance.allowUnapprovedTopicUsed || run.provenance.allowHoldTopicUsed || run.provenance.allowMockInputUsed) {
    const overrides = [
      run.provenance.allowMockInputUsed && "--allow-mock-input",
      run.provenance.allowUnapprovedTopicUsed && "--allow-unapproved-topic",
      run.provenance.allowHoldTopicUsed && "--allow-hold-topic",
    ].filter(Boolean);
    lines.push(`> ⚠ Override flag(s) used: ${overrides.join(", ")}. This is an explicit development override, not approval.`, "");
  }
  lines.push("> Asset Generation did **not** write to Sanity and did **not** modify or publish the website. AssetBundle must be reviewed before CMS Writer.", "");

  lines.push("## Reporting Period", "", `${run.period.start} to ${run.period.end}`, "");

  lines.push("## Campaign", "", `**${run.campaign.name}** (\`${run.campaign.id}\`)`, "");

  lines.push("## Selected Topic", "");
  lines.push(`- **Name:** ${selectedTopic.canonicalName}`);
  lines.push(`- **Topic ID:** \`${selectedTopic.id}\``);
  lines.push(`- **Score:** ${selectedScoredTopic.totalScore} / 100`);
  lines.push(`- **Rank:** ${selectedScoredTopic.ranking ? `#${selectedScoredTopic.ranking.rank} of ${selectedScoredTopic.ranking.candidateCount}` : "Unavailable"}`);
  lines.push(`- **Recommendation:** ${selectedScoredTopic.recommendation}`);
  lines.push(`- **Confidence:** ${selectedScoredTopic.confidence}`);
  lines.push(`- **Source Topic Scoring mock:** ${run.provenance.sourceTopicScoringIsMock ? "Yes" : "No"}`);
  lines.push(`- **Source human-reviewed:** ${run.provenance.sourceTopicsHumanReviewed ? "Yes" : "No"}`);
  lines.push(
    `- **Overrides used:** ${
      [
        run.provenance.allowMockInputUsed && "--allow-mock-input",
        run.provenance.allowUnapprovedTopicUsed && "--allow-unapproved-topic",
        run.provenance.allowHoldTopicUsed && "--allow-hold-topic",
      ]
        .filter(Boolean)
        .join(", ") || "None"
    }`
  );
  lines.push("");

  lines.push("## Proposed App", "");
  lines.push(`- **Name:** ${bundle.app.name}`);
  lines.push(`- **Slug:** \`${bundle.app.slug}\``);
  lines.push(`- **Status:** ${bundle.app.status}`);
  lines.push(`- **Tagline:** ${bundle.app.tagline}`);
  lines.push(`- **Category:** ${bundle.app.category}`);
  lines.push(`- **Short description:** ${bundle.app.shortDescription}`);
  lines.push(`- **Problem:** ${bundle.app.problem}`);
  lines.push(`- **Solution:** ${bundle.app.solution}`);
  lines.push(`- **Who it's for:** ${formatList(bundle.app.whoItsFor)}`);
  lines.push("");
  lines.push("### Creative Brief", "");
  lines.push(`- **Hook:** ${bundle.creativeBrief.hook}`);
  lines.push(`- **Persona:** ${bundle.creativeBrief.persona ?? "Unavailable"}`);
  lines.push(`- **Scenario:** ${bundle.creativeBrief.scenario ?? "Unavailable"}`);
  if (bundle.creativeBrief.steps.length > 0) {
    lines.push("- **Steps:**");
    for (const step of bundle.creativeBrief.steps) lines.push(`  1. ${step}`);
  }
  lines.push("");
  lines.push("### App Prompt (Whacka Prompt)", "", "```", bundle.app.appPrompt, "```", "");

  lines.push("## SEO Assets", "");
  lines.push("> SEO fields are persisted by the current Sanity `appTool` schema; CMS Writer will map them onto the draft document.", "");
  lines.push(`- **SEO title:** ${bundle.seo.title}`);
  lines.push(`- **Meta description:** ${bundle.seo.metaDescription}`);
  lines.push(`- **Primary keyword:** ${bundle.seo.primaryKeyword}`);
  lines.push(`- **Secondary keywords:** ${formatList(bundle.seo.secondaryKeywords)}`);
  if (bundle.app.faq.length > 0) {
    lines.push("- **FAQ:**");
    for (const item of bundle.app.faq) lines.push(`  - **${item.question}** — ${item.answer}`);
  } else {
    lines.push("- **FAQ:** None");
  }
  lines.push("");

  lines.push("## CTA Configuration", "");
  lines.push(`- **Primary type:** ${bundle.cta.primaryType}`);
  lines.push(`- **CTA label:** ${bundle.app.ctaLabel}`);
  lines.push(`- **CTA href:** ${bundle.app.ctaHref === "#" ? "Unavailable (no real target yet)" : bundle.app.ctaHref}`);
  lines.push(`- **Demo URL:** ${formatUrl(bundle.cta.demoUrl)}`);
  lines.push(`- **Remix URL:** ${formatUrl(bundle.cta.remixUrl)}`);
  lines.push(`- **Build URL:** ${formatUrl(bundle.cta.buildUrl)}`);
  lines.push(
    `- **Labels:** view demo: ${bundle.cta.labels.viewDemo ?? "Unavailable"}; remix: ${bundle.cta.labels.remix ?? "Unavailable"}; build: ${
      bundle.cta.labels.build ?? "Unavailable"
    }; copy prompt: ${bundle.cta.labels.copyPrompt ?? "Unavailable"}`
  );
  lines.push(`- **UTM content:** ${bundle.cta.utmContent ?? "Unavailable"}`);
  lines.push("");

  lines.push("## Social Assets", "");
  if (bundle.social.posts.length === 0) {
    lines.push("No social channels were requested.", "");
  } else {
    if (bundle.social.strategy) {
      const strategy = bundle.social.strategy;
      lines.push(
        "> Social content promotes the **collection/campaign**, not this app in isolation — the newly generated app is at most one example.",
        ""
      );
      lines.push(`- **Scope:** ${strategy.scope}`);
      lines.push(`- **Campaign:** ${strategy.campaignName} (\`${strategy.campaignId}\`)`);
      lines.push(`- **Featured apps:** ${strategy.featuredAppSlugs.join(", ")}`);
      lines.push(`- **Destination URL:** ${formatUrl(strategy.destinationUrl)}`);
      if (strategy.destinationUrl === null) {
        lines.push("  - ⚠ No public collection landing page URL is configured — do not fabricate a link when sharing this content.");
      }
      lines.push(`- **UTM content:** ${strategy.utmContent}`);
      lines.push("");
    }
    for (const post of bundle.social.posts) {
      lines.push(`### ${post.channel}`, "", post.text, "");
    }
  }

  lines.push("## Generation Assumptions and Limitations", "");
  if (bundle.validation.warnings.length === 0) {
    lines.push("_None reported._", "");
  } else {
    for (const warning of bundle.validation.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  lines.push("## Compatibility Status", "");
  lines.push(`- **Sanity appTool compatible:** ${run.compatibility.sanityAppToolCompatible ? "Yes" : "No"}`);
  lines.push(`- **Astro AppData compatible:** ${run.compatibility.astroAppDataCompatible ? "Yes" : "No"}`);
  lines.push(`- **SEO persistence available:** ${run.compatibility.seoPersistenceAvailable ? "Yes" : "No"}`);
  lines.push(`- **CMS write performed:** ${run.compatibility.cmsWritePerformed ? "Yes" : "No"}`);
  lines.push(`- **Site modified:** ${run.compatibility.siteModified ? "Yes" : "No"}`);
  lines.push(`- **AssetBundle validation status:** ${bundle.validation.status}`);
  if (run.compatibility.warnings.length > 0) {
    lines.push("- **Warnings:**");
    for (const warning of run.compatibility.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");

  lines.push("## Human Review Required", "");
  lines.push(`- **Required:** ${run.humanReview.required ? "Yes" : "No"}`);
  lines.push(`- **Approved:** ${run.humanReview.approved ? "Yes" : "No"}`);
  lines.push(`- **Approved by:** ${run.humanReview.approvedBy ?? "Unavailable"}`);
  lines.push(`- **Approved at:** ${run.humanReview.approvedAt ?? "Unavailable"}`);
  lines.push(`- **Note:** ${run.humanReview.note}`);
  lines.push("");

  lines.push("## Generation Metadata", "");
  lines.push(`- **Execution purpose:** ${run.executionPurpose ?? "business_experiment"}`);
  lines.push(`- **Provider:** ${run.generation.provider}${run.generation.isMock ? " (MOCK — not real market copy)" : ""}`);
  lines.push(`- **Model:** ${run.generation.model}`);
  lines.push(`- **Language:** ${run.generation.language}`);
  lines.push(`- **Prompt version:** ${run.generation.promptVersion}`);
  lines.push(`- **Stop reason:** ${run.generation.stopReason ?? "Unavailable"}`);
  lines.push(`- **Request ID:** ${run.generation.requestId ?? "Unavailable"}`);
  lines.push(`- **Input tokens:** ${formatMetric(run.generation.usage.inputTokens)}`);
  lines.push(`- **Output tokens:** ${formatMetric(run.generation.usage.outputTokens)}`);
  lines.push(`- **Generated at:** ${run.generatedAt}`);
  lines.push(
    `- **Source Topic Scoring run:** ${run.provenance.sourceTopicScoringFilename} (sha256: \`${run.provenance.sourceTopicScoringSha256}\`, mock: ${
      run.provenance.sourceTopicScoringIsMock ? "Yes" : "No"
    })`
  );
  lines.push(`- **AssetBundle ID:** \`${bundle.id}\``);
  lines.push("");

  return lines.join("\n");
}
