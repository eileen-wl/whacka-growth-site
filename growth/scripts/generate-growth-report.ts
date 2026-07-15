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
import { GrowthReportValidationError, buildEvidenceCatalog, runGrowthReportAgent } from "../agents/growth-report-agent";
import { buildGrowthReportLLMRequest } from "../prompts/growth-report-prompt";
import { renderGrowthReportMarkdown } from "../renderers/growth-report-markdown";
import { AnthropicGrowthReportProvider } from "../llm/anthropic-provider";
import { MockGrowthReportProvider } from "../llm/mock-provider";
import { LLMProviderConfigError, LLMProviderResponseError } from "../llm/provider";
import type { LLMProvider } from "../llm/provider";
import type { DataQuality, DateRange, GrowthSummary } from "../types/growth-summary";
import type { DryRunRequestPreview, FinalGrowthReport, SupportedLanguage } from "../types/growth-report";

const GROWTH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROCESSED_DATA_DIR = join(GROWTH_DIR, "data", "processed");
const REPORTS_DIR = join(GROWTH_DIR, "reports");

const DEFAULT_MAX_TOKENS = 6000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class GrowthReportDateRangeError extends Error {}
export class GrowthReportInputError extends Error {}
export class GrowthReportConfigError extends Error {}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export interface CollectArgs {
  start?: string;
  end?: string;
  input?: string;
  language: SupportedLanguage;
  provider?: string;
  overwrite: boolean;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CollectArgs {
  const args: CollectArgs = { language: "en", overwrite: false, dryRun: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--start") {
      args.start = argv[++i];
    } else if (arg === "--end") {
      args.end = argv[++i];
    } else if (arg === "--input") {
      args.input = argv[++i];
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
    throw new Error("growth:report requires --start and --end (ISO YYYY-MM-DD), even when --input is given.");
  }

  return args;
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Throws GrowthReportDateRangeError if either date isn't ISO YYYY-MM-DD, or start is after end. */
export function assertValidDateRange(start: string, end: string): void {
  if (!isValidIsoDate(start)) {
    throw new GrowthReportDateRangeError(`Invalid --start date "${start}". Use ISO format YYYY-MM-DD.`);
  }
  if (!isValidIsoDate(end)) {
    throw new GrowthReportDateRangeError(`Invalid --end date "${end}". Use ISO format YYYY-MM-DD.`);
  }
  if (start > end) {
    throw new GrowthReportDateRangeError(`--start (${start}) must not be after --end (${end}).`);
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface ProviderEnvConfig {
  provider: string | undefined;
  model: string | undefined;
  maxTokens: number;
  apiKey: string | undefined;
}

export function readProviderEnv(source: NodeJS.ProcessEnv = process.env): ProviderEnvConfig {
  const rawMaxTokens = source.GROWTH_REPORT_MAX_TOKENS ? Number(source.GROWTH_REPORT_MAX_TOKENS) : NaN;
  const maxTokens = Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? rawMaxTokens : DEFAULT_MAX_TOKENS;

  return {
    provider: source.GROWTH_REPORT_LLM_PROVIDER,
    model: source.GROWTH_REPORT_MODEL,
    maxTokens,
    apiKey: source.ANTHROPIC_API_KEY,
  };
}

/** Resolves the live provider. Never called in --dry-run mode, so dry-run never requires any of this. */
export function resolveProvider(args: CollectArgs, env: ProviderEnvConfig): LLMProvider {
  const providerName = args.provider ?? env.provider;

  if (!providerName) {
    throw new GrowthReportConfigError(
      "No LLM provider configured. Pass --provider mock for local testing, or set GROWTH_REPORT_LLM_PROVIDER=anthropic " +
        "(plus GROWTH_REPORT_MODEL and ANTHROPIC_API_KEY) in .env for a live run."
    );
  }

  if (providerName === "mock") {
    return new MockGrowthReportProvider();
  }

  if (providerName === "anthropic") {
    if (!env.apiKey) {
      throw new GrowthReportConfigError(
        "ANTHROPIC_API_KEY is required for a live Anthropic run. Set it in .env, or use --provider mock / --dry-run instead."
      );
    }
    if (!env.model) {
      throw new GrowthReportConfigError("GROWTH_REPORT_MODEL is required for a live Anthropic run. Set it in .env once the model is confirmed.");
    }
    return new AnthropicGrowthReportProvider({ apiKey: env.apiKey, model: env.model });
  }

  throw new GrowthReportConfigError(`Unknown GROWTH_REPORT_LLM_PROVIDER "${providerName}". Supported values: "mock", "anthropic".`);
}

// ---------------------------------------------------------------------------
// Input discovery: normalized growth-summary snapshot
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

function isValidGrowthSummary(value: unknown): value is GrowthSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== "1.0.0" || v.source !== "normalized_growth_summary") return false;
  if (typeof v.generatedAt !== "string") return false;

  const period = v.period as Record<string, unknown> | undefined;
  if (!period || typeof period.start !== "string" || typeof period.end !== "string") return false;

  const campaign = v.campaign as Record<string, unknown> | undefined;
  if (!campaign || typeof campaign.id !== "string" || typeof campaign.name !== "string") return false;

  if (typeof v.inputs !== "object" || v.inputs === null) return false;
  if (typeof v.traffic !== "object" || v.traffic === null) return false;
  if (typeof v.behavior !== "object" || v.behavior === null) return false;
  if (typeof v.search !== "object" || v.search === null) return false;
  if (typeof v.funnel !== "object" || v.funnel === null) return false;
  if (typeof v.productConversions !== "object" || v.productConversions === null) return false;

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
    throw new GrowthReportInputError(`Failed to parse "${filename}" as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isValidGrowthSummary(parsed)) {
    throw new GrowthReportInputError(`"${filename}" does not match the expected normalized growth-summary schema.`);
  }

  if (parsed.dataQuality.overallStatus === "invalid") {
    throw new GrowthReportInputError(
      `"${filename}" has dataQuality.overallStatus = "invalid" (its inputs' periods didn't match each other); ` +
        "the Growth Report Agent refuses to report on it. A \"partial\" status is accepted."
    );
  }

  return parsed;
}

function assertPeriodMatches(summaryPeriod: DateRange, requestedPeriod: DateRange): void {
  try {
    assertPeriodMatchesShared("Growth summary", summaryPeriod, requestedPeriod);
  } catch (err) {
    if (err instanceof PeriodMismatchError) throw new GrowthReportInputError(err.message);
    throw err;
  }
}

export interface LoadedGrowthSummary {
  filename: string;
  content: string;
  summary: GrowthSummary;
  notice?: string;
}

/** Loads the normalized growth summary for `period`: either exactly `args.input`, or the latest-generatedAt discovered match. Never reads raw PostHog/GA4/Search Console files. */
export function loadGrowthSummary(args: CollectArgs, period: DateRange, deps: FileSystemDeps = defaultDeps): LoadedGrowthSummary {
  if (args.input) {
    const content = deps.readFile(args.input);
    const summary = parseAndValidateGrowthSummary(content, args.input);
    assertPeriodMatches(summary.period, period);
    return { filename: args.input, content, summary };
  }

  const matches = findMatchingFilesShared(PROCESSED_DATA_DIR, "growth-summary", period, deps.listDir);
  if (matches.length === 0) {
    throw new GrowthReportInputError(
      `No normalized growth summary found for ${period.start} to ${period.end}. Expected a file matching ` +
        `growth/data/processed/growth-summary-${period.start}_to_${period.end}*.json — run growth:normalize for this range first.`
    );
  }

  let selected: { filename: string; snapshot: { generatedAt: string } } | undefined;
  try {
    selected = selectLatestSnapshotShared<{ generatedAt: string }>(PROCESSED_DATA_DIR, matches, deps.readFile, (s) => s.generatedAt);
  } catch (err) {
    throw new GrowthReportInputError(
      `Failed to parse a matching growth summary for ${period.start} to ${period.end} as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!selected) {
    throw new GrowthReportInputError(`Failed to read any matching growth summary for ${period.start} to ${period.end}.`);
  }

  const content = deps.readFile(join(PROCESSED_DATA_DIR, selected.filename));
  const summary = parseAndValidateGrowthSummary(content, selected.filename);
  assertPeriodMatches(summary.period, period);

  const notice = matches.length > 1 ? multipleMatchesNoticeShared("growth summary", selected.filename) : undefined;

  return { filename: selected.filename, content, summary, notice };
}

// ---------------------------------------------------------------------------
// Dry-run preview
// ---------------------------------------------------------------------------

export function resolvePreviewPath(period: DateRange, overwrite: boolean, exists?: (path: string) => boolean, now?: Date): string {
  return resolveSnapshotPath(PROCESSED_DATA_DIR, "growth-report-request", period, overwrite, exists, now);
}

export function resolveReportJsonPath(period: DateRange, overwrite: boolean, exists?: (path: string) => boolean, now?: Date): string {
  return resolveSnapshotPath(REPORTS_DIR, "growth-report", period, overwrite, exists, now);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type RunResult =
  | { mode: "dry-run"; previewPath: string; preview: DryRunRequestPreview; dataQualityStatus: DataQuality["overallStatus"]; notices: string[] }
  | { mode: "report"; jsonPath: string; markdownPath: string; report: FinalGrowthReport; notices: string[] };

export interface BuildDryRunPreviewParams {
  summary: GrowthSummary;
  summaryFilename: string;
  summaryContent: string;
  language: SupportedLanguage;
  intendedProvider: string;
  intendedModel: string | undefined;
  maxTokens: number;
  createdAt?: string;
}

/** Pure: builds the dry-run preview object (never writes it). Never includes API keys/tokens/credential paths — only the rendered prompts, evidence catalog, and provenance. */
export function buildDryRunPreview(params: BuildDryRunPreviewParams): DryRunRequestPreview {
  const evidenceCatalog = buildEvidenceCatalog(params.summary);

  const request = buildGrowthReportLLMRequest({
    period: params.summary.period,
    campaign: params.summary.campaign,
    language: params.language,
    evidenceCatalog,
    dataQualityWarnings: params.summary.dataQuality.warnings,
    measurementNotes: params.summary.dataQuality.measurementNotes,
    maxTokens: params.maxTokens,
  });

  return {
    source: "growth_report_dry_run",
    createdAt: params.createdAt ?? new Date().toISOString(),
    sourceSummaryFilename: params.summaryFilename,
    sourceSummarySha256: sha256(params.summaryContent),
    period: params.summary.period,
    campaign: params.summary.campaign,
    language: params.language,
    intendedProvider: params.intendedProvider,
    intendedModel: params.intendedModel ?? "not_configured",
    evidenceCatalog,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    responseSchemaDescription: request.responseSchemaDescription,
  };
}

export async function run(argv: string[], deps: FileSystemDeps = defaultDeps): Promise<RunResult> {
  const args = parseArgs(argv);
  const period: DateRange = { start: args.start as string, end: args.end as string };
  assertValidDateRange(period.start, period.end);

  const { filename, content, summary, notice } = loadGrowthSummary(args, period, deps);
  const notices = notice ? [notice] : [];

  const env = readProviderEnv();

  if (args.dryRun) {
    const preview = buildDryRunPreview({
      summary,
      summaryFilename: filename,
      summaryContent: content,
      language: args.language,
      intendedProvider: args.provider ?? env.provider ?? "not_configured",
      intendedModel: env.model,
      maxTokens: env.maxTokens,
    });

    const previewPath = resolvePreviewPath(period, args.overwrite, deps.exists);
    writeFileAtomic(previewPath, `${JSON.stringify(preview, null, 2)}\n`);

    return { mode: "dry-run", previewPath, preview, dataQualityStatus: summary.dataQuality.overallStatus, notices };
  }

  const provider = resolveProvider(args, env);

  const report = await runGrowthReportAgent({
    summary,
    sourceSummaryFilename: filename,
    sourceSummarySha256: sha256(content),
    language: args.language,
    maxTokens: env.maxTokens,
    provider,
  });

  const jsonPath = resolveReportJsonPath(period, args.overwrite, deps.exists);
  const markdownPath = jsonPath.replace(/\.json$/, ".md");

  writeFileAtomic(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileAtomic(markdownPath, renderGrowthReportMarkdown(report));

  return { mode: "report", jsonPath, markdownPath, report, notices };
}

async function main(): Promise<void> {
  try {
    const result = await run(process.argv.slice(2));

    for (const notice of result.notices) {
      console.log(`[growth:report] ${notice}`);
    }

    if (result.mode === "dry-run") {
      console.log(`[growth:report] Selected input: ${result.preview.sourceSummaryFilename}`);
      console.log(`[growth:report] Period: ${result.preview.period.start} to ${result.preview.period.end}`);
      console.log(`[growth:report] Evidence items: ${result.preview.evidenceCatalog.length}`);
      console.log(`[growth:report] Data quality: ${result.dataQualityStatus}`);
      console.log(`[growth:report] Intended provider: ${result.preview.intendedProvider}`);
      console.log(`[growth:report] Intended model: ${result.preview.intendedModel}`);
      console.log(`[growth:report] Request preview written to: ${result.previewPath}`);
      console.log("[growth:report] Dry run complete — no API request was made.");
      return;
    }

    console.log(`[growth:report] Selected input: ${result.report.provenance.sourceSummaryFilename}`);
    console.log(`[growth:report] Period: ${result.report.period.start} to ${result.report.period.end}`);
    console.log(`[growth:report] Provider: ${result.report.generation.provider}${result.report.generation.isMock ? " (mock)" : ""}`);
    console.log(`[growth:report] Model: ${result.report.generation.model}`);
    console.log(`[growth:report] Data quality: ${result.report.dataQuality.overallStatus}`);
    console.log(`[growth:report] Findings: ${result.report.analysis.findings.length}`);
    console.log(`[growth:report] Evidence items: ${result.report.evidenceCatalog.length}`);
    console.log(`[growth:report] JSON output: ${result.jsonPath}`);
    console.log(`[growth:report] Markdown output: ${result.markdownPath}`);
    const { inputTokens, outputTokens } = result.report.generation.usage;
    if (inputTokens !== null || outputTokens !== null) {
      console.log(`[growth:report] Token usage: input=${inputTokens ?? "unavailable"}, output=${outputTokens ?? "unavailable"}`);
    }
    console.log(`[growth:report] Warnings: ${result.report.dataQuality.warnings.length}`);
  } catch (err) {
    if (
      err instanceof GrowthReportDateRangeError ||
      err instanceof GrowthReportInputError ||
      err instanceof GrowthReportConfigError ||
      err instanceof GrowthReportValidationError ||
      err instanceof LLMProviderConfigError ||
      err instanceof LLMProviderResponseError
    ) {
      console.error(`[growth:report] ${err.message}`);
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[growth:report] Unexpected error: ${reason}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
