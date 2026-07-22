import "dotenv/config";
import { createClient } from "@sanity/client";
import { pathToFileURL } from "node:url";
import {
  APP_TOOLS_QUERY,
  buildClientConfig,
  buildPreviewDiagnostics,
  dedupeDraftsAndPublished,
  resolveSanityConfig,
  SanityPreviewConfigError,
} from "../../src/lib/sanity-shared";
import type { RawAppToolDoc, SanityEnvLike, SanityPreviewDiagnostics } from "../../src/lib/sanity-shared";

/**
 * Read-only diagnostic CLI for the real Sanity draft-preview connection —
 * see "Sanity draft preview mode" in growth/README.md. Reuses the exact
 * same framework-neutral config/query/dedup logic src/lib/sanity.ts uses
 * (src/lib/sanity-shared.ts) so this diagnoses the *actual* preview path,
 * not a re-implementation of it. Never mutates anything: exactly one
 * client.fetch() call is ever made, no create/patch/delete method exists
 * anywhere in this file. Never prints the token — only the safe boolean/
 * enum fields from buildPreviewDiagnostics, plus non-secret slugs and
 * counts.
 */

export class CheckSanityPreviewArgsError extends Error {}

export interface CollectArgs {
  mode: "preview" | "published";
}

export function parseArgs(argv: string[]): CollectArgs {
  let preview = false;
  let published = false;

  for (const arg of argv) {
    if (arg === "--preview") {
      preview = true;
    } else if (arg === "--published") {
      published = true;
    } else {
      throw new CheckSanityPreviewArgsError(`Unrecognized argument "${arg}".`);
    }
  }

  if (preview === published) {
    throw new CheckSanityPreviewArgsError("growth:check-sanity-preview requires exactly one of --preview or --published.");
  }

  return { mode: preview ? "preview" : "published" };
}

/**
 * Reads real process.env — this CLI never touches `import.meta.env` (it
 * doesn't exist under plain tsx/Node execution anyway, which is exactly
 * why the shared config/query logic lives in a framework-neutral module).
 * `--preview`/`--published` always overrides whatever `SANITY_PREVIEW_DRAFTS`
 * is actually set to, so this tool can force either mode for a clean,
 * direct comparison regardless of the current shell/.env state.
 */
export function readEnv(args: CollectArgs, source: NodeJS.ProcessEnv = process.env): SanityEnvLike {
  return {
    PUBLIC_SANITY_PROJECT_ID: source.PUBLIC_SANITY_PROJECT_ID,
    PUBLIC_SANITY_DATASET: source.PUBLIC_SANITY_DATASET,
    PUBLIC_SANITY_API_VERSION: source.PUBLIC_SANITY_API_VERSION,
    SANITY_PREVIEW_DRAFTS: args.mode === "preview" ? "true" : "false",
    SANITY_API_TOKEN: source.SANITY_API_TOKEN,
  };
}

/** Minimal client surface this script needs — lets tests inject a fake instead of ever constructing a real client. Deliberately has no write/create/patch/delete method: this tool is structurally incapable of mutating Sanity. */
export interface ReadOnlySanityClient {
  fetch<T>(query: string): Promise<T>;
}

export interface CheckSanityPreviewResult {
  diagnostics: SanityPreviewDiagnostics;
  rawCount: number;
  slugs: string[];
  slotSmithFound: boolean;
  dedupedCount: number;
}

/**
 * The actual read-only check. `createClientFn` is injectable for offline
 * tests; the live CLI's `main()` supplies the real `@sanity/client`. Runs
 * `resolveSanityConfig` (which throws `SanityPreviewConfigError` if
 * `--preview` is requested without `SANITY_API_TOKEN` configured) before
 * ever constructing a client, so a misconfigured preview attempt fails
 * before any network request.
 */
export async function run(
  argv: string[],
  createClientFn: (config: ReturnType<typeof buildClientConfig>) => ReadOnlySanityClient = (config) =>
    createClient(config) as unknown as ReadOnlySanityClient
): Promise<CheckSanityPreviewResult> {
  const args = parseArgs(argv);
  const env = readEnv(args);
  const config = resolveSanityConfig(env);
  const diagnostics = buildPreviewDiagnostics(config);

  if (!config.projectId || !config.dataset) {
    throw new CheckSanityPreviewArgsError(
      "PUBLIC_SANITY_PROJECT_ID and PUBLIC_SANITY_DATASET must both be set in .env to run this check."
    );
  }

  const client = createClientFn(buildClientConfig(config));
  const raw = await client.fetch<RawAppToolDoc[]>(APP_TOOLS_QUERY);
  const deduped = dedupeDraftsAndPublished(raw);

  return {
    diagnostics,
    rawCount: raw.length,
    slugs: raw.map((doc) => doc.slug),
    slotSmithFound: deduped.some((app) => app.slug === "slotsmith"),
    dedupedCount: deduped.length,
  };
}

async function main(): Promise<void> {
  try {
    const result = await run(process.argv.slice(2));
    console.log(`[check-sanity-preview] Preview mode: ${result.diagnostics.previewMode}`);
    console.log(`[check-sanity-preview] Project configured: ${result.diagnostics.projectConfigured}`);
    console.log(`[check-sanity-preview] Dataset configured: ${result.diagnostics.datasetConfigured}`);
    console.log(`[check-sanity-preview] Token configured: ${result.diagnostics.tokenConfigured}`);
    console.log(`[check-sanity-preview] Perspective: ${result.diagnostics.perspective}`);
    console.log(`[check-sanity-preview] useCdn: ${result.diagnostics.useCdn}`);
    console.log(`[check-sanity-preview] Raw returned document count: ${result.rawCount}`);
    console.log(`[check-sanity-preview] Returned slugs: ${result.slugs.join(", ") || "(none)"}`);
    console.log(`[check-sanity-preview] SlotSmith found: ${result.slotSmithFound ? "yes" : "no"}`);
    console.log(`[check-sanity-preview] Deduplicated app count: ${result.dedupedCount}`);
    console.log("[check-sanity-preview] Read-only — no content was created, modified, or published.");
  } catch (err) {
    if (err instanceof CheckSanityPreviewArgsError || err instanceof SanityPreviewConfigError) {
      console.error(`[check-sanity-preview] ${err.message}`);
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[check-sanity-preview] Unexpected error: ${reason}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
