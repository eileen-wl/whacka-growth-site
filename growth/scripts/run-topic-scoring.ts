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
import { TopicScoringValidationError, buildTopicScoringContexts, runTopicScoringAgent } from "../agents/topic-scoring-agent";
import { buildTopicScoringLLMRequest } from "../prompts/topic-scoring-prompt";
import { buildTopicScoringProfileSummary, getTopicScoringProfile } from "../scoring/topic-scoring-profile";
import { renderTopicScoringMarkdown } from "../renderers/topic-scoring-markdown";
import { AnthropicTopicScoringProvider } from "../llm/anthropic-topic-scoring-provider";
import { MockTopicScoringProvider } from "../llm/mock-topic-scoring-provider";
import { LLMProviderConfigError, LLMProviderResponseError } from "../llm/topic-scoring-provider";
import type { TopicScoringProvider } from "../llm/topic-scoring-provider";
import type { DateRange } from "../types/growth-summary";
import type { FinalSignalMiningRun } from "../types/signal-mining";
import type { SupportedLanguage } from "../types/llm";
import type { FinalTopicScoringRun, TopicScoringDryRunPreview } from "../types/topic-scoring";

const GROWTH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROCESSED_DATA_DIR = join(GROWTH_DIR, "data", "processed");
const SIGNALS_DIR = join(GROWTH_DIR, "signals");
const SCORES_DIR = join(GROWTH_DIR, "scores");

const DEFAULT_MAX_TOKENS = 8000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class TopicScoringDateRangeError extends Error {}
export class TopicScoringInputError extends Error {}
export class TopicScoringConfigError extends Error {}

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
    throw new Error("growth:score-topics requires --start and --end (ISO YYYY-MM-DD), even when --input is given.");
  }

  return args;
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Throws TopicScoringDateRangeError if either date isn't ISO YYYY-MM-DD, or start is after end. */
export function assertValidDateRange(start: string, end: string): void {
  if (!isValidIsoDate(start)) {
    throw new TopicScoringDateRangeError(`Invalid --start date "${start}". Use ISO format YYYY-MM-DD.`);
  }
  if (!isValidIsoDate(end)) {
    throw new TopicScoringDateRangeError(`Invalid --end date "${end}". Use ISO format YYYY-MM-DD.`);
  }
  if (start > end) {
    throw new TopicScoringDateRangeError(`--start (${start}) must not be after --end (${end}).`);
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
  growthReportProvider: string | undefined;
  growthReportModel: string | undefined;
}

export function readProviderEnv(source: NodeJS.ProcessEnv = process.env): ProviderEnvConfig {
  const rawMaxTokens = source.TOPIC_SCORING_MAX_TOKENS ? Number(source.TOPIC_SCORING_MAX_TOKENS) : NaN;
  const maxTokens = Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? rawMaxTokens : DEFAULT_MAX_TOKENS;

  return {
    provider: source.TOPIC_SCORING_LLM_PROVIDER,
    model: source.TOPIC_SCORING_MODEL,
    maxTokens,
    apiKey: source.ANTHROPIC_API_KEY,
    growthReportProvider: source.GROWTH_REPORT_LLM_PROVIDER,
    growthReportModel: source.GROWTH_REPORT_MODEL,
  };
}

/** Resolves the live provider. Never called in --dry-run mode, so dry-run never requires any of this. */
export function resolveProvider(args: CollectArgs, env: ProviderEnvConfig): TopicScoringProvider {
  const providerName = args.provider ?? env.provider ?? env.growthReportProvider;

  if (!providerName) {
    throw new TopicScoringConfigError(
      "No LLM provider configured. Pass --provider mock for local testing, or set TOPIC_SCORING_LLM_PROVIDER " +
        '(or GROWTH_REPORT_LLM_PROVIDER) to "anthropic" (plus a resolved model and ANTHROPIC_API_KEY) in .env for a live run.'
    );
  }

  if (providerName === "mock") {
    return new MockTopicScoringProvider();
  }

  if (providerName === "anthropic") {
    const model = env.model ?? env.growthReportModel;
    if (!env.apiKey) {
      throw new TopicScoringConfigError(
        "ANTHROPIC_API_KEY is required for a live Anthropic run. Set it in .env, or use --provider mock / --dry-run instead."
      );
    }
    if (!model) {
      throw new TopicScoringConfigError(
        "No Anthropic model resolved (checked TOPIC_SCORING_MODEL, then GROWTH_REPORT_MODEL). Set one in .env once a model is confirmed."
      );
    }
    return new AnthropicTopicScoringProvider({ apiKey: env.apiKey, model });
  }

  throw new TopicScoringConfigError(`Unknown provider "${providerName}". Supported values: "mock", "anthropic".`);
}

// ---------------------------------------------------------------------------
// Input discovery: FinalSignalMiningRun JSON only — never the Markdown
// file, never raw platform files, never a growth summary/report/decision.
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

function isValidFinalSignalMiningRun(value: unknown): value is FinalSignalMiningRun {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== "1.0.0" || v.runType !== "signal_mining") return false;
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

  if (!Array.isArray(v.sourceRecordCatalog)) return false;
  if (!Array.isArray(v.signals)) return false;
  if (!Array.isArray(v.topicPool)) return false;

  const dataQuality = v.dataQuality as Record<string, unknown> | undefined;
  const status = dataQuality?.overallStatus;
  if (status !== "complete" && status !== "partial" && status !== "invalid") return false;

  return true;
}

