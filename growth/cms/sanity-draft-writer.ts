import { createClient } from "@sanity/client";
import type { CMSWriteRequest } from "../contracts/cms-write-request";

/**
 * The real Sanity write path — the only file in growth/ that performs an
 * actual (non-dry-run) network call. Always writes a `drafts.`-prefixed
 * document id via `createOrReplace`; never calls `.publish()`, never writes
 * the canonical (non-draft) document id.
 */

export class SanityConfigError extends Error {}

export type SanityWriteErrorReason = "authentication_error" | "permission_denied" | "invalid_dataset" | "network_error" | "api_error";

export class SanityWriteError extends Error {
  constructor(
    message: string,
    readonly reason: SanityWriteErrorReason
  ) {
    super(message);
  }
}

export interface SanityClientConfig {
  projectId: string;
  dataset: string;
  apiVersion: string;
  token: string;
}

/** Minimal surface this module needs from `@sanity/client` — lets tests inject a fake client instead of ever constructing a real one. */
export interface SanityWriteClient {
  createOrReplace(doc: Record<string, unknown>): Promise<{ _id: string; _rev?: string; _createdAt?: string; _updatedAt?: string }>;
}

/** Lazy by construction: callers must only invoke this inside a --write-draft code path, never for --dry-run. `useCdn: false` matches scripts/seed.ts's existing server-side write-client convention (never the browser-facing `useCdn: true` client in src/lib/sanity.ts). */
export function createSanityWriteClient(config: SanityClientConfig): SanityWriteClient {
  return createClient({
    projectId: config.projectId,
    dataset: config.dataset,
    apiVersion: config.apiVersion,
    token: config.token,
    useCdn: false,
  }) as unknown as SanityWriteClient;
}

export interface WriteDraftParams {
  client: SanityWriteClient;
  request: CMSWriteRequest;
  draftDocumentId: string;
}

export interface SanityWriteResult {
  draftDocumentId: string;
  canonicalDocumentId: string;
  revisionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Writes ONLY a Sanity draft: sends `request.payload` with `_id` overridden
 * to the `drafts.`-prefixed id. Never sends the canonical (published-style)
 * `_id`, never calls publish, never touches any other document.
 */
export async function writeSanityDraft(params: WriteDraftParams): Promise<SanityWriteResult> {
  if (!params.draftDocumentId.startsWith("drafts.")) {
    throw new SanityConfigError(`Refusing to write a document id that is not draft-prefixed: "${params.draftDocumentId}".`);
  }

  const draftDocument = { ...params.request.payload, _id: params.draftDocumentId };

  let result: { _id: string; _rev?: string; _createdAt?: string; _updatedAt?: string };
  try {
    result = await params.client.createOrReplace(draftDocument);
  } catch (err) {
    throw mapSanityError(err);
  }

  return {
    draftDocumentId: result._id,
    canonicalDocumentId: params.request.target.documentId,
    revisionId: result._rev ?? null,
    createdAt: result._createdAt ?? null,
    updatedAt: result._updatedAt ?? null,
  };
}

/** Strips anything resembling an auth header/token from an upstream error message before it can reach a log line or an output file. */
function sanitizeMessage(message: string): string {
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/sk[A-Za-z0-9._-]{10,}/g, "[redacted]");
}

function mapSanityError(err: unknown): SanityWriteError {
  const statusCode = extractStatusCode(err);
  const message = sanitizeMessage(err instanceof Error ? err.message : String(err));

  if (statusCode === 401) {
    return new SanityWriteError("Sanity rejected the request: authentication failed. Check that SANITY_API_TOKEN is set and valid.", "authentication_error");
  }
  if (statusCode === 403) {
    return new SanityWriteError("Sanity denied permission for this write. Check the token's role and dataset access.", "permission_denied");
  }
  if (statusCode === 404) {
    return new SanityWriteError("Sanity project or dataset not found. Check PUBLIC_SANITY_PROJECT_ID and PUBLIC_SANITY_DATASET.", "invalid_dataset");
  }
  if (statusCode === undefined) {
    return new SanityWriteError(`Could not reach Sanity: ${message}`, "network_error");
  }
  return new SanityWriteError(`Sanity API request failed (status ${statusCode}): ${message}`, "api_error");
}

function extractStatusCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = err as { statusCode?: unknown; response?: { statusCode?: unknown } };
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  if (typeof candidate.response?.statusCode === "number") return candidate.response.statusCode;
  return undefined;
}
