import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileAtomic } from "../lib/collector-fs";
import {
  PeriodMismatchError,
  multipleMatchesNotice as multipleMatchesNoticeShared,
  selectLatestSnapshot as selectLatestSnapshotShared,
  assertPeriodMatches as assertPeriodMatchesShared,
} from "../lib/snapshot-discovery";
import { validateAssetBundle } from "../contracts/asset-bundle";
import { buildCmsWriteDryRunPreview, CmsWriterValidationError, runCmsWriter } from "../cms/cms-writer";
import { createSanityWriteClient, SanityConfigError, SanityWriteError } from "../cms/sanity-draft-writer";
import { renderCmsWriteMarkdown } from "../renderers/cms-write-markdown";
import type { AssetBundle } from "../contracts/asset-bundle";
import type { DateRange } from "../types/growth-summary";
import type { FinalAssetGenerationRun } from "../types/asset-generation";
import type { CmsWriteDryRunPreview, FinalCmsWriterRun } from "../types/cms-writer";

const GROWTH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS_DIR = join(GROWTH_DIR, "assets");
const REQUESTS_DIR = join(GROWTH_DIR, "cms-output", "requests");
const RECEIPTS_DIR = join(GROWTH_DIR, "cms-output", "receipts");

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_SANITY_API_VERSION = "2024-01-01";

export class CmsWriteDateRangeError extends Error {}
export class CmsWriteConfigError extends Error {}
export class CmsWriteInputError extends Error {}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export interface WriteCmsDraftArgs {
  start?: string;
  end?: string;
  input?: string;
  topicId?: string;
  dryRun: boolean;
  writeDraft: boolean;
  confirmReviewed: boolean;
  reviewedBy?: string;
  reviewNote?: string;
  allowMockInput: boolean;
  overwrite: boolean;
}

export function parseArgs(argv: string[]): WriteCmsDraftArgs {
  const args: WriteCmsDraftArgs = {
    dryRun: false,
    writeDraft: false,
    confirmReviewed: false,
    allowMockInput: false,
    overwrite: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--start") {
      args.start = argv[++i];
    } else if (arg === "--end") {
      args.end = argv[++i];
    } else if (arg === "--input") {
      args.input = argv[++i];
    } else if (arg === "--topic-id") {
      args.topicId = argv[++i];
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--write-draft") {
      args.writeDraft = true;
    } else if (arg === "--confirm-reviewed") {
      args.confirmReviewed = true;
    } else if (arg === "--reviewed-by") {
      args.reviewedBy = argv[++i];
    } else if (arg === "--review-note") {
      args.reviewNote = argv[++i];
    } else if (arg === "--allow-mock-input") {
      args.allowMockInput = true;
    } else if (arg === "--overwrite") {
      args.overwrite = true;
    } else {
      throw new Error(`Unrecognized argument "${arg}".`);
    }
  }

  if (args.dryRun === args.writeDraft) {
    throw new Error("growth:cms-write requires exactly one of --dry-run or --write-draft.");
  }
  if (args.start && !args.end) {
    throw new Error("--start was given without --end. Both are required together.");
  }
  if (args.end && !args.start) {
    throw new Error("--end was given without --start. Both are required together.");
  }
  if (!args.start || !args.end) {
    throw new Error("growth:cms-write requires --start and --end (ISO YYYY-MM-DD), even when --input is given.");
  }
  if (!args.input && !args.topicId) {
    throw new Error("growth:cms-write requires --topic-id for automatic discovery — pass --input to bypass discovery with an explicit file instead.");
  }
  if (args.writeDraft && !args.confirmReviewed) {
    throw new Error("--write-draft requires --confirm-reviewed — an explicit human-review confirmation. This is not implied by any other flag.");
  }
  if (args.writeDraft && (!args.reviewedBy || args.reviewedBy.trim().length === 0)) {
    throw new Error("--write-draft requires --reviewed-by <name> — a non-empty reviewer name.");
  }

  return args;
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function assertValidDateRange(start: string, end: string): void {
  if (!isValidIsoDate(start)) {
    throw new CmsWriteDateRangeError(`Invalid --start date "${start}". Use ISO format YYYY-MM-DD.`);
  }
  if (!isValidIsoDate(end)) {
    throw new CmsWriteDateRangeError(`Invalid --end date "${end}". Use ISO format YYYY-MM-DD.`);
  }
  if (start > end) {
    throw new CmsWriteDateRangeError(`--start (${start}) must not be after --end (${end}).`);
  }
}

