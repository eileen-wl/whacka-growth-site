import type { AssetBundle } from "../contracts/asset-bundle";
import type { CMSWriteRequest } from "../contracts/cms-write-request";
import type { CampaignInfo, DateRange } from "./growth-summary";

/**
 * CMS Writer — step 4 of the fixed Growth Loop. Deliberately NOT an LLM
 * Agent: it deterministically maps one validated AssetBundle onto a Sanity
 * `appTool` draft document. `dry_run` never touches the network; `draft_write`
 * performs exactly one `createOrReplace` against a `drafts.` prefixed
 * document id and never calls `.publish()`. See growth/cms/cms-writer.ts.
 */

export type CmsWriterMode = "dry_run" | "draft_write";

export interface CmsWriterProvenance {
  sourceAssetGenerationFilename: string;
  sourceAssetGenerationSha256: string;
  sourceAssetGenerationGeneratedAt: string;
  sourceAssetGenerationIsMock: boolean;
  sourceTopicScoringIsMock: boolean;
  sourceTopicsHumanReviewed: boolean;
  selectedTopicId: string;
  selectedScoredTopicId: string;
  assetBundleId: string;
  allowMockInputUsed: boolean;
  /**
   * The source Asset Generation run's `executionPurpose` ("business_experiment"
   * or "integration_test"), defaulting to "business_experiment" when the
   * source run predates this field. Optional so existing fixtures/older
   * receipts remain structurally valid — CMS Writer always sets it
   * explicitly on every new run it produces.
   */
  sourceExecutionPurpose?: string;
  /** True only when --allow-integration-test-input was used to permit a real draft write from an integration-test source. Always false for --dry-run. */
  allowIntegrationTestInputUsed?: boolean;
}

export interface CmsWriterReview {
  /** True only for an actual --write-draft run — a dry-run preview is never "confirmed reviewed" even if review flags were supplied for preview purposes. */
  confirmedReviewed: boolean;
  reviewedBy: string | null;
  reviewNote: string | null;
}

/** Never includes a token — only the non-secret identifiers needed to know where a draft would land (or landed). */
export interface CmsWriterTarget {
  projectId: string | null;
  dataset: string | null;
  apiVersion: string | null;
}

export interface CmsWriterCompatibility {
  sanityAppToolCompatible: boolean;
  astroAppDataCompatible: boolean;
  seoPersistenceAvailable: boolean;
  faqMappingAvailable: boolean;
  draftOnly: true;
  publishPerformed: false;
  siteModified: false;
  warnings: string[];
}

/** A sanitized record of a real Sanity write — never a token, header, or raw client config. */
export interface CmsWriteReceipt {
  draftDocumentId: string;
  canonicalDocumentId: string;
  projectId: string;
  dataset: string;
  operation: string;
  revisionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  writtenAt: string;
  assetBundleId: string;
  cmsWriteRequestId: string;
  idempotencyKey: string;
}

/** The on-disk shape written to growth/cms-output/receipts/cms-write-receipt-{start}_to_{end}-{topic-id}.json after a successful real draft write. Also the in-memory result shape of a --dry-run run (with mode: "dry_run", writeStatus: "not_attempted", receipt: null). */
export interface FinalCmsWriterRun {
  schemaVersion: "1.0.0";
  runType: "cms_writer";
  generatedAt: string;
  mode: CmsWriterMode;
  period: DateRange;
  campaign: CampaignInfo;
  provenance: CmsWriterProvenance;
  assetBundle: AssetBundle;
  cmsWriteRequest: CMSWriteRequest;
  target: CmsWriterTarget;
  review: CmsWriterReview;
  compatibility: CmsWriterCompatibility;
  writeStatus: "not_attempted" | "succeeded";
  receipt: CmsWriteReceipt | null;
}

/** The on-disk shape written to growth/cms-output/requests/cms-write-request-{start}_to_{end}-{topic-id}.json in --dry-run mode. Never includes secrets — makes no network request to produce. */
export interface CmsWriteDryRunPreview {
  source: "cms_writer_dry_run";
  createdAt: string;
  period: DateRange;
  campaign: CampaignInfo;
  sourceAssetGenerationFilename: string;
  sourceAssetGenerationSha256: string;
  selectedTopicId: string;
  assetBundleId: string;
  cmsWriteRequest: CMSWriteRequest;
  target: CmsWriterTarget;
  intendedOperation: string;
  draftDocumentId: string;
  canonicalDocumentId: string;
  review: CmsWriterReview;
  overrides: { allowMockInput: boolean };
  compatibility: CmsWriterCompatibility;
  confirmation: string;
  /** "business_experiment" or "integration_test" — see CmsWriterProvenance.sourceExecutionPurpose. Always present on the dry-run preview, defaulting to "business_experiment". */
  sourceExecutionPurpose: string;
}
