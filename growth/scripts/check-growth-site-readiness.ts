import "dotenv/config";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPreviewDiagnostics, resolveSanityConfig, SanityPreviewConfigError } from "../../src/lib/sanity-shared";
import type { SanityEnvLike } from "../../src/lib/sanity-shared";
import { FALLBACK_COVER_IMAGE } from "../../src/lib/images";

/**
 * Read-only Growth Site Engine production-readiness check.
 *
 * Only inspects local repository configuration, the real filesystem (for
 * the fallback image and `vercel.json`), and — via the same shared
 * `resolveSanityConfig`/`buildPreviewDiagnostics` logic `src/lib/sanity.ts`
 * and `check-sanity-preview.ts` use — the *local* resolved Sanity config.
 * It never makes a network request (to Sanity, Vercel, or anything else),
 * never mutates Sanity, and never triggers a deployment.
 *
 * Vercel/Sanity account-side settings — whether the repo is actually
 * connected to a Vercel project, deploy hooks, webhooks, project-level
 * environment variables, which branch Vercel builds from — are not visible
 * from a git checkout at all. This script deliberately reports those as
 * "requires_ui_verification" rather than guessing; see growth/README.md's
 * "Deployment readiness" section for the exact manual checks still needed.
 */

export interface SiteReadinessReport {
  publicSiteUrlConfigured: boolean;
  sanityProjectConfigured: boolean;
  sanityDatasetConfigured: boolean;
  productionPerspective: "published" | "drafts";
  previewModeDisabledByDefault: boolean;
  fallbackImageExists: boolean;
  vercelConfigPresent: boolean;
  deploymentAutomationStatus: "confirmed" | "requires_ui_verification";
}

export interface SiteReadinessDeps {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  exists?: (absolutePath: string) => boolean;
}

/** Same field set `src/lib/sanity.ts`/`check-sanity-preview.ts` read — no duplicate credential var introduced. */
export function readSanityEnv(source: NodeJS.ProcessEnv): SanityEnvLike {
  return {
    PUBLIC_SANITY_PROJECT_ID: source.PUBLIC_SANITY_PROJECT_ID,
    PUBLIC_SANITY_DATASET: source.PUBLIC_SANITY_DATASET,
    PUBLIC_SANITY_API_VERSION: source.PUBLIC_SANITY_API_VERSION,
    SANITY_PREVIEW_DRAFTS: source.SANITY_PREVIEW_DRAFTS,
    SANITY_API_TOKEN: source.SANITY_API_TOKEN,
  };
}

/**
 * Pure(ish) report builder — every input is injectable so tests never touch
 * the real environment or filesystem. Throws `SanityPreviewConfigError`
 * (never caught here) if the *actual* local env has
 * `SANITY_PREVIEW_DRAFTS=true` set without a token — the same failure
 * `src/lib/sanity.ts` would raise, surfaced here rather than masked.
 */
export function checkSiteReadiness(deps: SiteReadinessDeps = {}): SiteReadinessReport {
  const env = deps.env ?? process.env;
  const repoRoot = deps.repoRoot ?? process.cwd();
  const exists = deps.exists ?? existsSync;

  const config = resolveSanityConfig(readSanityEnv(env));
  const diagnostics = buildPreviewDiagnostics(config);
  const vercelConfigPresent = exists(join(repoRoot, "vercel.json"));

  return {
    publicSiteUrlConfigured: Boolean(env.PUBLIC_SITE_URL && env.PUBLIC_SITE_URL.trim().length > 0),
    sanityProjectConfigured: diagnostics.projectConfigured,
    sanityDatasetConfigured: diagnostics.datasetConfigured,
    productionPerspective: diagnostics.perspective,
    previewModeDisabledByDefault: !diagnostics.previewMode,
    fallbackImageExists: exists(join(repoRoot, "public", FALLBACK_COVER_IMAGE)),
    vercelConfigPresent,
    // vercel.json presence is the only deployment-automation fact this repo
    // can prove on its own — a real Vercel project can (and typically does)
    // exist and auto-deploy from git pushes with zero vercel.json in the
    // repo, so "false" here means "unproven from the repo", never "not set up".
    deploymentAutomationStatus: vercelConfigPresent ? "confirmed" : "requires_ui_verification",
  };
}

async function main(): Promise<void> {
  try {
    const report = checkSiteReadiness();
    console.log(`[check-site-readiness] Public site URL configured: ${report.publicSiteUrlConfigured}`);
    console.log(`[check-site-readiness] Sanity project configured: ${report.sanityProjectConfigured}`);
    console.log(`[check-site-readiness] Sanity dataset configured: ${report.sanityDatasetConfigured}`);
    console.log(`[check-site-readiness] Production perspective: ${report.productionPerspective}`);
    console.log(`[check-site-readiness] Preview mode disabled by default: ${report.previewModeDisabledByDefault}`);
    console.log(`[check-site-readiness] Fallback cover image exists: ${report.fallbackImageExists}`);
    console.log(`[check-site-readiness] vercel.json present in repo: ${report.vercelConfigPresent}`);
    console.log(`[check-site-readiness] Deployment automation status: ${report.deploymentAutomationStatus}`);
    if (report.deploymentAutomationStatus === "requires_ui_verification") {
      console.log(
        '[check-site-readiness] Vercel/Sanity account-side settings (connected repo, production branch, deploy hooks, ' +
          "webhooks, project environment variables) cannot be inspected from this repository — verify them in the " +
          'Vercel and Sanity dashboards. See "Deployment readiness" in growth/README.md.'
      );
    }
    console.log("[check-site-readiness] Read-only — no content was created, modified, published, or deployed.");
  } catch (err) {
    if (err instanceof SanityPreviewConfigError) {
      console.error(`[check-site-readiness] ${err.message}`);
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[check-site-readiness] Unexpected error: ${reason}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
