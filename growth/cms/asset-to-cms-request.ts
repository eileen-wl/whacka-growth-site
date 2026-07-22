import { buildCmsWriteRequest } from "../contracts/cms-write-request";
import type { AssetBundle } from "../contracts/asset-bundle";
import type { CMSWriteRequest } from "../contracts/cms-write-request";

/**
 * Thin, CMS-Writer-specific entry point onto growth/contracts/cms-write-request.ts's
 * `buildCmsWriteRequest` — the actual AssetBundle -> CMSWriteRequest field
 * mapping lives there and is reused as-is, never duplicated here.
 */

export interface BuildCmsWriteRequestFromAssetBundleOptions {
  mode: "dry_run" | "draft_write";
  dataset?: string | null;
  /** True only once the human-review gate has actually been satisfied (see growth/cms/cms-writer.ts). */
  humanReviewed: boolean;
}

export function buildCmsWriteRequestFromAssetBundle(assetBundle: AssetBundle, options: BuildCmsWriteRequestFromAssetBundleOptions): CMSWriteRequest {
  return buildCmsWriteRequest(assetBundle, {
    generatedBy: "cms-writer",
    mode: options.mode,
    dataset: options.dataset ?? null,
    humanReviewed: options.humanReviewed,
    operation: "create_or_replace",
  });
}

/**
 * Sanity's own convention: a document is a *draft* purely because its `_id`
 * is prefixed `drafts.` — there is no separate boolean flag. `CMSWriteRequest.target.documentId`
 * (and `payload._id`) are always the canonical, published-style id (contractually
 * pinned by growth/contracts/cms-write-request.ts's own schema refinements) — the
 * actual draft id used for the real Sanity write is derived here, one level up,
 * so the shared contract never needs to know about drafts at all.
 */
export function buildDraftDocumentId(canonicalDocumentId: string): string {
  return `drafts.${canonicalDocumentId}`;
}
