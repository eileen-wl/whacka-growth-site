import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apps } from "../../src/data/apps";
import { APP_TOOLS_QUERY } from "../../src/lib/sanity";
import type { AppData, SeoData } from "../../src/data/apps";

/**
 * `@sanity/client` is mocked module-wide for this file too — the
 * "fallback" describe block below must exercise the *fallback* code path
 * deterministically (no Sanity client configured), never depend on
 * whatever the real, live Sanity dataset happens to contain right now.
 * Matches "Mock all Sanity requests. Do not access the real project
 * during automated tests" from this project's own established testing
 * policy (see growth/README.md's Sanity draft preview mode section).
 * `vi.hoisted` is required here (rather than a plain `const` above
 * `vi.mock`) because this file already has relative imports (e.g.
 * `../../src/lib/sanity`) before this point — `vi.mock` calls hoist above
 * all imports, but a plain preceding `const` does not hoist with it,
 * which previously caused a "Cannot access before initialization" error.
 */
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@sanity/client", () => ({
  createClient: () => ({ fetch: fetchMock }),
}));

/**
 * Verifies the SEO persistence gap resolved for step 4 (CMS Writer):
 * Sanity `appTool` schema, AppData type, GROQ query, and the seed-script
 * mapping all agree on an optional `seo` object with the same shape, and
 * the five existing apps were never given fabricated SEO content.
 *
 * `studio/schemaTypes/appTool.ts` cannot be imported directly here — the
 * "sanity" package is only installed inside studio/'s own workspace, not
 * the project root vitest runs from — so its checks are structural (text
 * based) rather than a live schema import.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

describe("AppData / SeoData (src/data/apps.ts)", () => {
  it("declares seo as an optional field", () => {
    // Compile-time check: this assignment must type-check without `seo`.
    const withoutSeo: AppData = { ...apps[0] };
    expect(withoutSeo).toBeDefined();
  });

  it("does not fabricate SEO content for any of the existing apps", () => {
    for (const app of apps) {
      expect(app.seo).toBeUndefined();
    }
  });

  it("SeoData fields are all optional", () => {
    const empty: SeoData = {};
    expect(empty).toEqual({});
  });
});

describe("APP_TOOLS_QUERY (src/lib/sanity.ts)", () => {
  it("retrieves the seo object and all four of its fields", () => {
    expect(APP_TOOLS_QUERY).toMatch(/seo\s*\{/);
    expect(APP_TOOLS_QUERY).toContain("title");
    expect(APP_TOOLS_QUERY).toContain("metaDescription");
    expect(APP_TOOLS_QUERY).toContain("primaryKeyword");
    expect(APP_TOOLS_QUERY).toContain("secondaryKeywords");
  });

  it("still retrieves faq as a separate projection, not duplicated inside seo", () => {
    expect(APP_TOOLS_QUERY).toMatch(/faq\[\]\{\s*question,\s*answer\s*\}/);
  });
});

describe("getApps()/getAppBySlug() fallback behavior", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    // Force the "no Sanity client configured" path deterministically —
    // never rely on whatever the real, live project/dataset happen to be
    // set to in .env right now.
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to src/data/apps.ts when no Sanity client is configured, with seo left undefined (never an invented empty object)", async () => {
    const { getApps } = await import("../../src/lib/sanity");
    const result = await getApps();
    expect(result.length).toBeGreaterThan(0);
    for (const app of result) {
      expect(app.seo).toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getAppBySlug still resolves an existing app with no seo field present", async () => {
    const { getAppBySlug } = await import("../../src/lib/sanity");
    const app = await getAppBySlug(apps[0].slug);
    expect(app).toBeDefined();
    expect(app?.seo).toBeUndefined();
  });
});

describe("studio/schemaTypes/appTool.ts (structural check — 'sanity' package is not resolvable from the project root)", () => {
  const schema = readRepoFile("studio/schemaTypes/appTool.ts");

  it("defines a seo object field with title, metaDescription, primaryKeyword, secondaryKeywords", () => {
    const seoFieldMatch = schema.match(/name:\s*"seo"[\s\S]*?\]\s*,?\s*\}\),/);
    expect(seoFieldMatch).not.toBeNull();
    const seoBlock = seoFieldMatch?.[0] ?? "";
    expect(seoBlock).toContain('type: "object"');
    expect(seoBlock).toContain('name: "title"');
    expect(seoBlock).toContain('name: "metaDescription"');
    expect(seoBlock).toContain('name: "primaryKeyword"');
    expect(seoBlock).toContain('name: "secondaryKeywords"');
  });

  it("does not mark any seo subfield as Rule.required() (stays optional for backward compatibility)", () => {
    const seoFieldMatch = schema.match(/name:\s*"seo"[\s\S]*?\]\s*,?\s*\}\),/);
    const seoBlock = seoFieldMatch?.[0] ?? "";
    expect(seoBlock).not.toContain("Rule.required()");
  });

  it("does not duplicate the faq field inside the seo object (faq stays a single top-level field)", () => {
    const matches = schema.match(/name:\s*"faq"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("does not add analytics, credentials, publication, or provider fields", () => {
    for (const forbidden of ["analytics", "apiKey", "credential", "publishedAt", "provider"]) {
      expect(schema.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("still requires the pre-existing required fields (unchanged by this addition)", () => {
    expect(schema).toMatch(/name:\s*"name"[\s\S]*?Rule\.required\(\)/);
    expect(schema).toMatch(/name:\s*"slug"[\s\S]*?Rule\.required\(\)/);
  });
});

describe("scripts/seed.ts SEO mapping", () => {
  it("preserves app.seo when supplied, without inventing a value", () => {
    const seedScript = readRepoFile("scripts/seed.ts");
    expect(seedScript).toContain("seo: app.seo,");
  });
});