// ---------------------------------------------------------------------------
// Sanity environment (reuses the exact variable names scripts/seed.ts and
// src/lib/sanity.ts already use — no new env vars introduced).
// ---------------------------------------------------------------------------

export interface SanityEnvConfig {
  projectId: string | undefined;
  dataset: string | undefined;
  apiVersion: string;
  token: string | undefined;
}

export function readSanityEnv(source: NodeJS.ProcessEnv = process.env): SanityEnvConfig {
  return {
    projectId: source.PUBLIC_SANITY_PROJECT_ID,
    dataset: source.PUBLIC_SANITY_DATASET,
    apiVersion: source.PUBLIC_SANITY_API_VERSION && source.PUBLIC_SANITY_API_VERSION.trim().length > 0 ? source.PUBLIC_SANITY_API_VERSION : DEFAULT_SANITY_API_VERSION,
    token: source.SANITY_API_TOKEN,
  };
}

export interface ResolvedSanityConfig {
  projectId: string;
  dataset: string;
  apiVersion: string;
  token: string;
}

/** Never called for --dry-run, so dry-run never requires any Sanity configuration. */
export function assertSanityConfigured(env: SanityEnvConfig): ResolvedSanityConfig {
  const missing: string[] = [];
  if (!env.projectId) missing.push("PUBLIC_SANITY_PROJECT_ID");
  if (!env.dataset) missing.push("PUBLIC_SANITY_DATASET");
  if (!env.token) missing.push("SANITY_API_TOKEN");
  if (missing.length > 0) {
    throw new CmsWriteConfigError(`--write-draft requires Sanity configuration. Missing: ${missing.join(", ")}. Set these in .env first (see .env.example).`);
  }
  return { projectId: env.projectId as string, dataset: env.dataset as string, apiVersion: env.apiVersion, token: env.token as string };
}

// ---------------------------------------------------------------------------
// Input discovery: growth/assets/asset-generation-{start}_to_{end}-{topic-id}*.json
// only — never Topic Scoring/Signal Mining/Growth Summary/analytics/Growth
// Report/Experiment Decision files, never an arbitrary content file.
// ---------------------------------------------------------------------------

export interface FileSystemDeps {
  listDir: (dir: string) => string[];
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
}