/**
 * Cross-reference checks the static schema shape above can't express: no
 * duplicate signal/topic ids, every TopicCandidate.signalRefs entry
 * resolves to a real SignalCandidate, every SignalCandidate's cited source
 * record ids exist in the run's own sourceRecordCatalog, and every topic's
 * status is scoreable (candidate/needs_review only — never
 * rejected/archived).
 */
function assertCrossReferencesValid(run: FinalSignalMiningRun, filename: string): void {
  const signalIds = new Set<string>();
  for (const signal of run.signals) {
    if (signalIds.has(signal.id)) {
      throw new TopicScoringInputError(`"${filename}" contains duplicate SignalCandidate id "${signal.id}".`);
    }
    signalIds.add(signal.id);
  }

  const sourceRecordIds = new Set(run.sourceRecordCatalog.map((record) => record.id));
  for (const signal of run.signals) {
    for (const recordId of signal.provenance.sourceRecordIds) {
      if (!sourceRecordIds.has(recordId)) {
        throw new TopicScoringInputError(`"${filename}" SignalCandidate "${signal.id}" provenance references unknown source record "${recordId}".`);
      }
    }
  }

  const topicIds = new Set<string>();
  for (const topic of run.topicPool) {
    if (topicIds.has(topic.id)) {
      throw new TopicScoringInputError(`"${filename}" contains duplicate TopicCandidate id "${topic.id}".`);
    }
    topicIds.add(topic.id);

    if (topic.status !== "candidate" && topic.status !== "needs_review") {
      throw new TopicScoringInputError(
        `"${filename}" TopicCandidate "${topic.id}" has status "${topic.status}"; only "candidate" or "needs_review" topics can be scored.`
      );
    }

    for (const ref of topic.signalRefs) {
      if (!signalIds.has(ref)) {
        throw new TopicScoringInputError(`"${filename}" TopicCandidate "${topic.id}" references unknown SignalCandidate "${ref}".`);
      }
    }
  }
}

