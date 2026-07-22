import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSnapshotPath, writeFileAtomic } from "../lib/collector-fs";
import { GrowthLoopFeedbackBuildError, GrowthLoopFeedbackValidationError, buildGrowthLoopFeedback, validateGrowthLoopFeedback } from "../contracts/loop-feedback";
import { experimentDecisionAnalysisSchema } from "../types/experiment-decision";
import type { GrowthLoopFeedback } from "../contracts/loop-feedback";
import type { FinalExperimentDecision } from "../types/experiment-decision";
import type { DateRange } from "../types/growth-summary";

/**
 * Deterministic CLI bridge between step 8 (Experiment Decision) and step 1
 * (Signal Mining) — not a new Agent, no LLM call, no network request. Reads
 * one already-validated `FinalExperimentDecision` JSON, calls the existing
 * pure `buildGrowthLoopFeedback()` adapter (growth/contracts/loop-feedback.ts)
 * exactly once, and writes the resulting `GrowthLoopFeedback` to
 * growth/decisions/, where `growth/scripts/run-signal-mining.ts` already
 * knows how to discover or accept it via `--feedback`. This script does not
 * run Signal Mining and does not modify it.
 */

const GROWTH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DECISIONS_DIR = join(GROWTH_DIR, "decisions");

export class BuildFeedbackArgsError extends Error {}
export class BuildFeedbackInputError extends Error {}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export interface CollectArgs {
  input?: string;
  overwrite: boolean;
}

export function parseArgs(argv: string[]): CollectArgs {
  const args: CollectArgs = { overwrite: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") {
      args.input = argv[++i];
    } else if (arg === "--overwrite") {
      args.overwrite = true;
    } else {
      throw new BuildFeedbackArgsError(`Unrecognized argument "${arg}".`);
    }
  }

  if (!args.input) {
    throw new BuildFeedbackArgsError("growth:feedback requires --input <path to a FinalExperimentDecision JSON file>.");
  }

  return args;
}

// ---------------------------------------------------------------------------
// Input: exactly the supplied FinalExperimentDecision JSON — no discovery.
// ---------------------------------------------------------------------------

export interface FileSystemDeps {
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
}

const defaultDeps: FileSystemDeps = {
  readFile: (path) => readFileSync(path, "utf-8"),
  exists: (path) => existsSync(path),
};

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function basenameOnly(path: string): string {
  return path.replace(/^.*[\\/]/, "");
}

/** Structural check only — FinalExperimentDecision has no single top-level Zod schema of its own (its `decision` sub-object does; see below). Mirrors the isValidX pattern every other growth/scripts/*.ts CLI already uses for its own "Final*" input shape. */
function isValidFinalExperimentDecision(value: unknown): value is FinalExperimentDecision {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== "1.0.0" || v.decisionType !== "experiment_decision") return false;
  if (typeof v.generatedAt !== "string") return false;

  const period = v.period as Record<string, unknown> | undefined;
  if (!period || typeof period.start !== "string" || typeof period.end !== "string") return false;

  const campaign = v.campaign as Record<string, unknown> | undefined;
  if (!campaign || typeof campaign.id !== "string" || typeof campaign.name !== "string") return false;

  const provenance = v.provenance as Record<string, unknown> | undefined;
  if (!provenance || typeof provenance.sourceGrowthReportFilename !== "string" || typeof provenance.sourceGrowthReportSha256 !== "string") return false;

  const generation = v.generation as Record<string, unknown> | undefined;
  if (!generation || typeof generation.provider !== "string" || typeof generation.model !== "string" || typeof generation.isMock !== "boolean") return false;

  if (typeof v.decisionScope !== "object" || v.decisionScope === null) return false;
  if (!Array.isArray(v.evidenceCatalog)) return false;
  if (!Array.isArray(v.findingCatalog)) return false;
  if (!Array.isArray(v.limitationCatalog)) return false;
  if (typeof v.decision !== "object" || v.decision === null) return false;

  const humanReview = v.humanReview as Record<string, unknown> | undefined;
  if (!humanReview || typeof humanReview.required !== "boolean") return false;

  const dataQuality = v.dataQuality as Record<string, unknown> | undefined;
  const status = dataQuality?.overallStatus;
  if (status !== "complete" && status !== "partial" && status !== "invalid") return false;

  return true;
}

