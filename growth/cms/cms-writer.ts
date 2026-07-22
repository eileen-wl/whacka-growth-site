import { validateAssetBundle } from "../contracts/asset-bundle";
import { buildCmsWriteRequestFromAssetBundle, buildDraftDocumentId } from "./asset-to-cms-request";
import { writeSanityDraft } from "./sanity-draft-writer";
import type { AssetBundle } from "../contracts/asset-bundle";
import type { SanityWriteClient } from "./sanity-draft-writer";
import type { CmsWriteDryRunPreview, CmsWriterCompatibility, CmsWriterMode, FinalCmsWriterRun } from "../types/cms-writer";
import type { FinalAssetGenerationRun } from "../types/asset-generation";

/**
 * CMS Writer orchestration — step 4 of the fixed Growth Loop. Deterministic
 * only: no LLM call anywhere in this file. Consumes one already-loaded,
 * already-structurally-validated FinalAssetGenerationRun (see
 * growth/scripts/write-cms-draft.ts for input discovery/validation) and
 * produces a FinalCmsWriterRun for either mode. The Sanity network call
 * (mode: "draft_write" only) is delegated to growth/cms/sanity-draft-writer.ts
 * via an injected client — this module never constructs one itself.
 */

export class CmsWriterValidationError extends Error {}

/** CMS-Writer-specific cross-checks beyond the AssetBundle contract's own schema (already enforced by validateAssetBundle). */
export function validateAssetBundleForCmsWrite(bundle: AssetBundle): AssetBundle {
  if (bundle.app.status !== "draft") {
    throw new CmsWriterValidationError(`AssetBundle app.status is "${bundle.app.status}"; CMS Writer only accepts a "draft" AssetBundle.`);
  }
  return bundle;
}

export function buildCompatibility(warnings: string[] = []): CmsWriterCompatibility {
  return {
    sanityAppToolCompatible: true,
    astroAppDataCompatible: true,
    seoPersistenceAvailable: true,
    faqMappingAvailable: true,
    draftOnly: true,
    publishPerformed: false,
    siteModified: false,
    warnings,
  };
}

export interface RunCmsWriterParams {
  /** Already loaded and structurally validated by the caller (script) — see growth/scripts/write-cms-draft.ts. */
  run: FinalAssetGenerationRun;
  sourceFilename: string;
  sourceSha256: string;
  mode: CmsWriterMode;
  dataset?: string | null;
  review: { reviewedBy: string | null; reviewNote: string | null };
  allowMockInputUsed: boolean;
  /** True only when --allow-integration-test-input was supplied — recorded in the receipt/preview, never used to bypass any other gate here (the caller script enforces the actual rejection). */
  allowIntegrationTestInputUsed?: boolean;
  /** Required (and only used) when mode is "draft_write" — never constructed by this module. */
  sanityClient?: SanityWriteClient;
  projectId?: string | null;
  apiVersion?: string | null;
  generatedAt?: string;
}

export async function runCmsWriter(params: RunCmsWriterParams): Promise<FinalCmsWriterRun> {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const bundle = validateAssetBundleForCmsWrite(validateAssetBundle(params.run.assetBundle));

  const cmsWriteRequest = buildCmsWriteRequestFromAssetBundle(bundle, {
    mode: params.mode,
    dataset: params.dataset ?? null,
    // Only a real, gated draft_write counts as "human reviewed" — a dry-run preview may be built from an unreviewed AssetBundle.
    humanReviewed: params.mode === "draft_write",
  });

  const draftDocumentId = buildDraftDocumentId(cmsWriteRequest.target.documentId);

  let receipt: FinalCmsWriterRun["receipt"] = null;
  let writeStatus: FinalCmsWriterRun["writeStatus"] = "not_attempted";

  if (params.mode === "draft_write") {
    if (!params.sanityClient) {
      throw new CmsWriterValidationError("Internal error: mode \"draft_write\" requires a Sanity client to be supplied.");
    }
    const result = await writeSanityDraft({ client: params.sanityClient, request: cmsWriteRequest, draftDocumentId });
    receipt = {
      draftDocumentId: result.draftDocumentId,
      canonicalDocumentId: result.canonicalDocumentId,
      projectId: params.projectId ?? "unknown",
      dataset: params.dataset ?? "unknown",
      operation: cmsWriteRequest.target.operation,
      revisionId: result.revisionId,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      writtenAt: generatedAt,
      assetBundleId: bundle.id,
      cmsWriteRequestId: cmsWriteRequest.id,
      idempotencyKey: cmsWriteRequest.idempotencyKey,
    };
    writeStatus = "succeeded";
  }

  return {
    schemaVersion: "1.0.0",
    runType: "cms_writer",
    generatedAt,
    mode: params.mode,
    period: params.run.period,
    campaign: params.run.campaign,
    provenance: {
      sourceAssetGenerationFilename: params.sourceFilename,
      sourceAssetGenerationSha256: params.sourceSha256,
      sourceAssetGenerationGeneratedAt: params.run.generatedAt,
      sourceAssetGenerationIsMock: params.run.generation.isMock,
      sourceTopicScoringIsMock: params.run.provenance.sourceTopicScoringIsMock,
      sourceTopicsHumanReviewed: params.run.provenance.sourceTopicsHumanReviewed,
      selectedTopicId: params.run.provenance.selectedTopicId,
      selectedScoredTopicId: params.run.provenance.selectedScoredTopicId,
      assetBundleId: bundle.id,
      allowMockInputUsed: params.allowMockInputUsed,
      sourceExecutionPurpose: params.run.executionPurpose ?? "business_experiment",
      allowIntegrationTestInputUsed: params.allowIntegrationTestInputUsed ?? false,
    },
    assetBundle: bundle,
    cmsWriteRequest,
    target: { projectId: params.projectId ?? null, dataset: params.dataset ?? null, apiVersion: params.apiVersion ?? null },
    review: {
      confirmedReviewed: params.mode === "draft_write",
      reviewedBy: params.review.reviewedBy,
      reviewNote: params.review.reviewNote,
    },
    compatibility: buildCompatibility(cmsWriteRequest.validation.warnings),
    writeStatus,
    receipt,
  };
}

export interface BuildDryRunPreviewOptions {
  allowMockInputUsed: boolean;
}

/** Derives the narrower, disk-facing dry-run preview shape from a FinalCmsWriterRun already built in mode "dry_run". Pure — never writes anything, never touches the network. */
export function buildCmsWriteDryRunPreview(run: FinalCmsWriterRun, options: BuildDryRunPreviewOptions): CmsWriteDryRunPreview {
  return {
    source: "cms_writer_dry_run",
    createdAt: run.generatedAt,
    period: run.period,
    campaign: run.campaign,
    sourceAssetGenerationFilename: run.provenance.sourceAssetGenerationFilename,
    sourceAssetGenerationSha256: run.provenance.sourceAssetGenerationSha256,
    selectedTopicId: run.provenance.selectedTopicId,
    assetBundleId: run.provenance.assetBundleId,
    cmsWriteRequest: run.cmsWriteRequest,
    target: run.target,
    intendedOperation: run.cmsWriteRequest.target.operation,
    draftDocumentId: buildDraftDocumentId(run.cmsWriteRequest.target.documentId),
    canonicalDocumentId: run.cmsWriteRequest.target.documentId,
    review: run.review,
    overrides: { allowMockInput: options.allowMockInputUsed },
    compatibility: run.compatibility,
    confirmation: "No CMS write or publish occurred. This is a local preview only — no network request was made.",
    sourceExecutionPurpose: run.provenance.sourceExecutionPurpose ?? "business_experiment",
  };
}
