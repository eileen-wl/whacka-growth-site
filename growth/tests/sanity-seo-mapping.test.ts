import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apps } from "../../src/data/apps";
import { APP_TOOLS_QUERY, getAppBySlug, getApps } from "../../src/lib/sanity";
import type { AppData, SeoData } from "../../src/data/apps";

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
  it("falls back to src/data/apps.ts when no Sanity client is configured, with seo left undefined (never an invented empty object)", async () => {
    const result = await getApps();
    expect(result.length).toBeGreaterThan(0);
    for (const app of result) {
      expect(app.seo).toBeUndefined();
    }
  });

  it("getAppBySlug still resolves an existing app with no seo field present", async () => {
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