function parseAndValidateSignalMiningRun(content: string, filename: string): FinalSignalMiningRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new TopicScoringInputError(`Failed to parse "${filename}" as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isValidFinalSignalMiningRun(parsed)) {
    throw new TopicScoringInputError(`"${filename}" does not match the expected FinalSignalMiningRun schema (runType must be "signal_mining").`);
  }

  if (parsed.dataQuality.overallStatus === "invalid") {
    throw new TopicScoringInputError(
      `"${filename}" has dataQuality.overallStatus = "invalid"; the Topic Scoring Agent refuses to score it. A "partial" status is accepted.`
    );
  }

  assertCrossReferencesValid(parsed, filename);

  return parsed;
}

function assertPeriodMatches(runPeriod: DateRange, requestedPeriod: DateRange): void {
  try {
    assertPeriodMatchesShared("Signal Mining run", runPeriod, requestedPeriod);
  } catch (err) {
    if (err instanceof PeriodMismatchError) throw new TopicScoringInputError(err.message);
    throw err;
  }
}

export interface LoadedSignalMiningRun {
  filename: string;
  content: string;
  run: FinalSignalMiningRun;
  notice?: string;
}

/** Loads the Signal Mining run for `period`: either exactly `args.input`, or the latest-generatedAt discovered `signal-mining-*.json` match. Never selects the sibling `.md` file. */
export function loadSignalMiningRun(args: CollectArgs, period: DateRange, deps: FileSystemDeps = defaultDeps): LoadedSignalMiningRun {
  if (args.input) {
    const content = deps.readFile(args.input);
    const run = parseAndValidateSignalMiningRun(content, basenameOnly(args.input));
    assertPeriodMatches(run.period, period);
    return { filename: basenameOnly(args.input), content, run };
  }

  const matches = findMatchingFilesShared(SIGNALS_DIR, "signal-mining", period, deps.listDir);
  if (matches.length === 0) {
    throw new TopicScoringInputError(
      `No Signal Mining run found for ${period.start} to ${period.end}. Expected a file matching ` +
        `growth/signals/signal-mining-${period.start}_to_${period.end}*.json — run growth:signals for this range first.`
    );
  }

  let selected: { filename: string; snapshot: { generatedAt: string } } | undefined;
  try {
    selected = selectLatestSnapshotShared<{ generatedAt: string }>(SIGNALS_DIR, matches, deps.readFile, (s) => s.generatedAt);
  } catch (err) {
    throw new TopicScoringInputError(
      `Failed to parse a matching Signal Mining run for ${period.start} to ${period.end} as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!selected) {
    throw new TopicScoringInputError(`Failed to read any matching Signal Mining run for ${period.start} to ${period.end}.`);
  }

  const content = deps.readFile(join(SIGNALS_DIR, selected.filename));
  const run = parseAndValidateSignalMiningRun(content, selected.filename);
  assertPeriodMatches(run.period, period);

  const notice = matches.length > 1 ? multipleMatchesNoticeShared("Signal Mining run", selected.filename) : undefined;

  return { filename: selected.filename, content, run, notice };
}

/** Live Anthropic execution refuses a mock-generated Signal Mining run by default — never called for --dry-run or --provider mock, which may consume either. `--allow-mock-input` opts in explicitly, for testing. */
export function assertLiveMockInputAllowed(run: FinalSignalMiningRun, filename: string, allowMockInput: boolean): void {
  if (run.generation.isMock && !allowMockInput) {
    throw new TopicScoringConfigError(
      `The selected Signal Mining run ("${filename}") was mock-generated (generation.isMock = true). Live Anthropic execution ` +
        "refuses to score from a mock run by default — pass --allow-mock-input to override for explicit testing."
    );
  }
}

// ---------------------------------------------------------------------------
// Output paths
// ---------------------------------------------------------------------------

export function resolvePreviewPath(period: DateRange, overwrite: boolean, exists?: (path: string) => boolean, now?: Date): string {
  return resolveSnapshotPath(PROCESSED_DATA_DIR, "topic-scoring-request", period, overwrite, exists, now);
}

export function resolveRunJsonPath(period: DateRange, overwrite: boolean, exists?: (path: string) => boolean, now?: Date): string {
  return resolveSnapshotPath(SCORES_DIR, "topic-scoring", period, overwrite, exists, now);
}

// ---------------------------------------------------------------------------
// Dry-run preview
// ---------------------------------------------------------------------------

export interface BuildDryRunPreviewParams {
  run: FinalSignalMiningRun;
  runFilename: string;
  runContent: string;
  language: SupportedLanguage;
  intendedProvider: string;
  intendedModel: string | undefined;
  maxTokens: number;
  createdAt?: string;
}