const defaultDeps: FileSystemDeps = {
  listDir: (dir) => readdirSync(dir),
  readFile: (path) => readFileSync(path, "utf-8"),
  exists: (path) => existsSync(path),
};

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function basenameOnly(path: string): string {
  return path.replace(/^.*[\\/]/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches `asset-generation-{start}_to_{end}-{topicId}.json` and its timestamped collision variants — the topic-id-suffixed convention introduced by growth/scripts/generate-assets.ts, not supported by growth/lib/snapshot-discovery.ts's own prefix-only matcher. */
function findMatchingAssetGenerationFiles(dir: string, period: DateRange, topicId: string, listDir: FileSystemDeps["listDir"]): string[] {
  const base = `asset-generation-${period.start}_to_${period.end}-${topicId}`;
  const pattern = new RegExp(`^${escapeRegExp(base)}(\\.[^.]+)?\\.json$`);
  return listDir(dir).filter((name) => pattern.test(name));
}

function isValidFinalAssetGenerationRun(value: unknown): value is FinalAssetGenerationRun {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== "1.0.0" || v.runType !== "asset_generation") return false;
  if (typeof v.generatedAt !== "string") return false;

  const period = v.period as Record<string, unknown> | undefined;
  if (!period || typeof period.start !== "string" || typeof period.end !== "string") return false;

  const campaign = v.campaign as Record<string, unknown> | undefined;
  if (!campaign || typeof campaign.id !== "string" || typeof campaign.name !== "string") return false;

  const provenance = v.provenance as Record<string, unknown> | undefined;
  if (!provenance || typeof provenance.selectedTopicId !== "string" || typeof provenance.selectedScoredTopicId !== "string") return false;

  const generation = v.generation as Record<string, unknown> | undefined;
  if (!generation || typeof generation.isMock !== "boolean") return false;

  if (typeof v.assetBundle !== "object" || v.assetBundle === null) return false;

  const compatibility = v.compatibility as Record<string, unknown> | undefined;
  if (!compatibility || compatibility.cmsWritePerformed !== false || compatibility.siteModified !== false) return false;

  const dataQuality = v.dataQuality as Record<string, unknown> | undefined;
  const status = dataQuality?.overallStatus;
  if (status !== "complete" && status !== "partial" && status !== "invalid") return false;

  return true;
}

function parseAndValidateAssetGenerationRun(content: string, filename: string): FinalAssetGenerationRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new CmsWriteInputError(`Failed to parse "${filename}" as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isValidFinalAssetGenerationRun(parsed)) {
    throw new CmsWriteInputError(`"${filename}" does not match the expected FinalAssetGenerationRun schema (runType must be "asset_generation").`);
  }

  let bundle: AssetBundle;
  try {
    bundle = validateAssetBundle(parsed.assetBundle);
  } catch (err) {
    throw new CmsWriteInputError(`"${filename}" contains an invalid AssetBundle: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (bundle.topicId !== parsed.provenance.selectedTopicId) {
    throw new CmsWriteInputError(`"${filename}": AssetBundle.topicId does not match provenance.selectedTopicId — refusing an inconsistent run.`);
  }
  if (bundle.scoredTopicId !== parsed.provenance.selectedScoredTopicId) {
    throw new CmsWriteInputError(`"${filename}": AssetBundle.scoredTopicId does not match provenance.selectedScoredTopicId — refusing an inconsistent run.`);
  }
  if (bundle.app.status !== "draft") {
    throw new CmsWriteInputError(`"${filename}": AssetBundle.app.status is "${bundle.app.status}"; CMS Writer only accepts a "draft" AssetBundle.`);
  }

  return parsed;
}

function assertPeriodMatches(runPeriod: DateRange, requestedPeriod: DateRange): void {
  try {
    assertPeriodMatchesShared("Asset Generation run", runPeriod, requestedPeriod);
  } catch (err) {
    if (err instanceof PeriodMismatchError) throw new CmsWriteInputError(err.message);
    throw err;
  }
}

export interface LoadedAssetGenerationRun {
  filename: string;
  content: string;
  run: FinalAssetGenerationRun;
  notice?: string;
}

/** Loads the Asset Generation run for `period` + selected topic: either exactly `args.input`, or the latest-generatedAt discovered `asset-generation-*-{topicId}*.json` match. Never selects the sibling `.md` file, never reads any other growth/ output. */
export function loadAssetGenerationRun(args: WriteCmsDraftArgs, period: DateRange, deps: FileSystemDeps = defaultDeps): LoadedAssetGenerationRun {
  if (args.input) {
    const content = deps.readFile(args.input);
    const run = parseAndValidateAssetGenerationRun(content, basenameOnly(args.input));
    assertPeriodMatches(run.period, period);
    if (args.topicId && run.provenance.selectedTopicId !== args.topicId) {
      throw new CmsWriteInputError(
        `--topic-id "${args.topicId}" does not match the loaded Asset Generation run's selected topic ("${run.provenance.selectedTopicId}").`
      );
    }
    return { filename: basenameOnly(args.input), content, run };
  }

  const topicId = args.topicId as string;
  const matches = findMatchingAssetGenerationFiles(ASSETS_DIR, period, topicId, deps.listDir);
  if (matches.length === 0) {
    throw new CmsWriteInputError(
      `No Asset Generation run found for ${period.start} to ${period.end}, topic "${topicId}". Expected a file matching ` +
        `growth/assets/asset-generation-${period.start}_to_${period.end}-${topicId}*.json — run growth:generate-assets for this topic first.`
    );
  }

  let selected: { filename: string; snapshot: { generatedAt: string } } | undefined;
  try {
    selected = selectLatestSnapshotShared<{ generatedAt: string }>(ASSETS_DIR, matches, deps.readFile, (s) => s.generatedAt);
  } catch (err) {
    throw new CmsWriteInputError(
      `Failed to parse a matching Asset Generation run for ${period.start} to ${period.end}, topic "${topicId}" as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!selected) {
    throw new CmsWriteInputError(`Failed to read any matching Asset Generation run for ${period.start} to ${period.end}, topic "${topicId}".`);
  }

  const content = deps.readFile(join(ASSETS_DIR, selected.filename));
  const run = parseAndValidateAssetGenerationRun(content, selected.filename);
  assertPeriodMatches(run.period, period);

  const notice = matches.length > 1 ? multipleMatchesNoticeShared("Asset Generation run", selected.filename) : undefined;

  return { filename: selected.filename, content, run, notice };
}

// ---------------------------------------------------------------------------
// Mock-input gate — draft_write only. --dry-run may always use mock input.
// ---------------------------------------------------------------------------

export function assertLiveMockInputAllowed(run: FinalAssetGenerationRun, filename: string, allowMockInput: boolean): void {
  if (run.generation.isMock && !allowMockInput) {
    throw new CmsWriteConfigError(
      `The selected Asset Generation run ("${filename}") was mock-generated (generation.isMock = true). A real draft write refuses ` +
        "mock input by default — pass --allow-mock-input to override for explicit testing. Even with the override, only a Sanity draft is written."
    );
  }
}

// ---------------------------------------------------------------------------
// Output paths (topic-id-suffixed, mirroring growth/scripts/generate-assets.ts's
// own local resolver — a naming convention unique to this pipeline stage).
// ---------------------------------------------------------------------------

function resolveNamedSnapshotPath(dir: string, baseNameWithoutExt: string, overwrite: boolean, exists: (path: string) => boolean = existsSync, now: Date = new Date()): string {
  const basePath = join(dir, `${baseNameWithoutExt}.json`);
  if (overwrite || !exists(basePath)) return basePath;
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return join(dir, `${baseNameWithoutExt}.${timestamp}.json`);
}

export function resolveRequestPath(period: DateRange, topicId: string, overwrite: boolean, exists?: (path: string) => boolean, now?: Date): string {
  return resolveNamedSnapshotPath(REQUESTS_DIR, `cms-write-request-${period.start}_to_${period.end}-${topicId}`, overwrite, exists, now);
}

export function resolveReceiptPath(period: DateRange, topicId: string, overwrite: boolean, exists?: (path: string) => boolean, now?: Date): string {
  return resolveNamedSnapshotPath(RECEIPTS_DIR, `cms-write-receipt-${period.start}_to_${period.end}-${topicId}`, overwrite, exists, now);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type RunResult =
  | { mode: "dry-run"; requestPath: string; markdownPath: string; preview: CmsWriteDryRunPreview; notices: string[] }
  | { mode: "draft-write"; receiptPath: string; markdownPath: string; run: FinalCmsWriterRun; notices: string[] };

export async function run(argv: string[], deps: FileSystemDeps = defaultDeps): Promise<RunResult> {
  const args = parseArgs(argv);
  const period: DateRange = { start: args.start as string, end: args.end as string };
  assertValidDateRange(period.start, period.end);

  const { filename, content, run: assetGenerationRun, notice } = loadAssetGenerationRun(args, period, deps);
  const notices = notice ? [notice] : [];
  const topicId = assetGenerationRun.provenance.selectedTopicId;
  const sourceSha256 = sha256(content);

  if (args.dryRun) {
    const cmsRun = await runCmsWriter({
      run: assetGenerationRun,
      sourceFilename: filename,
      sourceSha256,
      mode: "dry_run",
      dataset: null,
      review: { reviewedBy: args.reviewedBy ?? null, reviewNote: args.reviewNote ?? null },
      allowMockInputUsed: args.allowMockInput,
    });

    const preview = buildCmsWriteDryRunPreview(cmsRun, { allowMockInputUsed: args.allowMockInput });

    const requestPath = resolveRequestPath(period, topicId, args.overwrite, deps.exists);
    const markdownPath = requestPath.replace(/\.json$/, ".md");
    writeFileAtomic(requestPath, `${JSON.stringify(preview, null, 2)}\n`);
    writeFileAtomic(markdownPath, renderCmsWriteMarkdown(cmsRun));

    return { mode: "dry-run", requestPath, markdownPath, preview, notices };
  }

  // --write-draft
  assertLiveMockInputAllowed(assetGenerationRun, filename, args.allowMockInput);

  const env = readSanityEnv();
  const config = assertSanityConfigured(env);
  const client = createSanityWriteClient(config);

  const cmsRun = await runCmsWriter({
    run: assetGenerationRun,
    sourceFilename: filename,
    sourceSha256,
    mode: "draft_write",
    dataset: config.dataset,
    review: { reviewedBy: args.reviewedBy as string, reviewNote: args.reviewNote ?? null },
    allowMockInputUsed: args.allowMockInput,
    sanityClient: client,
    projectId: config.projectId,
    apiVersion: config.apiVersion,
  });

  const receiptPath = resolveReceiptPath(period, topicId, args.overwrite, deps.exists);
  const markdownPath = receiptPath.replace(/\.json$/, ".md");
  writeFileAtomic(receiptPath, `${JSON.stringify(cmsRun, null, 2)}\n`);
  writeFileAtomic(markdownPath, renderCmsWriteMarkdown(cmsRun));

  return { mode: "draft-write", receiptPath, markdownPath, run: cmsRun, notices };
}

async function main(): Promise<void> {
  try {
    const result = await run(process.argv.slice(2));

    for (const notice of result.notices) {
      console.log(`[growth:cms-write] ${notice}`);
    }

    if (result.mode === "dry-run") {
      const { preview } = result;
      console.log(`[growth:cms-write] Mode: dry-run (no network request made)`);
      console.log(`[growth:cms-write] Source Asset Generation run: ${preview.sourceAssetGenerationFilename}`);
      console.log(`[growth:cms-write] Period: ${preview.period.start} to ${preview.period.end}`);
      console.log(`[growth:cms-write] Selected topic: ${preview.selectedTopicId}`);
      console.log(`[growth:cms-write] AssetBundle ID: ${preview.assetBundleId}`);
      console.log(`[growth:cms-write] Canonical document ID: ${preview.canonicalDocumentId}`);
      console.log(`[growth:cms-write] Draft document ID (would be written): ${preview.draftDocumentId}`);
      console.log(`[growth:cms-write] SEO title: ${preview.cmsWriteRequest.payload.seo.title}`);
      console.log(`[growth:cms-write] Request preview written to: ${result.requestPath}`);
      console.log(`[growth:cms-write] Markdown review written to: ${result.markdownPath}`);
      console.log("[growth:cms-write] Dry run complete — no CMS write or publish occurred.");
      return;
    }

    const { run: finalRun } = result;
    console.log(`[growth:cms-write] Mode: draft-write`);
    console.log(`[growth:cms-write] Draft document written: ${finalRun.receipt?.draftDocumentId ?? "unknown"}`);
    console.log(`[growth:cms-write] Canonical document ID: ${finalRun.receipt?.canonicalDocumentId ?? "unknown"}`);
    console.log(`[growth:cms-write] Reviewed by: ${finalRun.review.reviewedBy}`);
    console.log(`[growth:cms-write] Receipt written to: ${result.receiptPath}`);
    console.log(`[growth:cms-write] Markdown review written to: ${result.markdownPath}`);
    console.log("[growth:cms-write] A Sanity draft was created or replaced. It was NOT published — publish it manually in Sanity Studio when ready.");
  } catch (err) {
    if (
      err instanceof CmsWriteDateRangeError ||
      err instanceof CmsWriteInputError ||
      err instanceof CmsWriteConfigError ||
      err instanceof CmsWriterValidationError ||
      err instanceof SanityConfigError ||
      err instanceof SanityWriteError
    ) {
      console.error(`[growth:cms-write] ${err.message}`);
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[growth:cms-write] Unexpected error: ${reason}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
