import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileAtomic } from "../lib/collector-fs";
import {
  PeriodMismatchError,
  findMatchingFiles as findMatchingFilesShared,
  multipleMatchesNotice as multipleMatchesNoticeShared,
  selectLatestSnapshot as selectLatestSnapshotShared,
  assertPeriodMatches as assertPeriodMatchesShared,
} from "../lib/snapshot-discovery";
import {
  AssetGenerationInputError,
  AssetGenerationSlugError,
  AssetGenerationValidationError,
  buildAssetGenerationContext,
  buildExistingAppCatalog,
  resolveSelectedTopic,
  runAssetGenerationAgent,
  ASSET_GENERATION_ALLOWED_CTA_TYPES,
  SEO_PERSISTENCE_WARNING,
} from "../agents/asset-generation-agent";
import { buildAssetGenerationLLMRequest } from "../prompts/asset-generation-prompt";
import { renderAssetGenerationMarkdown } from "../renderers/asset-generation-markdown";
import { AnthropicAssetGenerationProvider } from "../llm/anthropic-asset-generation-provider";
import { MockAssetGenerationProvider } from "../llm/mock-asset-generation-provider";
import { LLMProviderConfigError, LLMProviderResponseError } from "../llm/asset-generation-provider";
import type { AssetGenerationProvider } from "../llm/asset-generation-provider";
import type { DateRange } from "../types/growth-summary";
import type { FinalTopicScoringRun } from "../types/topic-scoring";
import type { SupportedLanguage } from "../types/llm";
import type { AssetGenerationDryRunPreview, FinalAssetGenerationRun } from "../types/asset-generation";

const GROWTH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROCESSED_DATA_DIR = join(GROWTH_DIR, "data", "processed");
const SCORES_DIR = join(GROWTH_DIR, "scores");
const ASSETS_DIR = join(GROWTH_DIR, "assets");

const DEFAULT_MAX_TOKENS = 10000;
const DEFAULT_PROMPT_VERSION = "1.0.0";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class AssetGenerationDateRangeError extends Error {}
export class AssetGenerationConfigError extends Error {}
export { AssetGenerationInputError };

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export interface CollectArgs {
  start?: string;
  end?: string;
  input?: string;
  topicId?: string;
  language: SupportedLanguage;
  provider?: string;
  socialChannels: string[];
  overwrite: boolean;
  dryRun: boolean;
  allowMockInput: boolean;
  allowUnapprovedTopic: boolean;
  allowHoldTopic: boolean;
}

export function parseSocialChannels(raw: string | undefined): string[] {
  if (!raw) return [];
  const channels = raw
    .split(",")
    .map((channel) => channel.trim().toLowerCase())
    .filter((channel) => channel.length > 0);
  return [...new Set(channels)];
}

