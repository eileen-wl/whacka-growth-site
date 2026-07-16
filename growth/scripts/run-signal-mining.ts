import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSnapshotPath, writeFileAtomic } from "../lib/collector-fs";
import {
  PeriodMismatchError,
  findMatchingFiles as findMatchingFilesShared,
  multipleMatchesNotice as multipleMatchesNoticeShared,
  selectLatestSnapshot as selectLatestSnapshotShared,
  assertPeriodMatches as assertPeriodMatchesShared,
} from "../lib/snapshot-discovery";
import { SignalMiningValidationError, buildSignalMiningFeedbackContext, runSignalMiningAgent } from "../agents/signal-mining-agent";
import { buildSignalMiningLLMRequest } from "../prompts/signal-mining-prompt";
import { renderSignalMiningMarkdown } from "../renderers/signal-mining-markdown";
import { NormalizedGrowthSummaryAdapter } from "../signal-sources/normalized-growth-summary-adapter";
import { GrowthLoopFeedbackAdapter } from "../signal-sources/growth-loop-feedback-adapter";
import { ManualInputValidationError, ManualJsonSignalAdapter, parseManualInputDocument, validateManualSignalRecords } from "../signal-sources/manual-json-signal-adapter";
import { buildExistingContentCatalog } from "../signal-sources/existing-content-catalog";
import { AnthropicSignalMiningProvider } from "../llm/anthropic-signal-mining-provider";
import { MockSignalMiningProvider } from "../llm/mock-signal-mining-provider";
import { LLMProviderConfigError, LLMProviderResponseError } from "../llm/signal-mining-provider";
import { GrowthLoopFeedbackValidationError, validateGrowthLoopFeedback } from "../contracts/loop-feedback";
import type { SignalMiningProvider } from "../llm/signal-mining-provider";
import type { GrowthLoopFeedback } from "../contracts/loop-feedback";
import type { DateRange, GrowthSummary } from "../types/growth-summary";
import type { SupportedLanguage } from "../types/llm";
import type { FinalSignalMiningRun, SignalMiningDryRunPreview, SignalSourceRecord } from "../types/signal-mining";

const GROWTH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROCESSED_DATA_DIR = join(GROWTH_DIR, "data", "processed");
const DECISIONS_DIR = join(GROWTH_DIR, "decisions");
const SIGNALS_DIR = join(GROWTH_DIR, "signals");

const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_MAX_SOURCE_RECORDS = 100;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class SignalMiningDateRangeError extends Error {}
export class SignalMiningInputError extends Error {}
export class SignalMiningConfigError extends Error {}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export interface CollectArgs {
  start?: string;
  end?: string;
  summary?: string;
  feedback?: string;
  manualInput?: string;
  language: SupportedLanguage;
  provider?: string;
  overwrite: boolean;
  dryRun: boolean;
  allowMockInput: boolean;
}