/** Parses and validates the exact supplied file: well-formed JSON, matches the FinalExperimentDecision shape, and its embedded `decision` object passes the existing `experimentDecisionAnalysisSchema` (growth/types/experiment-decision.ts) — the same schema every other consumer of a decision's analysis validates against. Rejects anything malformed or unsupported; never silently coerces or repairs it. */
export function parseAndValidateFinalExperimentDecision(content: string, filename: string): FinalExperimentDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new BuildFeedbackInputError(`Failed to parse "${filename}" as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isValidFinalExperimentDecision(parsed)) {
    throw new BuildFeedbackInputError(`"${filename}" does not match the expected FinalExperimentDecision schema (decisionType must be "experiment_decision").`);
  }

  const decisionCheck = experimentDecisionAnalysisSchema.safeParse(parsed.decision);
  if (!decisionCheck.success) {
    const issues = decisionCheck.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new BuildFeedbackInputError(`"${filename}" contains an invalid "decision" object: ${issues.join("; ")}`);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Output path — growth/decisions/growth-loop-feedback-{start}_to_{end}.json,
// collision-safe unless --overwrite. Period comes from the validated source
// decision, never from a CLI flag.
// ---------------------------------------------------------------------------

export function resolveFeedbackOutputPath(period: DateRange, overwrite: boolean, exists?: (path: string) => boolean, now?: Date): string {
  return resolveSnapshotPath(DECISIONS_DIR, "growth-loop-feedback", period, overwrite, exists, now);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunResult {
  outputPath: string;
  feedback: GrowthLoopFeedback;
  sourceFilename: string;
  sourceSha256: string;
  decision: FinalExperimentDecision;
}

/** Reads --input, validates it, calls buildGrowthLoopFeedback() exactly once, re-validates the result, and writes it atomically. Fully synchronous and deterministic — no LLM call, no network request. */
export function run(argv: string[], deps: FileSystemDeps = defaultDeps): RunResult {
  const args = parseArgs(argv);
  const inputPath = args.input as string;

  const content = deps.readFile(inputPath);
  const beforeContent = content; // never mutated below — the source file is only ever read.
  const sourceFilename = basenameOnly(inputPath);
  const decision = parseAndValidateFinalExperimentDecision(content, sourceFilename);
  const sourceSha256 = sha256(content);

  const feedback = buildGrowthLoopFeedback(decision, {
    sourceDecisionFilename: sourceFilename,
    sourceDecisionSha256: sourceSha256,
  });
  const validatedFeedback = validateGrowthLoopFeedback(feedback);

  if (content !== beforeContent) {
    // Unreachable in practice (content is never reassigned above) — a defensive guard, per "never mutate the source Experiment Decision".
    throw new BuildFeedbackInputError("Internal error: source decision content changed unexpectedly during processing.");
  }

  const outputPath = resolveFeedbackOutputPath(decision.period, args.overwrite, deps.exists);
  writeFileAtomic(outputPath, `${JSON.stringify(validatedFeedback, null, 2)}\n`);

  return { outputPath, feedback: validatedFeedback, sourceFilename, sourceSha256, decision };
}

async function main(): Promise<void> {
  try {
    const result = run(process.argv.slice(2));

    console.log(`[growth:feedback] Selected Experiment Decision: ${result.sourceFilename}`);
    console.log(`[growth:feedback] Period: ${result.decision.period.start} to ${result.decision.period.end}`);
    console.log(`[growth:feedback] Source decision status: ${result.decision.decision.decisionSummary.decisionStatus}`);
    console.log(`[growth:feedback] Source decision mock: ${result.decision.generation.isMock ? "yes" : "no"}`);
    console.log(`[growth:feedback] Feedback type: ${result.feedback.feedbackType}`);
    console.log(`[growth:feedback] Instruction count: ${result.feedback.instructions.length}`);
    console.log(`[growth:feedback] Output written to: ${result.outputPath}`);
    console.log("[growth:feedback] No LLM call or network request was made — this is a deterministic conversion only.");
  } catch (err) {
    if (
      err instanceof BuildFeedbackArgsError ||
      err instanceof BuildFeedbackInputError ||
      err instanceof GrowthLoopFeedbackBuildError ||
      err instanceof GrowthLoopFeedbackValidationError
    ) {
      console.error(`[growth:feedback] ${err.message}`);
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[growth:feedback] Unexpected error: ${reason}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