export function parseArgs(argv: string[]): CollectArgs {
  const args: CollectArgs = {
    language: "en",
    socialChannels: [],
    overwrite: false,
    dryRun: false,
    allowMockInput: false,
    allowUnapprovedTopic: false,
    allowHoldTopic: false,
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
    } else if (arg === "--language") {
      const language = argv[++i];
      if (language !== "en" && language !== "zh-CN") {
        throw new Error(`Unsupported --language "${language}". Use "en" or "zh-CN".`);
      }
      args.language = language;
    } else if (arg === "--provider") {
      args.provider = argv[++i];
    } else if (arg === "--social-channels") {
      args.socialChannels = parseSocialChannels(argv[++i]);
    } else if (arg === "--overwrite") {
      args.overwrite = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--allow-mock-input") {
      args.allowMockInput = true;
    } else if (arg === "--allow-unapproved-topic") {
      args.allowUnapprovedTopic = true;
    } else if (arg === "--allow-hold-topic") {
      args.allowHoldTopic = true;
    } else {
      throw new Error(`Unrecognized argument "${arg}".`);
    }
  }

  if (args.start && !args.end) {
    throw new Error("--start was given without --end. Both are required together.");
  }
  if (args.end && !args.start) {
    throw new Error("--end was given without --start. Both are required together.");
  }
  if (!args.start || !args.end) {
    throw new Error("growth:generate-assets requires --start and --end (ISO YYYY-MM-DD), even when --input is given.");
  }
  if (!args.topicId) {
    throw new Error("growth:generate-assets requires --topic-id — an explicit topic must always be selected; there is no automatic rank-1/top-topic selection.");
  }

  return args;
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Throws AssetGenerationDateRangeError if either date isn't ISO YYYY-MM-DD, or start is after end. */
export function assertValidDateRange(start: string, end: string): void {
  if (!isValidIsoDate(start)) {
    throw new AssetGenerationDateRangeError(`Invalid --start date "${start}". Use ISO format YYYY-MM-DD.`);
  }
  if (!isValidIsoDate(end)) {
    throw new AssetGenerationDateRangeError(`Invalid --end date "${end}". Use ISO format YYYY-MM-DD.`);
  }
  if (start > end) {
    throw new AssetGenerationDateRangeError(`--start (${start}) must not be after --end (${end}).`);
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface ProviderEnvConfig {
  provider: string | undefined;
  model: string | undefined;
  maxTokens: number;
  promptVersion: string;
  apiKey: string | undefined;
  growthReportProvider: string | undefined;
  growthReportModel: string | undefined;
}

export function readProviderEnv(source: NodeJS.ProcessEnv = process.env): ProviderEnvConfig {
  const rawMaxTokens = source.ASSET_GENERATION_MAX_TOKENS ? Number(source.ASSET_GENERATION_MAX_TOKENS) : NaN;
  const maxTokens = Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? rawMaxTokens : DEFAULT_MAX_TOKENS;
  const promptVersion = source.ASSET_GENERATION_PROMPT_VERSION && source.ASSET_GENERATION_PROMPT_VERSION.trim().length > 0
    ? source.ASSET_GENERATION_PROMPT_VERSION
    : DEFAULT_PROMPT_VERSION;

  return {
    provider: source.ASSET_GENERATION_LLM_PROVIDER,
    model: source.ASSET_GENERATION_MODEL,
    maxTokens,
    promptVersion,
    apiKey: source.ANTHROPIC_API_KEY,
    growthReportProvider: source.GROWTH_REPORT_LLM_PROVIDER,
    growthReportModel: source.GROWTH_REPORT_MODEL,
  };
}

/** Resolves the live provider. Never called in --dry-run mode, so dry-run never requires any of this. */
export function resolveProvider(args: CollectArgs, env: ProviderEnvConfig): AssetGenerationProvider {
  const providerName = args.provider ?? env.provider ?? env.growthReportProvider;

  if (!providerName) {
    throw new AssetGenerationConfigError(
      "No LLM provider configured. Pass --provider mock for local testing, or set ASSET_GENERATION_LLM_PROVIDER " +
        '(or GROWTH_REPORT_LLM_PROVIDER) to "anthropic" (plus a resolved model and ANTHROPIC_API_KEY) in .env for a live run.'
    );
  }

  if (providerName === "mock") {
    return new MockAssetGenerationProvider();
  }

  if (providerName === "anthropic") {
    const model = env.model ?? env.growthReportModel;
    if (!env.apiKey) {
      throw new AssetGenerationConfigError(
        "ANTHROPIC_API_KEY is required for a live Anthropic run. Set it in .env, or use --provider mock / --dry-run instead."
      );
    }
    if (!model) {
      throw new AssetGenerationConfigError(
        "No Anthropic model resolved (checked ASSET_GENERATION_MODEL, then GROWTH_REPORT_MODEL). Set one in .env once a model is confirmed."
      );
    }
    return new AnthropicAssetGenerationProvider({ apiKey: env.apiKey, model });
  }

  throw new AssetGenerationConfigError(`Unknown provider "${providerName}". Supported values: "mock", "anthropic".`);
}

// ---------------------------------------------------------------------------
// Input discovery: FinalTopicScoringRun JSON only — never the Markdown
// file, never Signal Mining/Growth Summary/Growth Report/Experiment
// Decision files, never an external website.
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

function isValidFinalTopicScoringRun(value: unknown): value is FinalTopicScoringRun {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== "1.0.0" || v.runType !== "topic_scoring") return false;
  if (typeof v.generatedAt !== "string") return false;

  const period = v.period as Record<string, unknown> | undefined;
  if (!period || typeof period.start !== "string" || typeof period.end !== "string") return false;

  const campaign = v.campaign as Record<string, unknown> | undefined;
  if (!campaign || typeof campaign.id !== "string" || typeof campaign.name !== "string") return false;

  const generation = v.generation as Record<string, unknown> | undefined;
  if (!generation || typeof generation.provider !== "string" || typeof generation.model !== "string" || typeof generation.isMock !== "boolean") {
    return false;
  }

  const humanReview = v.humanReview as Record<string, unknown> | undefined;
  if (!humanReview || typeof humanReview.approved !== "boolean") return false;

  if (!Array.isArray(v.topicCatalog)) return false;
  if (!Array.isArray(v.scoredTopics)) return false;

  const dataQuality = v.dataQuality as Record<string, unknown> | undefined;
  const status = dataQuality?.overallStatus;
  if (status !== "complete" && status !== "partial" && status !== "invalid") return false;

  return true;
}

function parseAndValidateTopicScoringRun(content: string, filename: string): FinalTopicScoringRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new AssetGenerationInputError(`Failed to parse "${filename}" as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isValidFinalTopicScoringRun(parsed)) {
    throw new AssetGenerationInputError(`"${filename}" does not match the expected FinalTopicScoringRun schema (runType must be "topic_scoring").`);
  }

  if (parsed.dataQuality.overallStatus === "invalid") {
    throw new AssetGenerationInputError(
      `"${filename}" has dataQuality.overallStatus = "invalid"; the Asset Generation Agent refuses to generate from it. A "partial" status is accepted.`
    );
  }

  return parsed;
}

function assertPeriodMatches(runPeriod: DateRange, requestedPeriod: DateRange): void {
  try {
    assertPeriodMatchesShared("Topic Scoring run", runPeriod, requestedPeriod);
  } catch (err) {
    if (err instanceof PeriodMismatchError) throw new AssetGenerationInputError(err.message);
    throw err;
  }
}

export interface LoadedTopicScoringRun {
  filename: string;
  content: string;
  run: FinalTopicScoringRun;
  notice?: string;
}

/** Loads the Topic Scoring run for `period`: either exactly `args.input`, or the latest-generatedAt discovered `topic-scoring-*.json` match. Never selects the sibling `.md` file. */
export function loadTopicScoringRun(args: CollectArgs, period: DateRange, deps: FileSystemDeps = defaultDeps): LoadedTopicScoringRun {
  if (args.input) {
    const content = deps.readFile(args.input);
    const run = parseAndValidateTopicScoringRun(content, basenameOnly(args.input));
    assertPeriodMatches(run.period, period);
    return { filename: basenameOnly(args.input), content, run };
  }

  const matches = findMatchingFilesShared(SCORES_DIR, "topic-scoring", period, deps.listDir);
  if (matches.length === 0) {
    throw new AssetGenerationInputError(
      `No Topic Scoring run found for ${period.start} to ${period.end}. Expected a file matching ` +
        `growth/scores/topic-scoring-${period.start}_to_${period.end}*.json — run growth:score-topics for this range first.`
    );
  }

  let selected: { filename: string; snapshot: { generatedAt: string } } | undefined;
  try {
    selected = selectLatestSnapshotShared<{ generatedAt: string }>(SCORES_DIR, matches, deps.readFile, (s) => s.generatedAt);
  } catch (err) {
    throw new AssetGenerationInputError(
      `Failed to parse a matching Topic Scoring run for ${period.start} to ${period.end} as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!selected) {
    throw new AssetGenerationInputError(`Failed to read any matching Topic Scoring run for ${period.start} to ${period.end}.`);
  }

  const content = deps.readFile(join(SCORES_DIR, selected.filename));
  const run = parseAndValidateTopicScoringRun(content, selected.filename);
  assertPeriodMatches(run.period, period);

  const notice = matches.length > 1 ? multipleMatchesNoticeShared("Topic Scoring run", selected.filename) : undefined;

  return { filename: selected.filename, content, run, notice };
}