export function parseArgs(argv: string[]): CollectArgs {
  const args: CollectArgs = { language: "en", overwrite: false, dryRun: false, allowMockInput: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--start") {
      args.start = argv[++i];
    } else if (arg === "--end") {
      args.end = argv[++i];
    } else if (arg === "--summary") {
      args.summary = argv[++i];
    } else if (arg === "--feedback") {
      args.feedback = argv[++i];
    } else if (arg === "--manual-input") {
      args.manualInput = argv[++i];
    } else if (arg === "--language") {
      const language = argv[++i];
      if (language !== "en" && language !== "zh-CN") {
        throw new Error(`Unsupported --language "${language}". Use "en" or "zh-CN".`);
      }
      args.language = language;
    } else if (arg === "--provider") {
      args.provider = argv[++i];
    } else if (arg === "--overwrite") {
      args.overwrite = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--allow-mock-input") {
      args.allowMockInput = true;
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
    throw new Error("growth:signals requires --start and --end (ISO YYYY-MM-DD), even when --summary is given.");
  }

  return args;
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Throws SignalMiningDateRangeError if either date isn't ISO YYYY-MM-DD, or start is after end. */
export function assertValidDateRange(start: string, end: string): void {
  if (!isValidIsoDate(start)) {
    throw new SignalMiningDateRangeError(`Invalid --start date "${start}". Use ISO format YYYY-MM-DD.`);
  }
  if (!isValidIsoDate(end)) {
    throw new SignalMiningDateRangeError(`Invalid --end date "${end}". Use ISO format YYYY-MM-DD.`);
  }
  if (start > end) {
    throw new SignalMiningDateRangeError(`--start (${start}) must not be after --end (${end}).`);
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface ProviderEnvConfig {
  provider: string | undefined;
  model: string | undefined;
  maxTokens: number;
  maxSourceRecords: number;
  apiKey: string | undefined;
  growthReportProvider: string | undefined;
  growthReportModel: string | undefined;
}

export function readProviderEnv(source: NodeJS.ProcessEnv = process.env): ProviderEnvConfig {
  const rawMaxTokens = source.SIGNAL_MINING_MAX_TOKENS ? Number(source.SIGNAL_MINING_MAX_TOKENS) : NaN;
  const maxTokens = Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? rawMaxTokens : DEFAULT_MAX_TOKENS;

  const rawMaxRecords = source.SIGNAL_MINING_MAX_SOURCE_RECORDS ? Number(source.SIGNAL_MINING_MAX_SOURCE_RECORDS) : NaN;
  const maxSourceRecords = Number.isFinite(rawMaxRecords) && rawMaxRecords > 0 ? rawMaxRecords : DEFAULT_MAX_SOURCE_RECORDS;

  return {
    provider: source.SIGNAL_MINING_LLM_PROVIDER,
    model: source.SIGNAL_MINING_MODEL,
    maxTokens,
    maxSourceRecords,
    apiKey: source.ANTHROPIC_API_KEY,
    growthReportProvider: source.GROWTH_REPORT_LLM_PROVIDER,
    growthReportModel: source.GROWTH_REPORT_MODEL,
  };
}

/** Resolves the live provider. Never called in --dry-run mode, so dry-run never requires any of this. */
export function resolveProvider(args: CollectArgs, env: ProviderEnvConfig): SignalMiningProvider {
  const providerName = args.provider ?? env.provider ?? env.growthReportProvider;

  if (!providerName) {
    throw new SignalMiningConfigError(
      "No LLM provider configured. Pass --provider mock for local testing, or set SIGNAL_MINING_LLM_PROVIDER " +
        '(or GROWTH_REPORT_LLM_PROVIDER) to "anthropic" (plus a resolved model and ANTHROPIC_API_KEY) in .env for a live run.'
    );
  }

  if (providerName === "mock") {
    return new MockSignalMiningProvider();
  }

  if (providerName === "anthropic") {
    const model = env.model ?? env.growthReportModel;
    if (!env.apiKey) {
      throw new SignalMiningConfigError(
        "ANTHROPIC_API_KEY is required for a live Anthropic run. Set it in .env, or use --provider mock / --dry-run instead."
      );
    }
    if (!model) {
      throw new SignalMiningConfigError(
        "No Anthropic model resolved (checked SIGNAL_MINING_MODEL, then GROWTH_REPORT_MODEL). Set one in .env once a model is confirmed."
      );
    }
    return new AnthropicSignalMiningProvider({ apiKey: env.apiKey, model });
  }

  throw new SignalMiningConfigError(`Unknown provider "${providerName}". Supported values: "mock", "anthropic".`);
}

// ---------------------------------------------------------------------------
// File system deps
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

// ---------------------------------------------------------------------------
// Growth Summary input
// ---------------------------------------------------------------------------

function isValidGrowthSummary(value: unknown): value is GrowthSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== "1.0.0" || v.source !== "normalized_growth_summary") return false;
  if (typeof v.generatedAt !== "string") return false;

  const period = v.period as Record<string, unknown> | undefined;
  if (!period || typeof period.start !== "string" || typeof period.end !== "string") return false;

  const campaign = v.campaign as Record<string, unknown> | undefined;
  if (!campaign || typeof campaign.id !== "string" || typeof campaign.name !== "string") return false;

  if (typeof v.traffic !== "object" || v.traffic === null) return false;
  if (typeof v.behavior !== "object" || v.behavior === null) return false;
  if (typeof v.search !== "object" || v.search === null) return false;

  const dataQuality = v.dataQuality as Record<string, unknown> | undefined;
  const status = dataQuality?.overallStatus;
  if (status !== "complete" && status !== "partial" && status !== "invalid") return false;

  return true;
}

function parseAndValidateGrowthSummary(content: string, filename: string): GrowthSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new SignalMiningInputError(`Failed to parse "${filename}" as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isValidGrowthSummary(parsed)) {
    throw new SignalMiningInputError(`"${filename}" does not match the expected normalized growth-summary schema.`);
  }

  if (parsed.dataQuality.overallStatus === "invalid") {
    throw new SignalMiningInputError(
      `"${filename}" has dataQuality.overallStatus = "invalid"; the Signal Mining Agent refuses to mine it. A "partial" status is accepted.`
    );
  }

  return parsed;
}

function assertSummaryPeriodMatches(summaryPeriod: DateRange, requestedPeriod: DateRange): void {
  try {
    assertPeriodMatchesShared("Growth summary", summaryPeriod, requestedPeriod);
  } catch (err) {
    if (err instanceof PeriodMismatchError) throw new SignalMiningInputError(err.message);
    throw err;
  }
}

export interface LoadedGrowthSummary {
  filename: string;
  content: string;
  summary: GrowthSummary;
  notice?: string;
}

/** Loads the normalized growth summary for `period`: either exactly `args.summary`, or the latest-generatedAt discovered match. Never reads raw PostHog/GA4/Search Console files. */
export function loadGrowthSummary(args: CollectArgs, period: DateRange, deps: FileSystemDeps = defaultDeps): LoadedGrowthSummary {
  if (args.summary) {
    const content = deps.readFile(args.summary);
    const summary = parseAndValidateGrowthSummary(content, args.summary);
    assertSummaryPeriodMatches(summary.period, period);
    return { filename: args.summary, content, summary };
  }

  const matches = findMatchingFilesShared(PROCESSED_DATA_DIR, "growth-summary", period, deps.listDir);
  if (matches.length === 0) {
    throw new SignalMiningInputError(
      `No normalized growth summary found for ${period.start} to ${period.end}. Expected a file matching ` +
        `growth/data/processed/growth-summary-${period.start}_to_${period.end}*.json — run growth:normalize for this range first.`
    );
  }

  let selected: { filename: string; snapshot: { generatedAt: string } } | undefined;
  try {
    selected = selectLatestSnapshotShared<{ generatedAt: string }>(PROCESSED_DATA_DIR, matches, deps.readFile, (s) => s.generatedAt);
  } catch (err) {
    throw new SignalMiningInputError(
      `Failed to parse a matching growth summary for ${period.start} to ${period.end} as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!selected) {
    throw new SignalMiningInputError(`Failed to read any matching growth summary for ${period.start} to ${period.end}.`);
  }

  const content = deps.readFile(join(PROCESSED_DATA_DIR, selected.filename));
  const summary = parseAndValidateGrowthSummary(content, selected.filename);
  assertSummaryPeriodMatches(summary.period, period);

  const notice = matches.length > 1 ? multipleMatchesNoticeShared("growth summary", selected.filename) : undefined;

  return { filename: selected.filename, content, summary, notice };
}

