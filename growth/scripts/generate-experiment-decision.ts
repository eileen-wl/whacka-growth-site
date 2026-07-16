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
import {
  ExperimentDecisionValidationError,
  buildExperimentDecisionContext,
  runExperimentDecisionAgent,
} from "../agents/experiment-decision-agent";
import { buildExperimentDecisionLLMRequest } from "../prompts/experiment-decision-prompt";
import { renderExperimentDecisionMarkdown } from "../renderers/experiment-decision-markdown";
import { AnthropicExperimentDecisionProvider } from "../llm/anthropic-experiment-decision-provider";
import { MockExperimentDecisionProvider } from "../llm/mock-experiment-decision-provider";
import { LLMProviderConfigError, LLMProviderResponseError } from "../llm/provider";
import type { ExperimentDecisionProvider } from "../llm/experiment-decision-provider";
import type { DateRange } from "../types/growth-summary";
import type { FinalGrowthReport } from "../types/growth-report";
import type { DryRunDecisionRequestPreview, FinalExperimentDecision } from "../types/experiment-decision";
import type { SupportedLanguage } from "../types/llm";

const GROWTH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROCESSED_DATA_DIR = join(GROWTH_DIR, "data", "processed");
const REPORTS_DIR = join(GROWTH_DIR, "reports");
const DECISIONS_DIR = join(GROWTH_DIR, "decisions");

const DEFAULT_MAX_TOKENS = 6000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class ExperimentDecisionDateRangeError extends Error {}
export class ExperimentDecisionInputError extends Error {}
export class ExperimentDecisionConfigError extends Error {}

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
    throw new Error("growth:decide requires --start and --end (ISO YYYY-MM-DD), even when --input is given.");
  }

  return args;
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Throws ExperimentDecisionDateRangeError if either date isn't ISO YYYY-MM-DD, or start is after end. */
export function assertValidDateRange(start: string, end: string): void {
  if (!isValidIsoDate(start)) {
    throw new ExperimentDecisionDateRangeError(`Invalid --start date "${start}". Use ISO format YYYY-MM-DD.`);
  }
  if (!isValidIsoDate(end)) {
    throw new ExperimentDecisionDateRangeError(`Invalid --end date "${end}". Use ISO format YYYY-MM-DD.`);
  }
  if (start > end) {
    throw new ExperimentDecisionDateRangeError(`--start (${start}) must not be after --end (${end}).`);
  }
}

// ---------------------------------------------------------------------------
// Environment: provider/model resolution falls back to the Growth Report
// Agent's own variables, so both agents use the same Anthropic provider and
// model by default while still allowing a separate decision model later.
// ---------------------------------------------------------------------------

export interface ProviderEnvConfig {
  provider: string | undefined;
  model: string | undefined;
  maxTokens: number;
  apiKey: string | undefined;
  growthReportProvider: string | undefined;
  growthReportModel: string | undefined;
}

export function readProviderEnv(source: NodeJS.ProcessEnv = process.env): ProviderEnvConfig {
  const rawMaxTokens = source.EXPERIMENT_DECISION_MAX_TOKENS ? Number(source.EXPERIMENT_DECISION_MAX_TOKENS) : NaN;
  const maxTokens = Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? rawMaxTokens : DEFAULT_MAX_TOKENS;

  return {
    provider: source.EXPERIMENT_DECISION_LLM_PROVIDER,
    model: source.EXPERIMENT_DECISION_MODEL,
    maxTokens,
    apiKey: source.ANTHROPIC_API_KEY,
    growthReportProvider: source.GROWTH_REPORT_LLM_PROVIDER,
    growthReportModel: source.GROWTH_REPORT_MODEL,
  };
}

