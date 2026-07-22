import { describe, expect, it } from "vitest";
import { checkSiteReadiness, readSanityEnv } from "../scripts/check-growth-site-readiness";
import { SanityPreviewConfigError } from "../../src/lib/sanity-shared";

const BASE_ENV = {
  PUBLIC_SANITY_PROJECT_ID: "test_project",
  PUBLIC_SANITY_DATASET: "production",
  PUBLIC_SITE_URL: "https://example.vercel.app",
} as NodeJS.ProcessEnv;

describe("readSanityEnv", () => {
  it("passes through only the expected Sanity-related fields", () => {
    const env = readSanityEnv({ ...BASE_ENV, SANITY_API_TOKEN: "sk-test", RANDOM_OTHER_VAR: "x" } as NodeJS.ProcessEnv);
    expect(env).toEqual({
      PUBLIC_SANITY_PROJECT_ID: "test_project",
      PUBLIC_SANITY_DATASET: "production",
      PUBLIC_SANITY_API_VERSION: undefined,
      SANITY_PREVIEW_DRAFTS: undefined,
      SANITY_API_TOKEN: "sk-test",
    });
  });
});

describe("checkSiteReadiness", () => {
  it("reports a fully-configured, preview-disabled, published-perspective local setup", () => {
    const report = checkSiteReadiness({
      env: BASE_ENV,
      repoRoot: "/repo",
      exists: () => true,
    });
    expect(report.publicSiteUrlConfigured).toBe(true);
    expect(report.sanityProjectConfigured).toBe(true);
    expect(report.sanityDatasetConfigured).toBe(true);
    expect(report.productionPerspective).toBe("published");
    expect(report.previewModeDisabledByDefault).toBe(true);
    expect(report.fallbackImageExists).toBe(true);
  });

  it("reports missing config as false rather than throwing, when Sanity isn't configured at all", () => {
    const report = checkSiteReadiness({ env: {} as NodeJS.ProcessEnv, repoRoot: "/repo", exists: () => false });
    expect(report.sanityProjectConfigured).toBe(false);
    expect(report.sanityDatasetConfigured).toBe(false);
    expect(report.publicSiteUrlConfigured).toBe(false);
    expect(report.fallbackImageExists).toBe(false);
  });

  it("productionPerspective is 'drafts' only when SANITY_PREVIEW_DRAFTS=true and a token is present — matches src/lib/sanity.ts exactly", () => {
    const report = checkSiteReadiness({
      env: { ...BASE_ENV, SANITY_PREVIEW_DRAFTS: "true", SANITY_API_TOKEN: "sk-test" } as NodeJS.ProcessEnv,
      repoRoot: "/repo",
      exists: () => true,
    });
    expect(report.productionPerspective).toBe("drafts");
    expect(report.previewModeDisabledByDefault).toBe(false);
  });

  it("throws SanityPreviewConfigError (never masks it) when SANITY_PREVIEW_DRAFTS=true is set locally without a token", () => {
    expect(() =>
      checkSiteReadiness({ env: { ...BASE_ENV, SANITY_PREVIEW_DRAFTS: "true" } as NodeJS.ProcessEnv, repoRoot: "/repo", exists: () => true })
    ).toThrow(SanityPreviewConfigError);
  });

  it("vercelConfigPresent and deploymentAutomationStatus both reflect vercel.json presence in the repo", () => {
    const withVercelJson = checkSiteReadiness({
      env: BASE_ENV,
      repoRoot: "/repo",
      exists: (p) => p.replace(/\\/g, "/").endsWith("/repo/vercel.json"),
    });
    expect(withVercelJson.vercelConfigPresent).toBe(true);
    expect(withVercelJson.deploymentAutomationStatus).toBe("confirmed");

    const withoutVercelJson = checkSiteReadiness({ env: BASE_ENV, repoRoot: "/repo", exists: () => false });
    expect(withoutVercelJson.vercelConfigPresent).toBe(false);
    expect(withoutVercelJson.deploymentAutomationStatus).toBe("requires_ui_verification");
  });

  it("never reads or returns a token-shaped value anywhere in the report", () => {
    const report = checkSiteReadiness({
      env: { ...BASE_ENV, SANITY_API_TOKEN: "sk-super-secret-token-value" } as NodeJS.ProcessEnv,
      repoRoot: "/repo",
      exists: () => true,
    });
    expect(JSON.stringify(report)).not.toContain("sk-super-secret-token-value");
  });

  it("against the real repository: reports the real, currently-committed state", () => {
    const report = checkSiteReadiness({ env: { PUBLIC_SITE_URL: "https://example.com" } as NodeJS.ProcessEnv });
    expect(report.fallbackImageExists).toBe(true);
    expect(typeof report.vercelConfigPresent).toBe("boolean");
    expect(["confirmed", "requires_ui_verification"]).toContain(report.deploymentAutomationStatus);
  });
});