// ---------------------------------------------------------------------------
// Selection gating: mock input, unapproved topics, hold recommendation
// ---------------------------------------------------------------------------

/** Live Anthropic execution refuses a mock-generated Topic Scoring run by default — never called for --dry-run or --provider mock, which may consume either. `--allow-mock-input` opts in explicitly, for testing. */
export function assertLiveMockInputAllowed(run: FinalTopicScoringRun, filename: string, allowMockInput: boolean): void {
  if (run.generation.isMock && !allowMockInput) {
    throw new AssetGenerationConfigError(
      `The selected Topic Scoring run ("${filename}") was mock-generated (generation.isMock = true). Live Anthropic execution ` +
        "refuses to generate from a mock run by default — pass --allow-mock-input to override for explicit testing."
    );
  }
}

/** Live Anthropic execution refuses a run whose topics were never human-approved by default. Ranking or an 'advance' recommendation is never treated as approval. */
export function assertLiveUnapprovedTopicAllowed(run: FinalTopicScoringRun, allowUnapprovedTopic: boolean): void {
  if (!run.humanReview.approved && !allowUnapprovedTopic) {
    throw new AssetGenerationConfigError(
      "The source Topic Scoring run's topics have not been human-approved (humanReview.approved = false). Live Anthropic execution refuses " +
        "to generate from an unapproved topic by default — pass --allow-unapproved-topic to override for explicit testing."
    );
  }
}