/** Resolves the live provider. Never called in --dry-run mode, so dry-run never requires any of this. */
export function resolveProvider(args: CollectArgs, env: ProviderEnvConfig): ExperimentDecisionProvider {
  const providerName = args.provider ?? env.provider ?? env.growthReportProvider;

  if (!providerName) {
    throw new ExperimentDecisionConfigError(
      "No LLM provider configured. Pass --provider mock for local testing, or set EXPERIMENT_DECISION_LLM_PROVIDER " +
        '(or GROWTH_REPORT_LLM_PROVIDER) to "anthropic" (plus a resolved model and ANTHROPIC_API_KEY) in .env for a live run.'
    );
  }

  if (providerName === "mock") {
    return new MockExperimentDecisionProvider();
  }

  if (providerName === "anthropic") {
    const model = env.model ?? env.growthReportModel;
    if (!env.apiKey) {
      throw new ExperimentDecisionConfigError(
        "ANTHROPIC_API_KEY is required for a live Anthropic run. Set it in .env, or use --provider mock / --dry-run instead."
      );
    }
    if (!model) {
      throw new ExperimentDecisionConfigError(
        "No Anthropic model resolved (checked EXPERIMENT_DECISION_MODEL, then GROWTH_REPORT_MODEL). Set one in .env once a model is confirmed."
      );
    }
    return new AnthropicExperimentDecisionProvider({ apiKey: env.apiKey, model });
  }

  throw new ExperimentDecisionConfigError(`Unknown provider "${providerName}". Supported values: "mock", "anthropic".`);
}

// ---------------------------------------------------------------------------
// Input discovery: final Growth Report JSON only — never the Markdown file,
// never normalized growth-summary or raw platform snapshots.
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

function isValidGrowthReport(value: unknown): value is FinalGrowthReport {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== "1.0.0" || v.reportType !== "growth_report") return false;
  if (typeof v.generatedAt !== "string") return false;

  const period = v.period as Record<string, unknown> | undefined;
  if (!period || typeof period.start !== "string" || typeof period.end !== "string") return false;

  const campaign = v.campaign as Record<string, unknown> | undefined;
  if (!campaign || typeof campaign.id !== "string" || typeof campaign.name !== "string") return false;

  const provenance = v.provenance as Record<string, unknown> | undefined;
  if (!provenance || typeof provenance.sourceSummaryFilename !== "string" || typeof provenance.sourceSummarySha256 !== "string") return false;

  const generation = v.generation as Record<string, unknown> | undefined;
  if (!generation || typeof generation.provider !== "string" || typeof generation.model !== "string" || typeof generation.isMock !== "boolean") {
    return false;
  }

  if (typeof v.metrics !== "object" || v.metrics === null) return false;
  if (!Array.isArray(v.evidenceCatalog)) return false;
  if (typeof v.analysis !== "object" || v.analysis === null) return false;

  const dataQuality = v.dataQuality as Record<string, unknown> | undefined;
  const status = dataQuality?.overallStatus;
  if (status !== "complete" && status !== "partial" && status !== "invalid") return false;

  return true;
}

function collectGrowthReportEvidenceRefs(analysis: FinalGrowthReport["analysis"]): string[] {
  const refs: string[] = [];
  for (const f of analysis.findings) refs.push(...f.evidenceRefs);
  for (const f of analysis.funnelObservations) refs.push(...f.evidenceRefs);
  for (const c of analysis.channelAndContentObservations) refs.push(...c.evidenceRefs);
  for (const a of analysis.anomaliesOrNotableSignals) refs.push(...a.evidenceRefs);
  for (const d of analysis.dataLimitations) refs.push(...d.relatedEvidenceRefs);
  for (const s of analysis.decisionInputs.signalsWorthReviewing) refs.push(...s.evidenceRefs);
  for (const q of analysis.decisionInputs.questionsForDecisionAgent) refs.push(...q.evidenceRefs);
  return refs;
}

function assertValidEvidenceReferences(report: FinalGrowthReport, filename: string): void {
  const catalogIds = new Set(report.evidenceCatalog.map((entry) => entry.id));
  const unknown = [...new Set(collectGrowthReportEvidenceRefs(report.analysis).filter((id) => !catalogIds.has(id)))];
  if (unknown.length > 0) {
    throw new ExperimentDecisionInputError(`"${filename}" contains evidenceRefs not present in its own evidenceCatalog: ${unknown.join(", ")}.`);
  }
}