// ---------------------------------------------------------------------------
// GrowthLoopFeedback input (optional)
// ---------------------------------------------------------------------------

export interface LoadedFeedback {
  filename: string | null;
  content: string | null;
  feedback: GrowthLoopFeedback | null;
  notice?: string;
}

/**
 * Loads GrowthLoopFeedback when explicitly given via `--feedback`, or
 * discovers `growth/decisions/growth-loop-feedback-{start}_to_{end}*.json`
 * when present. Feedback is entirely optional — no discovered/explicit file
 * means the run simply continues without it (a non-fatal notice is
 * returned, never thrown).
 */
export function loadGrowthLoopFeedback(args: CollectArgs, period: DateRange, deps: FileSystemDeps = defaultDeps): LoadedFeedback {
  if (args.feedback) {
    const content = deps.readFile(args.feedback);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new SignalMiningInputError(`Failed to parse "${args.feedback}" as JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const feedback = validateGrowthLoopFeedback(parsed);
    return { filename: args.feedback, content, feedback };
  }

  let matches: string[] = [];
  try {
    matches = findMatchingFilesShared(DECISIONS_DIR, "growth-loop-feedback", period, deps.listDir);
  } catch {
    return { filename: null, content: null, feedback: null, notice: "No Growth Loop Feedback directory found — continuing without feedback." };
  }
  if (matches.length === 0) {
    return { filename: null, content: null, feedback: null, notice: "No Growth Loop Feedback found for this period — continuing without it." };
  }

  let selected: { filename: string; snapshot: { createdAt: string } } | undefined;
  try {
    selected = selectLatestSnapshotShared<{ createdAt: string }>(DECISIONS_DIR, matches, deps.readFile, (s) => s.createdAt);
  } catch (err) {
    throw new SignalMiningInputError(
      `Failed to parse a matching Growth Loop Feedback file for ${period.start} to ${period.end} as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!selected) {
    return { filename: null, content: null, feedback: null, notice: "No Growth Loop Feedback found for this period — continuing without it." };
  }

  const content = deps.readFile(join(DECISIONS_DIR, selected.filename));
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new SignalMiningInputError(`Failed to parse "${selected.filename}" as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const feedback = validateGrowthLoopFeedback(parsed);

  const notice = matches.length > 1 ? multipleMatchesNoticeShared("Growth Loop Feedback", selected.filename) : undefined;

  return { filename: selected.filename, content, feedback, notice };
}

/** Live Anthropic execution refuses mock-generated GrowthLoopFeedback by default — never called for --dry-run or --provider mock, which may consume either. `--allow-mock-input` opts in explicitly, for testing. */
export function assertLiveMockFeedbackAllowed(feedback: GrowthLoopFeedback | null, allowMockInput: boolean): void {
  if (feedback?.sourceDecision.isMock && !allowMockInput) {
    throw new SignalMiningConfigError(
      `The selected Growth Loop Feedback (source decision sha256: ${feedback.sourceDecision.sha256}) was mock-generated. Live Anthropic ` +
        "execution refuses to consume mock feedback by default — pass --allow-mock-input to override for explicit testing."
    );
  }
}

// ---------------------------------------------------------------------------
// Manual input (optional, --manual-input only — never auto-discovered)
// ---------------------------------------------------------------------------

export interface LoadedManualInput {
  filename: string | null;
  content: string | null;
  records: ReturnType<typeof validateManualSignalRecords>;
}

export function loadManualInput(args: CollectArgs, deps: FileSystemDeps = defaultDeps): LoadedManualInput {
  if (!args.manualInput) {
    return { filename: null, content: null, records: [] };
  }

  const content = deps.readFile(args.manualInput);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new ManualInputValidationError(`Failed to parse "${args.manualInput}" as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rawRecords = parseManualInputDocument(parsed);
  const records = validateManualSignalRecords(rawRecords);

  return { filename: args.manualInput, content, records };
}

// ---------------------------------------------------------------------------
// Output paths
// ---------------------------------------------------------------------------

export function resolvePreviewPath(period: DateRange, overwrite: boolean, exists?: (path: string) => boolean, now?: Date): string {
  return resolveSnapshotPath(PROCESSED_DATA_DIR, "signal-mining-request", period, overwrite, exists, now);
}

export function resolveRunJsonPath(period: DateRange, overwrite: boolean, exists?: (path: string) => boolean, now?: Date): string {
  return resolveSnapshotPath(SIGNALS_DIR, "signal-mining", period, overwrite, exists, now);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type RunResult =
  | { mode: "dry-run"; previewPath: string; preview: SignalMiningDryRunPreview; notices: string[] }
  | { mode: "signals"; jsonPath: string; markdownPath: string; run: FinalSignalMiningRun; notices: string[] };

async function collectSourceRecords(
  summary: GrowthSummary,
  feedback: GrowthLoopFeedback | null,
  manualRecords: LoadedManualInput["records"],
  period: DateRange,
  now: string
): Promise<SignalSourceRecord[]> {
  const context = { period, campaign: summary.campaign, now };

  const analytics = await new NormalizedGrowthSummaryAdapter(summary).collect(context);
  const feedbackRecords = await new GrowthLoopFeedbackAdapter(feedback).collect(context);
  const manual = manualRecords.length > 0 ? await new ManualJsonSignalAdapter(manualRecords, summary.campaign.id).collect(context) : [];

  return [...analytics, ...feedbackRecords, ...manual];
}

export async function run(argv: string[], deps: FileSystemDeps = defaultDeps): Promise<RunResult> {
  const args = parseArgs(argv);
  const period: DateRange = { start: args.start as string, end: args.end as string };
  assertValidDateRange(period.start, period.end);

  const { filename: summaryFilename, content: summaryContent, summary, notice: summaryNotice } = loadGrowthSummary(args, period, deps);
  const { filename: feedbackFilename, content: feedbackContent, feedback, notice: feedbackNotice } = loadGrowthLoopFeedback(args, period, deps);
  const { filename: manualFilename, content: manualContent, records: manualRecords } = loadManualInput(args, deps);

  const notices = [summaryNotice, feedbackNotice].filter((n): n is string => n !== undefined);

  const now = new Date().toISOString();
  const sourceRecordCatalog = await collectSourceRecords(summary, feedback, manualRecords, period, now);
  const existingContentCatalog = buildExistingContentCatalog();
  const env = readProviderEnv();

  const provenance = {
    sourceSummaryFilename: summaryFilename,
    sourceSummarySha256: sha256(summaryContent),
    sourceFeedbackFilename: feedbackFilename ? basenameOnly(feedbackFilename) : null,
    sourceFeedbackSha256: feedbackContent ? sha256(feedbackContent) : null,
    manualInputFilename: manualFilename ? basenameOnly(manualFilename) : null,
    manualInputSha256: manualContent ? sha256(manualContent) : null,
  };

  if (args.dryRun) {
    const intendedProviderName = args.provider ?? env.provider ?? env.growthReportProvider ?? "not_configured";
    const intendedModel = env.model ?? env.growthReportModel;
    const feedbackContext = buildSignalMiningFeedbackContext(feedback);

    const request = buildSignalMiningLLMRequest({
      campaign: summary.campaign,
      period,
      language: args.language,
      sourceRecordCatalog,
      existingContentCatalog,
      feedbackContext,
      dataQualityWarnings: summary.dataQuality.warnings,
      maxTokens: env.maxTokens,
    });

    const preview: SignalMiningDryRunPreview = {
      source: "signal_mining_dry_run",
      createdAt: now,
      period,
      campaign: summary.campaign,
      sourceSummaryFilename: provenance.sourceSummaryFilename,
      sourceSummarySha256: provenance.sourceSummarySha256,
      sourceFeedbackFilename: provenance.sourceFeedbackFilename,
      sourceFeedbackSha256: provenance.sourceFeedbackSha256,
      manualInputFilename: provenance.manualInputFilename,
      manualInputSha256: provenance.manualInputSha256,
      sourceRecordCatalog,
      existingContentCatalog,
      feedbackContext,
      dataQualityWarnings: summary.dataQuality.warnings,
      language: args.language,
      intendedProvider: intendedProviderName,
      intendedModel: intendedModel ?? "not_configured",
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      responseSchemaDescription: request.responseSchemaDescription,
    };

    const previewPath = resolvePreviewPath(period, args.overwrite, deps.exists);
    writeFileAtomic(previewPath, `${JSON.stringify(preview, null, 2)}\n`);

    return { mode: "dry-run", previewPath, preview, notices };
  }

  if (sourceRecordCatalog.length === 0) {
    throw new SignalMiningInputError(
      "No usable source records were found from the Growth Summary, Growth Loop Feedback, or manual input for this period. " +
        "Add --manual-input, supply --feedback, or use --dry-run to inspect an empty fixture."
    );
  }

  const provider = resolveProvider(args, env);
  if (provider.name === "anthropic") {
    assertLiveMockFeedbackAllowed(feedback, args.allowMockInput);
  }

  const signalMiningRun = await runSignalMiningAgent({
    campaign: summary.campaign,
    period,
    language: args.language,
    maxTokens: env.maxTokens,
    maxSourceRecords: env.maxSourceRecords,
    provider,
    sourceRecordCatalog,
    existingContentCatalog,
    feedback,
    dataQualityWarnings: summary.dataQuality.warnings,
    dataQualityStatus: summary.dataQuality.overallStatus,
    provenance,
    generatedAt: now,
  });

  const jsonPath = resolveRunJsonPath(period, args.overwrite, deps.exists);
  const markdownPath = jsonPath.replace(/\.json$/, ".md");

  writeFileAtomic(jsonPath, `${JSON.stringify(signalMiningRun, null, 2)}\n`);
  writeFileAtomic(markdownPath, renderSignalMiningMarkdown(signalMiningRun));

  return { mode: "signals", jsonPath, markdownPath, run: signalMiningRun, notices };
}

async function main(): Promise<void> {
  try {
    const result = await run(process.argv.slice(2));

    for (const notice of result.notices) {
      console.log(`[growth:signals] ${notice}`);
    }

    if (result.mode === "dry-run") {
      console.log(`[growth:signals] Selected Growth Summary: ${result.preview.sourceSummaryFilename}`);
      console.log(`[growth:signals] Growth Loop Feedback: ${result.preview.sourceFeedbackFilename ?? "none"}`);
      console.log(`[growth:signals] Manual input: ${result.preview.manualInputFilename ?? "none"}`);
      console.log(`[growth:signals] Period: ${result.preview.period.start} to ${result.preview.period.end}`);
      console.log(`[growth:signals] Source records: ${result.preview.sourceRecordCatalog.length}`);
      console.log(`[growth:signals] Source types: ${[...new Set(result.preview.sourceRecordCatalog.map((r) => r.source.type))].length}`);
      console.log(`[growth:signals] Existing apps: ${result.preview.existingContentCatalog.length}`);
      console.log(`[growth:signals] Intended provider: ${result.preview.intendedProvider}`);
      console.log(`[growth:signals] Intended model: ${result.preview.intendedModel}`);
      console.log(`[growth:signals] Request preview written to: ${result.previewPath}`);
      console.log("[growth:signals] Dry run complete — no provider request was made.");
      return;
    }

    const { run: finalRun } = result;
    console.log(`[growth:signals] Selected Growth Summary: ${finalRun.provenance.sourceSummaryFilename}`);
    console.log(`[growth:signals] Growth Loop Feedback: ${finalRun.provenance.sourceFeedbackFilename ?? "none"}`);
    console.log(`[growth:signals] Manual input: ${finalRun.provenance.manualInputFilename ?? "none"}`);
    console.log(`[growth:signals] Provider: ${finalRun.generation.provider}${finalRun.generation.isMock ? " (mock)" : ""}`);
    console.log(`[growth:signals] Model: ${finalRun.generation.model}`);
    console.log(`[growth:signals] Source records collected: ${finalRun.sourceSummary.recordsCollected}`);
    console.log(`[growth:signals] Source records used: ${finalRun.sourceSummary.recordsUsed}`);
    console.log(`[growth:signals] Signal count: ${finalRun.signals.length}`);
    console.log(`[growth:signals] Topic candidate count: ${finalRun.topicPool.length}`);
    console.log(`[growth:signals] Duplicate count: ${finalRun.deduplication.duplicatesRemoved}`);
    console.log(`[growth:signals] Unresolved record count: ${finalRun.unresolvedSourceRecords.length}`);
    console.log(`[growth:signals] JSON output: ${result.jsonPath}`);
    console.log(`[growth:signals] Markdown output: ${result.markdownPath}`);
    console.log(`[growth:signals] Human review required: ${finalRun.humanReview.required ? "yes" : "no"}`);
    console.log(`[growth:signals] Warnings: ${finalRun.dataQuality.warnings.length}`);
    const { inputTokens, outputTokens } = finalRun.generation.usage;
    if (inputTokens !== null || outputTokens !== null) {
      console.log(`[growth:signals] Token usage: input=${inputTokens ?? "unavailable"}, output=${outputTokens ?? "unavailable"}`);
    }
  } catch (err) {
    if (
      err instanceof SignalMiningDateRangeError ||
      err instanceof SignalMiningInputError ||
      err instanceof SignalMiningConfigError ||
      err instanceof SignalMiningValidationError ||
      err instanceof ManualInputValidationError ||
      err instanceof GrowthLoopFeedbackValidationError ||
      err instanceof LLMProviderConfigError ||
      err instanceof LLMProviderResponseError
    ) {
      console.error(`[growth:signals] ${err.message}`);
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[growth:signals] Unexpected error: ${reason}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