/** Pure: builds the dry-run preview object (never writes it). Never includes API keys/tokens/credential paths. */
export function buildDryRunPreview(params: BuildDryRunPreviewParams): TopicScoringDryRunPreview {
  const profile = getTopicScoringProfile();
  const { contexts, catalog } = buildTopicScoringContexts(params.run);
  const sourceIsMock = params.run.generation.isMock;
  const sourceHumanReviewed = params.run.humanReview.approved;

  const request = buildTopicScoringLLMRequest({
    campaign: params.run.campaign,
    period: params.run.period,
    language: params.language,
    scoringProfile: profile,
    topicContexts: contexts,
    topicCatalog: catalog,
    dataQualityWarnings: params.run.dataQuality.warnings,
    sourceIsMock,
    sourceHumanReviewed,
    maxTokens: params.maxTokens,
  });

  return {
    source: "topic_scoring_dry_run",
    createdAt: params.createdAt ?? new Date().toISOString(),
    period: params.run.period,
    campaign: params.run.campaign,
    sourceSignalMiningFilename: params.runFilename,
    sourceSignalMiningSha256: sha256(params.runContent),
    sourceSignalMiningIsMock: sourceIsMock,
    sourceSignalsHumanReviewed: sourceHumanReviewed,
    scoringProfile: buildTopicScoringProfileSummary(),
    topicContexts: contexts,
    topicCatalog: catalog,
    dataQualityWarnings: params.run.dataQuality.warnings,
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
  | { mode: "dry-run"; previewPath: string; preview: TopicScoringDryRunPreview; notices: string[] }
  | { mode: "scores"; jsonPath: string; markdownPath: string; run: FinalTopicScoringRun; notices: string[] };

export async function run(argv: string[], deps: FileSystemDeps = defaultDeps): Promise<RunResult> {
  const args = parseArgs(argv);
  const period: DateRange = { start: args.start as string, end: args.end as string };
  assertValidDateRange(period.start, period.end);

  const { filename, content, run: signalMiningRun, notice } = loadSignalMiningRun(args, period, deps);
  const notices = notice ? [notice] : [];

  const env = readProviderEnv();

  if (args.dryRun) {
    const intendedProviderName = args.provider ?? env.provider ?? env.growthReportProvider ?? "not_configured";
    const intendedModel = env.model ?? env.growthReportModel;

    const preview = buildDryRunPreview({
      run: signalMiningRun,
      runFilename: filename,
      runContent: content,
      language: args.language,
      intendedProvider: intendedProviderName,
      intendedModel,
      maxTokens: env.maxTokens,
    });

    const previewPath = resolvePreviewPath(period, args.overwrite, deps.exists);
    writeFileAtomic(previewPath, `${JSON.stringify(preview, null, 2)}\n`);

    return { mode: "dry-run", previewPath, preview, notices };
  }

  const provider = resolveProvider(args, env);
  if (provider.name === "anthropic") {
    assertLiveMockInputAllowed(signalMiningRun, filename, args.allowMockInput);
  }

  const topicScoringRun = await runTopicScoringAgent({
    run: signalMiningRun,
    sourceFilename: filename,
    sourceSha256: sha256(content),
    language: args.language,
    maxTokens: env.maxTokens,
    provider,
  });

  const jsonPath = resolveRunJsonPath(period, args.overwrite, deps.exists);
  const markdownPath = jsonPath.replace(/\.json$/, ".md");

  writeFileAtomic(jsonPath, `${JSON.stringify(topicScoringRun, null, 2)}\n`);
  writeFileAtomic(markdownPath, renderTopicScoringMarkdown(topicScoringRun));

  return { mode: "scores", jsonPath, markdownPath, run: topicScoringRun, notices };
}

async function main(): Promise<void> {
  try {
    const result = await run(process.argv.slice(2));

    for (const notice of result.notices) {
      console.log(`[growth:score-topics] ${notice}`);
    }

    if (result.mode === "dry-run") {
      console.log(`[growth:score-topics] Selected Signal Mining run: ${result.preview.sourceSignalMiningFilename}`);
      console.log(`[growth:score-topics] Period: ${result.preview.period.start} to ${result.preview.period.end}`);
      console.log(`[growth:score-topics] Source mock: ${result.preview.sourceSignalMiningIsMock ? "yes" : "no"}`);
      console.log(`[growth:score-topics] Source human-reviewed: ${result.preview.sourceSignalsHumanReviewed ? "yes" : "no"}`);
      console.log(`[growth:score-topics] Topics: ${result.preview.topicContexts.length}`);
      console.log(`[growth:score-topics] Signals: ${result.preview.topicContexts.reduce((sum, t) => sum + t.signalCount, 0)}`);
      console.log(`[growth:score-topics] Source records: ${result.preview.topicContexts.reduce((sum, t) => sum + t.citedSourceRecords.length, 0)}`);
      console.log(`[growth:score-topics] Scoring profile: ${result.preview.scoringProfile.id}@${result.preview.scoringProfile.version}`);
      console.log(`[growth:score-topics] Intended provider: ${result.preview.intendedProvider}`);
      console.log(`[growth:score-topics] Intended model: ${result.preview.intendedModel}`);
      console.log(`[growth:score-topics] Request preview written to: ${result.previewPath}`);
      console.log("[growth:score-topics] Dry run complete — no provider request was made.");
      return;
    }

    const { run: finalRun } = result;
    const policyDefaultCount = finalRun.scoredTopics.reduce(
      (sum, topic) => sum + topic.dimensions.filter((dimension) => dimension.scoreBasis === "policy_default").length,
      0
    );
    console.log(`[growth:score-topics] Selected Signal Mining run: ${finalRun.provenance.sourceSignalMiningFilename}`);
    console.log(`[growth:score-topics] Provider: ${finalRun.generation.provider}${finalRun.generation.isMock ? " (mock)" : ""}`);
    console.log(`[growth:score-topics] Model: ${finalRun.generation.model}`);
    console.log(`[growth:score-topics] Topics scored: ${finalRun.ranking.candidateCount}`);
    console.log(`[growth:score-topics] Top topic: ${finalRun.ranking.topTopicId ?? "none"}`);
    console.log(`[growth:score-topics] Advance: ${finalRun.ranking.advanceCount}`);
    console.log(`[growth:score-topics] Needs human review: ${finalRun.ranking.needsHumanReviewCount}`);
    console.log(`[growth:score-topics] Hold: ${finalRun.ranking.holdCount}`);
    console.log(`[growth:score-topics] Policy-default dimensions: ${policyDefaultCount}`);
    console.log(`[growth:score-topics] Source mock: ${finalRun.provenance.sourceSignalMiningIsMock ? "yes" : "no"}`);
    console.log(`[growth:score-topics] JSON output: ${result.jsonPath}`);
    console.log(`[growth:score-topics] Markdown output: ${result.markdownPath}`);
    console.log(`[growth:score-topics] Human review required: ${finalRun.humanReview.required ? "yes" : "no"}`);
    console.log(`[growth:score-topics] Warnings: ${finalRun.dataQuality.warnings.length}`);
    const { inputTokens, outputTokens } = finalRun.generation.usage;
    if (inputTokens !== null || outputTokens !== null) {
      console.log(`[growth:score-topics] Token usage: input=${inputTokens ?? "unavailable"}, output=${outputTokens ?? "unavailable"}`);
    }
  } catch (err) {
    if (
      err instanceof TopicScoringDateRangeError ||
      err instanceof TopicScoringInputError ||
      err instanceof TopicScoringConfigError ||
      err instanceof TopicScoringValidationError ||
      err instanceof LLMProviderConfigError ||
      err instanceof LLMProviderResponseError
    ) {
      console.error(`[growth:score-topics] ${err.message}`);
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[growth:score-topics] Unexpected error: ${reason}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