function parseAndValidateGrowthReport(content: string, filename: string): FinalGrowthReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new ExperimentDecisionInputError(`Failed to parse "${filename}" as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isValidGrowthReport(parsed)) {
    throw new ExperimentDecisionInputError(`"${filename}" does not match the expected Growth Report schema (reportType must be "growth_report").`);
  }

  if (parsed.dataQuality.overallStatus === "invalid") {
    throw new ExperimentDecisionInputError(
      `"${filename}" has dataQuality.overallStatus = "invalid"; the Experiment Decision Agent refuses to decide from it. ` +
        'A "partial" status is accepted.'
    );
  }

  assertValidEvidenceReferences(parsed, filename);

  return parsed;
}

function assertPeriodMatches(reportPeriod: DateRange, requestedPeriod: DateRange): void {
  try {
    assertPeriodMatchesShared("Growth Report", reportPeriod, requestedPeriod);
  } catch (err) {
    if (err instanceof PeriodMismatchError) throw new ExperimentDecisionInputError(err.message);
    throw err;
  }
}

export interface LoadedGrowthReport {
  filename: string;
  content: string;
  report: FinalGrowthReport;
  notice?: string;
}

/**
 * Loads the Growth Report for `period`: either exactly `args.input`, or the
 * latest-generatedAt discovered `growth-report-*.json` match. The shared
 * discovery regex requires a `.json` suffix, so the sibling `.md` brief is
 * never a candidate. Never reads normalized growth-summary or raw
 * PostHog/GA4/Search Console files.
 */
export function loadGrowthReport(args: CollectArgs, period: DateRange, deps: FileSystemDeps = defaultDeps): LoadedGrowthReport {
  if (args.input) {
    const content = deps.readFile(args.input);
    const report = parseAndValidateGrowthReport(content, args.input);
    assertPeriodMatches(report.period, period);
    return { filename: args.input, content, report };
  }

  const matches = findMatchingFilesShared(REPORTS_DIR, "growth-report", period, deps.listDir);
  if (matches.length === 0) {
    throw new ExperimentDecisionInputError(
      `No Growth Report found for ${period.start} to ${period.end}. Expected a file matching ` +
        `growth/reports/growth-report-${period.start}_to_${period.end}*.json — run growth:report for this range first.`
    );
  }

  let selected: { filename: string; snapshot: { generatedAt: string } } | undefined;
  try {
    selected = selectLatestSnapshotShared<{ generatedAt: string }>(REPORTS_DIR, matches, deps.readFile, (s) => s.generatedAt);
  } catch (err) {
    throw new ExperimentDecisionInputError(
      `Failed to parse a matching Growth Report for ${period.start} to ${period.end} as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!selected) {
    throw new ExperimentDecisionInputError(`Failed to read any matching Growth Report for ${period.start} to ${period.end}.`);
  }

  const content = deps.readFile(join(REPORTS_DIR, selected.filename));
  const report = parseAndValidateGrowthReport(content, selected.filename);
  assertPeriodMatches(report.period, period);

  const notice = matches.length > 1 ? multipleMatchesNoticeShared("Growth Report", selected.filename) : undefined;

  return { filename: selected.filename, content, report, notice };
}

/**
 * Live Anthropic execution refuses a mock-generated Growth Report by
 * default — never called for --dry-run or --provider mock, which may
 * consume either. `--allow-mock-input` opts in explicitly, for testing.
 */
export function assertLiveMockInputAllowed(report: FinalGrowthReport, filename: string, allowMockInput: boolean): void {
  if (report.generation.isMock && !allowMockInput) {
    throw new ExperimentDecisionConfigError(
      `The selected Growth Report ("${filename}") was mock-generated (generation.isMock = true). Live Anthropic execution ` +
        "refuses to decide from a mock report by default — pass --allow-mock-input to override for explicit testing."
    );
  }
}

// ---------------------------------------------------------------------------
// Dry-run preview
// ---------------------------------------------------------------------------

