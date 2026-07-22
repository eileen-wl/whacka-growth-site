import { buildDraftDocumentId } from "../cms/asset-to-cms-request";
import type { FinalCmsWriterRun } from "../types/cms-writer";

function formatUrl(value: string | null): string {
  return value === null ? "Unavailable" : value;
}

function formatList(values: string[], emptyLabel = "None"): string {
  return values.length === 0 ? emptyLabel : values.join(", ");
}

/**
 * Renders a FinalCmsWriterRun (dry-run or draft-write) into readable
 * Markdown. Pure formatting only — never recalculates anything, never
 * renders a secret.
 */
export function renderCmsWriteMarkdown(run: FinalCmsWriterRun): string {
  const { cmsWriteRequest: request } = run;
  const canonicalDocumentId = request.target.documentId;
  const draftDocumentId = buildDraftDocumentId(canonicalDocumentId);
  const lines: string[] = [];

  lines.push("# CMS Write Review", "");

  if (run.provenance.sourceAssetGenerationIsMock) {
    lines.push("> ⚠ The source AssetBundle was produced by the **Mock Provider** — for engineering validation only, not real market copy.", "");
  }
  if (run.provenance.allowMockInputUsed) {
    lines.push("> ⚠ `--allow-mock-input` was used to override the default rejection of mock Asset Generation input for a real draft write.", "");
  }
  lines.push(
    run.mode === "dry_run"
      ? "> This is a **dry-run preview**. No network request was made and no Sanity document was written or modified."
      : "> A Sanity **draft** document was created or replaced. The public site was **not** modified automatically — Sanity draft documents are never rendered on the live site until explicitly published and rebuilt.",
    ""
  );

  lines.push("## Mode", "", run.mode === "dry_run" ? "`dry_run` — preview only, no write performed." : "`draft_write` — a real Sanity draft write was performed.", "");

  lines.push("## Source Asset", "");
  lines.push(`- **Filename:** ${run.provenance.sourceAssetGenerationFilename}`);
  lines.push(`- **SHA-256:** \`${run.provenance.sourceAssetGenerationSha256}\``);
  lines.push(`- **Generated at:** ${run.provenance.sourceAssetGenerationGeneratedAt}`);
  lines.push(`- **Source mock:** ${run.provenance.sourceAssetGenerationIsMock ? "Yes" : "No"}`);
  lines.push(`- **Selected topic ID:** \`${run.provenance.selectedTopicId}\``);
  lines.push(`- **AssetBundle ID:** \`${run.provenance.assetBundleId}\``);
  lines.push(`- **AssetBundle validation status:** ${run.assetBundle.validation.status}`);
  lines.push("");

  lines.push("## Human Review", "");
  lines.push(`- **Confirmed reviewed:** ${run.review.confirmedReviewed ? "Yes" : "No"}`);
  lines.push(`- **Reviewed by:** ${run.review.reviewedBy ?? "Unavailable"}`);
  lines.push(`- **Review note:** ${run.review.reviewNote ?? "None"}`);
  lines.push(
    "- This confirms review of the AssetBundle content for the purpose of creating a Sanity **draft** only — it is not approval to publish.",
    ""
  );

  lines.push("## Target Sanity Document", "");
  lines.push(`- **Canonical document ID:** \`${canonicalDocumentId}\``);
  lines.push(`- **Draft document ID (actual write target):** \`${draftDocumentId}\``);
  lines.push(`- **Document type:** ${request.target.documentType}`);
  lines.push(`- **Operation:** ${request.target.operation}`);
  lines.push(`- **Project ID:** ${run.target.projectId ?? "Not configured (dry-run)"}`);
  lines.push(`- **Dataset:** ${run.target.dataset ?? "Not configured (dry-run)"}`);
  lines.push("");

  lines.push("## Content Summary", "");
  lines.push(`- **Name:** ${request.payload.name}`);
  lines.push(`- **Slug:** \`${request.payload.slug.current}\``);
  lines.push(`- **Tagline:** ${request.payload.tagline}`);
  lines.push(`- **Category:** ${request.payload.category}`);
  lines.push(`- **Status (payload):** ${request.payload.status}`);
  if (request.payload.faq.length > 0) {
    lines.push("- **FAQ:**");
    for (const item of request.payload.faq) lines.push(`  - **${item.question}** — ${item.answer}`);
  } else {
    lines.push("- **FAQ:** None");
  }
  lines.push("");

  lines.push("## SEO Fields", "");
  lines.push("> SEO fields are persisted by the current Sanity `appTool` schema (`seo` object) — this is no longer a mapping gap.", "");
  lines.push(`- **SEO title:** ${request.payload.seo.title}`);
  lines.push(`- **Meta description:** ${request.payload.seo.metaDescription}`);
  lines.push(`- **Primary keyword:** ${request.payload.seo.primaryKeyword}`);
  lines.push(`- **Secondary keywords:** ${formatList(request.payload.seo.secondaryKeywords)}`);
  lines.push("");

  lines.push("## CTA and UTM Mapping", "");
  lines.push(`- **CTA label:** ${request.payload.ctaLabel}`);
  lines.push(`- **CTA href:** ${request.payload.ctaHref === "#" ? "Unavailable (no real target yet)" : request.payload.ctaHref}`);
  lines.push(`- **Demo URL:** ${formatUrl(request.payload.demoUrl)}`);
  lines.push(`- **Remix URL:** ${formatUrl(request.payload.remixUrl)}`);
  lines.push(`- **Build URL:** ${formatUrl(request.payload.buildUrl)}`);
  lines.push(`- **UTM content:** ${request.payload.utmContent ?? "Unavailable"}`);
  lines.push("");

  lines.push("## Payload Compatibility", "");
  lines.push(`- **Sanity appTool compatible:** ${run.compatibility.sanityAppToolCompatible ? "Yes" : "No"}`);
  lines.push(`- **Astro AppData compatible:** ${run.compatibility.astroAppDataCompatible ? "Yes" : "No"}`);
  lines.push(`- **SEO persistence available:** ${run.compatibility.seoPersistenceAvailable ? "Yes" : "No"}`);
  lines.push(`- **FAQ mapping available:** ${run.compatibility.faqMappingAvailable ? "Yes" : "No"}`);
  lines.push(`- **Draft only:** ${run.compatibility.draftOnly ? "Yes" : "No"}`);
  lines.push(`- **Publish performed:** ${run.compatibility.publishPerformed ? "Yes" : "No"}`);
  lines.push(`- **Site modified:** ${run.compatibility.siteModified ? "Yes" : "No"}`);
  if (run.compatibility.warnings.length > 0) {
    lines.push("- **Warnings:**");
    for (const warning of run.compatibility.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");

  lines.push("## Draft Write Status", "");
  if (run.mode === "dry_run" || !run.receipt) {
    lines.push("- **Status:** Not attempted (dry-run).", "");
  } else {
    lines.push(`- **Status:** Succeeded.`);
    lines.push(`- **Revision ID:** ${run.receipt.revisionId ?? "Unavailable"}`);
    lines.push(`- **Created at:** ${run.receipt.createdAt ?? "Unavailable"}`);
    lines.push(`- **Updated at:** ${run.receipt.updatedAt ?? "Unavailable"}`);
    lines.push(`- **Written at:** ${run.receipt.writtenAt}`);
    lines.push(`- **Idempotency key:** \`${run.receipt.idempotencyKey}\``);
    lines.push("");
  }

  lines.push("## Remaining Manual Actions", "");
  lines.push("- Review the draft document in Sanity Studio.");
  lines.push("- Publish it manually in Studio when ready — this pipeline never publishes automatically.");
  lines.push("- The public Astro site remains unchanged until the document is published and the site is rebuilt through its normal deploy process.", "");

  lines.push("## Provenance", "");
  lines.push(`- **CMSWriteRequest ID:** \`${request.id}\``);
  lines.push(`- **Idempotency key:** \`${request.idempotencyKey}\``);
  lines.push(`- **Generated by:** ${request.provenance.generatedBy}`);
  lines.push(`- **Source AssetBundle provider:** ${request.provenance.provider ?? "Unavailable"}${request.provenance.isMock ? " (MOCK)" : ""}`);
  lines.push(`- **Generated at:** ${run.generatedAt}`);
  lines.push("");

  lines.push("## Security Notes", "");
  lines.push("- No API token, authorization header, or raw Sanity client configuration is included anywhere in this document.");
  lines.push("- Only non-secret identifiers (project ID, dataset, document IDs, revision ID) are recorded.", "");

  return lines.join("\n");
}