/**
 * A `hold` topic is rejected by default in every mode. Mock/dry-run may
 * proceed only with `--allow-hold-topic` (engineering validation); live
 * Anthropic generation for a `hold` topic remains rejected in v1 no matter
 * what flags are passed.
 */
export function assertHoldTopicAllowed(recommendation: string, mode: "dry-run" | "mock" | "anthropic", allowHoldTopic: boolean): void {
  if (recommendation !== "hold") return;
  if (mode === "anthropic") {
    throw new AssetGenerationConfigError("Selected topic's recommendation is \"hold\". Live Anthropic generation for a 'hold' topic is not supported in v1 — select a different topic.");
  }
  if (!allowHoldTopic) {
    throw new AssetGenerationConfigError(
      `Selected topic's recommendation is "hold". Pass --allow-hold-topic to generate from it anyway (engineering validation only).`
    );
  }
}

// ---------------------------------------------------------------------------
// Output paths (topic-id-suffixed — a naming convention unique to this
// Agent, so a small local resolver mirrors resolveSnapshotPath's exact
// collision/atomic-write behavior without changing the shared helper).
// ---------------------------------------------------------------------------

function resolveNamedSnapshotPath(dir: string, baseNameWithoutExt: string, overwrite: boolean, exists: (path: string) => boolean = existsSync, now: Date = new Date()): string {
  const basePath = join(dir, `${baseNameWithoutExt}.json`);
  if (overwrite || !exists(basePath)) return basePath;
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return join(dir, `${baseNameWithoutExt}.${timestamp}.json`);
}

export function resolvePreviewPath(period: DateRange, topicId: string, overwrite: boolean, exists?: (path: string) => boolean, now?: Date): string {
  return resolveNamedSnapshotPath(PROCESSED_DATA_DIR, `asset-generation-request-${period.start}_to_${period.end}-${topicId}`, overwrite, exists, now);
}

export function resolveRunJsonPath(period: DateRange, topicId: string, overwrite: boolean, exists?: (path: string) => boolean, now?: Date): string {
  return resolveNamedSnapshotPath(ASSETS_DIR, `asset-generation-${period.start}_to_${period.end}-${topicId}`, overwrite, exists, now);
}

// ---------------------------------------------------------------------------
// Dry-run preview
// ---------------------------------------------------------------------------

export interface BuildDryRunPreviewParams {
  run: FinalTopicScoringRun;
  runFilename: string;
  runContent: string;
  topicId: string;
  language: SupportedLanguage;
  socialChannels: string[];
  intendedProvider: string;
  intendedModel: string | undefined;
  maxTokens: number;
  overrides: { allowMockInput: boolean; allowUnapprovedTopic: boolean; allowHoldTopic: boolean };
  createdAt?: string;
}