export function resolvePreviewPath(period: DateRange, overwrite: boolean, exists?: (path: string) => boolean, now?: Date): string {
  return resolveSnapshotPath(PROCESSED_DATA_DIR, "experiment-decision-request", period, overwrite, exists, now);
}

export function resolveDecisionJsonPath(period: DateRange, overwrite: boolean, exists?: (path: string) => boolean, now?: Date): string {
  return resolveSnapshotPath(DECISIONS_DIR, "experiment-decision", period, overwrite, exists, now);
}

export interface BuildDryRunPreviewParams {
  report: FinalGrowthReport;
  reportFilename: string;
  reportContent: string;
  language: SupportedLanguage;
  intendedProvider: string;
  intendedModel: string | undefined;
  maxTokens: number;
  createdAt?: string;
}

/** Pure: builds the dry-run preview object (never writes it). Never includes API keys/tokens/credential paths. */
export function buildDryRunPreview(params: BuildDryRunPreviewParams): DryRunDecisionRequestPreview {
  const context = buildExperimentDecisionContext(params.report, params.reportFilename, sha256(params.reportContent));
  const request = buildExperimentDecisionLLMRequest({ context, language: params.language, maxTokens: params.maxTokens });

  return {
    source: "experiment_decision_dry_run",
    createdAt: params.createdAt ?? new Date().toISOString(),
    sourceGrowthReportFilename: params.reportFilename,
    sourceGrowthReportSha256: context.sourceReportSha256,
    sourceGrowthReportIsMock: context.sourceReportIsMock,
    period: context.period,
    campaign: context.campaign,
    language: params.language,
    intendedProvider: params.intendedProvider,
    intendedModel: params.intendedModel ?? "not_configured",
    decisionScope: context.decisionScope,
    evidenceCatalog: context.evidenceCatalog,
    findingCatalog: context.findingCatalog,
    limitationCatalog: context.limitationCatalog,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    responseSchemaDescription: request.responseSchemaDescription,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type RunResult =
  | {
      mode: "dry-run";
      previewPath: string;
      preview: DryRunDecisionRequestPreview;
      dataQualityStatus: FinalGrowthReport["dataQuality"]["overallStatus"];
      notices: string[];
    }
  | { mode: "decision"; jsonPath: string; markdownPath: string; decision: FinalExperimentDecision; notices: string[] };

export async function run(argv: string[], deps: FileSystemDeps = defaultDeps): Promise<RunResult> {
  const args = parseArgs(argv);
  const period: DateRange = { start: args.start as string, end: args.end as string };
  assertValidDateRange(period.start, period.end);

  const { filename, content, report, notice } = loadGrowthReport(args, period, deps);
  const notices = notice ? [notice] : [];

  const env = readProviderEnv();

  if (args.dryRun) {
    const intendedProviderName = args.provider ?? env.provider ?? env.growthReportProvider ?? "not_configured";
    const intendedModel = env.model ?? env.growthReportModel;

    const preview = buildDryRunPreview({
      report,
      reportFilename: filename,
      reportContent: content,
      language: args.language,
      intendedProvider: intendedProviderName,
      intendedModel,
      maxTokens: env.maxTokens,
    });

    const previewPath = resolvePreviewPath(period, args.overwrite, deps.exists);
    writeFileAtomic(previewPath, `${JSON.stringify(preview, null, 2)}\n`);

    return { mode: "dry-run", previewPath, preview, dataQualityStatus: report.dataQuality.overallStatus, notices };
  }

  const provider = resolveProvider(args, env);
  if (provider.name === "anthropic") {
    assertLiveMockInputAllowed(report, filename, args.allowMockInput);
  }

  const decision = await runExperimentDecisionAgent({
    report,
    sourceReportFilename: filename,
    sourceReportSha256: sha256(content),
    language: args.language,
    maxTokens: env.maxTokens,
    provider,
  });

  const jsonPath = resolveDecisionJsonPath(period, args.overwrite, deps.exists);
  const markdownPath = jsonPath.replace(/\.json$/, ".md");

  writeFileAtomic(jsonPath, `${JSON.stringify(decision, null, 2)}\n`);
  writeFileAtomic(markdownPath, renderExperimentDecisionMarkdown(decision));

  return { mode: "decision", jsonPath, markdownPath, decision, notices };
}

async function main(): Promise<void> {
  try {
    const result = await run(process.argv.slice(2));

    for (const notice of result.notices) {
      console.log(`[growth:decide] ${notice}`);
    }

    if (result.mode === "dry-run") {
      console.log(`[growth:decide] Selected Growth Report: ${result.preview.sourceGrowthReportFilename}`);
      console.log(`[growth:decide] Period: ${result.preview.period.start} to ${result.preview.period.end}`);
      console.log(`[growth:decide] Source report mock: ${result.preview.sourceGrowthReportIsMock ? "yes" : "no"}`);
      console.log(`[growth:decide] Data quality: ${result.dataQualityStatus}`);
      console.log(`[growth:decide] Evidence items: ${result.preview.evidenceCatalog.length}`);
      console.log(`[growth:decide] Finding items: ${result.preview.findingCatalog.length}`);
      console.log(`[growth:decide] Limitation items: ${result.preview.limitationCatalog.length}`);
      console.log(`[growth:decide] Available topics: ${result.preview.decisionScope.availableTopics.length}`);
      console.log(`[growth:decide] Available CTA types: ${result.preview.decisionScope.availableCtaTypes.length}`);
      console.log(`[growth:decide] Available channels: ${result.preview.decisionScope.availableChannels.length}`);
      console.log(`[growth:decide] Intended provider: ${result.preview.intendedProvider}`);
      console.log(`[growth:decide] Intended model: ${result.preview.intendedModel}`);
      console.log(`[growth:decide] Request preview written to: ${result.previewPath}`);
      console.log("[growth:decide] Dry run complete — no provider request was made.");
      return;
    }

    const { decision } = result;
    console.log(`[growth:decide] Selected Growth Report: ${decision.provenance.sourceGrowthReportFilename}`);
    console.log(`[growth:decide] Period: ${decision.period.start} to ${decision.period.end}`);
    console.log(`[growth:decide] Source report mock: ${decision.provenance.sourceGrowthReportIsMock ? "yes" : "no"}`);
    console.log(`[growth:decide] Provider: ${decision.generation.provider}${decision.generation.isMock ? " (mock)" : ""}`);
    console.log(`[growth:decide] Model: ${decision.generation.model}`);
    console.log(`[growth:decide] Decision status: ${decision.decision.decisionSummary.decisionStatus}`);
    console.log(`[growth:decide] Confidence: ${decision.decision.decisionSummary.confidence}`);
    console.log(
      `[growth:decide] Recommended experiment: ${decision.decision.recommendedExperiment ? decision.decision.recommendedExperiment.objective : "Decision deferred"}`
    );
    console.log(`[growth:decide] Ranked options: ${decision.decision.rankedExperimentOptions.length}`);
    console.log(`[growth:decide] Evidence items: ${decision.evidenceCatalog.length}`);
    console.log(`[growth:decide] JSON output: ${result.jsonPath}`);
    console.log(`[growth:decide] Markdown output: ${result.markdownPath}`);
    const { inputTokens, outputTokens } = decision.generation.usage;
    if (inputTokens !== null || outputTokens !== null) {
      console.log(`[growth:decide] Token usage: input=${inputTokens ?? "unavailable"}, output=${outputTokens ?? "unavailable"}`);
    }
    console.log(`[growth:decide] Human review required: ${decision.humanReview.required ? "yes" : "no"}`);
    console.log(`[growth:decide] Warnings: ${decision.dataQuality.warnings.length}`);
  } catch (err) {
    if (
      err instanceof ExperimentDecisionDateRangeError ||
      err instanceof ExperimentDecisionInputError ||
      err instanceof ExperimentDecisionConfigError ||
      err instanceof ExperimentDecisionValidationError ||
      err instanceof LLMProviderConfigError ||
      err instanceof LLMProviderResponseError
    ) {
      console.error(`[growth:decide] ${err.message}`);
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[growth:decide] Unexpected error: ${reason}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