/** Pure: builds the dry-run preview object (never writes it). Never includes API keys/tokens/credential paths. */
export function buildDryRunPreview(params: BuildDryRunPreviewParams): AssetGenerationDryRunPreview {
  const { topic, scoredTopic } = resolveSelectedTopic(params.run, params.topicId);
  const existingAppCatalog = buildExistingAppCatalog();

  const context = buildAssetGenerationContext({
    run: params.run,
    topic,
    scoredTopic,
    language: params.language,
    requestedSocialChannels: params.socialChannels,
    existingAppCatalog,
  });

  const request = buildAssetGenerationLLMRequest({
    campaign: params.run.campaign,
    period: params.run.period,
    language: params.language,
    context,
    allowedCtaTypes: [...ASSET_GENERATION_ALLOWED_CTA_TYPES],
    requestedSocialChannels: params.socialChannels,
    maxTokens: params.maxTokens,
  });

  return {
    source: "asset_generation_dry_run",
    createdAt: params.createdAt ?? new Date().toISOString(),
    period: params.run.period,
    campaign: params.run.campaign,
    sourceTopicScoringFilename: params.runFilename,
    sourceTopicScoringSha256: sha256(params.runContent),
    sourceTopicScoringIsMock: params.run.generation.isMock,
    sourceTopicsHumanReviewed: params.run.humanReview.approved,
    selectedTopicId: topic.id,
    selectedTopicRecommendation: scoredTopic.recommendation,
    selectedTopicRank: scoredTopic.ranking?.rank ?? null,
    selectedTopicScore: scoredTopic.totalScore,
    overrides: params.overrides,
    generationContext: context,
    existingAppCatalog,
    requestedSocialChannels: params.socialChannels,
    seoPersistenceLimitation: SEO_PERSISTENCE_WARNING,
    language: params.language,
    intendedProvider: params.intendedProvider,
    intendedModel: params.intendedModel ?? "not_configured",
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    responseSchemaDescription: request.responseSchemaDescription,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type RunResult =
  | { mode: "dry-run"; previewPath: string; preview: AssetGenerationDryRunPreview; notices: string[] }
  | { mode: "assets"; jsonPath: string; markdownPath: string; run: FinalAssetGenerationRun; notices: string[] };

export async function run(argv: string[], deps: FileSystemDeps = defaultDeps): Promise<RunResult> {
  const args = parseArgs(argv);
  const period: DateRange = { start: args.start as string, end: args.end as string };
  const topicId = args.topicId as string;
  assertValidDateRange(period.start, period.end);

  const { filename, content, run: topicScoringRun, notice } = loadTopicScoringRun(args, period, deps);
  const notices = notice ? [notice] : [];

  const { scoredTopic } = resolveSelectedTopic(topicScoringRun, topicId);

  const env = readProviderEnv();

  if (args.dryRun) {
    assertHoldTopicAllowed(scoredTopic.recommendation, "dry-run", args.allowHoldTopic);

    const intendedProviderName = args.provider ?? env.provider ?? env.growthReportProvider ?? "not_configured";
    const intendedModel = env.model ?? env.growthReportModel;

    const preview = buildDryRunPreview({
      run: topicScoringRun,
      runFilename: filename,
      runContent: content,
      topicId,
      language: args.language,
      socialChannels: args.socialChannels,
      intendedProvider: intendedProviderName,
      intendedModel,
      maxTokens: env.maxTokens,
      overrides: { allowMockInput: args.allowMockInput, allowUnapprovedTopic: args.allowUnapprovedTopic, allowHoldTopic: args.allowHoldTopic },
    });

    const previewPath = resolvePreviewPath(period, topicId, args.overwrite, deps.exists);
    writeFileAtomic(previewPath, `${JSON.stringify(preview, null, 2)}\n`);

    return { mode: "dry-run", previewPath, preview, notices };
  }

  const provider = resolveProvider(args, env);
  const mode = provider.name === "anthropic" ? "anthropic" : "mock";
  assertHoldTopicAllowed(scoredTopic.recommendation, mode, args.allowHoldTopic);

  if (provider.name === "anthropic") {
    assertLiveMockInputAllowed(topicScoringRun, filename, args.allowMockInput);
    assertLiveUnapprovedTopicAllowed(topicScoringRun, args.allowUnapprovedTopic);
  }

  const assetGenerationRun = await runAssetGenerationAgent({
    run: topicScoringRun,
    topicId,
    sourceFilename: filename,
    sourceSha256: sha256(content),
    language: args.language,
    maxTokens: env.maxTokens,
    promptVersion: env.promptVersion,
    provider,
    requestedSocialChannels: args.socialChannels,
    allowMockInputUsed: args.allowMockInput,
    allowUnapprovedTopicUsed: args.allowUnapprovedTopic,
    allowHoldTopicUsed: args.allowHoldTopic,
  });

  const jsonPath = resolveRunJsonPath(period, topicId, args.overwrite, deps.exists);
  const markdownPath = jsonPath.replace(/\.json$/, ".md");

  writeFileAtomic(jsonPath, `${JSON.stringify(assetGenerationRun, null, 2)}\n`);
  writeFileAtomic(markdownPath, renderAssetGenerationMarkdown(assetGenerationRun));

  return { mode: "assets", jsonPath, markdownPath, run: assetGenerationRun, notices };
}

async function main(): Promise<void> {
  try {
    const result = await run(process.argv.slice(2));

    for (const notice of result.notices) {
      console.log(`[growth:generate-assets] ${notice}`);
    }

    if (result.mode === "dry-run") {
      console.log(`[growth:generate-assets] Selected Topic Scoring run: ${result.preview.sourceTopicScoringFilename}`);
      console.log(`[growth:generate-assets] Period: ${result.preview.period.start} to ${result.preview.period.end}`);
      console.log(`[growth:generate-assets] Selected topic: ${result.preview.selectedTopicId} (${result.preview.generationContext.canonicalName})`);
      console.log(`[growth:generate-assets] Rank: ${result.preview.selectedTopicRank ?? "unavailable"}`);
      console.log(`[growth:generate-assets] Score: ${result.preview.selectedTopicScore}`);
      console.log(`[growth:generate-assets] Recommendation: ${result.preview.selectedTopicRecommendation}`);
      console.log(`[growth:generate-assets] Source mock: ${result.preview.sourceTopicScoringIsMock ? "yes" : "no"}`);
      console.log(`[growth:generate-assets] Source human-reviewed: ${result.preview.sourceTopicsHumanReviewed ? "yes" : "no"}`);
      console.log(`[growth:generate-assets] Requested social channels: ${result.preview.requestedSocialChannels.join(", ") || "none"}`);
      console.log(`[growth:generate-assets] Intended provider: ${result.preview.intendedProvider}`);
      console.log(`[growth:generate-assets] Intended model: ${result.preview.intendedModel}`);
      console.log(`[growth:generate-assets] Request preview written to: ${result.previewPath}`);
      console.log("[growth:generate-assets] Dry run complete — no provider request was made.");
      return;
    }

    const { run: finalRun } = result;
    console.log(`[growth:generate-assets] Selected Topic Scoring run: ${finalRun.provenance.sourceTopicScoringFilename}`);
    console.log(`[growth:generate-assets] Provider: ${finalRun.generation.provider}${finalRun.generation.isMock ? " (mock)" : ""}`);
    console.log(`[growth:generate-assets] Model: ${finalRun.generation.model}`);
    console.log(`[growth:generate-assets] Selected topic: ${finalRun.provenance.selectedTopicId} (${finalRun.selectedTopic.canonicalName})`);
    console.log(`[growth:generate-assets] Generated app name: ${finalRun.assetBundle.app.name}`);
    console.log(`[growth:generate-assets] Generated slug: ${finalRun.assetBundle.app.slug}`);
    console.log(`[growth:generate-assets] AssetBundle validation status: ${finalRun.assetBundle.validation.status}`);
    console.log(`[growth:generate-assets] Source mock: ${finalRun.provenance.sourceTopicScoringIsMock ? "yes" : "no"}`);
    console.log(`[growth:generate-assets] Human review required: ${finalRun.humanReview.required ? "yes" : "no"}`);
    console.log(`[growth:generate-assets] Social posts: ${finalRun.assetBundle.social.posts.length}`);
    console.log(`[growth:generate-assets] JSON output: ${result.jsonPath}`);
    console.log(`[growth:generate-assets] Markdown output: ${result.markdownPath}`);
    console.log(`[growth:generate-assets] Warnings: ${finalRun.assetBundle.validation.warnings.length}`);
    const { inputTokens, outputTokens } = finalRun.generation.usage;
    if (inputTokens !== null || outputTokens !== null) {
      console.log(`[growth:generate-assets] Token usage: input=${inputTokens ?? "unavailable"}, output=${outputTokens ?? "unavailable"}`);
    }
  } catch (err) {
    if (
      err instanceof AssetGenerationDateRangeError ||
      err instanceof AssetGenerationInputError ||
      err instanceof AssetGenerationConfigError ||
      err instanceof AssetGenerationValidationError ||
      err instanceof AssetGenerationSlugError ||
      err instanceof LLMProviderConfigError ||
      err instanceof LLMProviderResponseError
    ) {
      console.error(`[growth:generate-assets] ${err.message}`);
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[growth:generate-assets] Unexpected error: ${reason}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
