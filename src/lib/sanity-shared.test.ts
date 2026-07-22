import { describe, expect, it } from "vitest";
import { buildClientConfig, buildPreviewDiagnostics, dedupeDraftsAndPublished, resolveSanityConfig, SanityPreviewConfigError } from "./sanity-shared";
import type { RawAppToolDoc, ResolvedSanityConfig } from "./sanity-shared";

const BASE_ENV = { PUBLIC_SANITY_PROJECT_ID: "test_project", PUBLIC_SANITY_DATASET: "production" };

describe("resolveSanityConfig", () => {
  it("defaults previewMode to false when SANITY_PREVIEW_DRAFTS is unset", () => {
    const config = resolveSanityConfig(BASE_ENV);
    expect(config.previewMode).toBe(false);
    expect(config.previewToken).toBeUndefined();
  });

  it("defaults apiVersion to 2024-01-01 when unset", () => {
    expect(resolveSanityConfig(BASE_ENV).apiVersion).toBe("2024-01-01");
  });

  it("passes projectId/dataset/apiVersion through unchanged", () => {
    const config = resolveSanityConfig({ ...BASE_ENV, PUBLIC_SANITY_API_VERSION: "2026-07-09" });
    expect(config.projectId).toBe("test_project");
    expect(config.dataset).toBe("production");
    expect(config.apiVersion).toBe("2026-07-09");
  });

  it("enables previewMode when SANITY_PREVIEW_DRAFTS is 'true', with a token present", () => {
    const config = resolveSanityConfig({ ...BASE_ENV, SANITY_PREVIEW_DRAFTS: "true", SANITY_API_TOKEN: "sk-test-token" });
    expect(config.previewMode).toBe(true);
    expect(config.previewToken).toBe("sk-test-token");
  });

  it("normalizes SANITY_PREVIEW_DRAFTS case-insensitively and trims whitespace", () => {
    for (const value of ["true", "True", "TRUE", "  true  ", "tRuE"]) {
      expect(resolveSanityConfig({ ...BASE_ENV, SANITY_PREVIEW_DRAFTS: value, SANITY_API_TOKEN: "sk-test-token" }).previewMode).toBe(true);
    }
  });

  it("treats any non-'true' value as preview disabled", () => {
    for (const value of ["1", "yes", "false", "", "truely"]) {
      expect(resolveSanityConfig({ ...BASE_ENV, SANITY_PREVIEW_DRAFTS: value }).previewMode).toBe(false);
    }
  });

  it("throws SanityPreviewConfigError when preview mode is requested without a token", () => {
    expect(() => resolveSanityConfig({ ...BASE_ENV, SANITY_PREVIEW_DRAFTS: "true" })).toThrow(SanityPreviewConfigError);
  });

  it("throws when the token is present but empty/whitespace-only", () => {
    expect(() => resolveSanityConfig({ ...BASE_ENV, SANITY_PREVIEW_DRAFTS: "true", SANITY_API_TOKEN: "   " })).toThrow(SanityPreviewConfigError);
  });

  it("the missing-token error message is clear and never contains a token-shaped value", () => {
    try {
      resolveSanityConfig({ ...BASE_ENV, SANITY_PREVIEW_DRAFTS: "true" });
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("SANITY_PREVIEW_DRAFTS=true requires SANITY_API_TOKEN");
      expect(message.toLowerCase()).not.toContain("sk-");
      expect(message.toLowerCase()).not.toContain("bearer");
    }
  });
});

describe("buildClientConfig", () => {
  const previewConfig: ResolvedSanityConfig = {
    projectId: "test_project",
    dataset: "production",
    apiVersion: "2026-07-09",
    previewMode: true,
    previewToken: "sk-test-token",
  };
  const publishedConfig: ResolvedSanityConfig = { ...previewConfig, previewMode: false, previewToken: undefined };

  it("normal (published) mode preserves existing useCdn: true and has no perspective/token keys at all", () => {
    const clientConfig = buildClientConfig(publishedConfig);
    expect(clientConfig.useCdn).toBe(true);
    expect(clientConfig).not.toHaveProperty("perspective");
    expect(clientConfig).not.toHaveProperty("token");
  });

  it("preview mode uses the supported 'drafts' perspective (not the deprecated 'previewDrafts')", () => {
    expect(buildClientConfig(previewConfig).perspective).toBe("drafts");
  });

  it("preview mode sets useCdn to false", () => {
    expect(buildClientConfig(previewConfig).useCdn).toBe(false);
  });

  it("preview mode carries the server-only token into the client config, never into the published-mode config", () => {
    expect(buildClientConfig(previewConfig).token).toBe("sk-test-token");
    expect(buildClientConfig(publishedConfig).token).toBeUndefined();
  });

  it("preview mode uses the correct projectId/dataset", () => {
    const clientConfig = buildClientConfig(previewConfig);
    expect(clientConfig.projectId).toBe("test_project");
    expect(clientConfig.dataset).toBe("production");
  });

  it("never includes a token-shaped value anywhere in the serialized published-mode config", () => {
    const serialized = JSON.stringify(buildClientConfig(publishedConfig));
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("sk-test");
  });
});

describe("buildPreviewDiagnostics", () => {
  it("reports perspective 'drafts' and useCdn false in preview mode, tokenConfigured true", () => {
    const diagnostics = buildPreviewDiagnostics({
      projectId: "p",
      dataset: "d",
      apiVersion: "v",
      previewMode: true,
      previewToken: "sk-test-token",
    });
    expect(diagnostics).toEqual({
      previewMode: true,
      projectConfigured: true,
      datasetConfigured: true,
      tokenConfigured: true,
      perspective: "drafts",
      useCdn: false,
    });
  });

  it("reports perspective 'published' and useCdn true in normal mode, tokenConfigured false", () => {
    const diagnostics = buildPreviewDiagnostics({
      projectId: "p",
      dataset: "d",
      apiVersion: "v",
      previewMode: false,
      previewToken: undefined,
    });
    expect(diagnostics).toEqual({
      previewMode: false,
      projectConfigured: true,
      datasetConfigured: true,
      tokenConfigured: false,
      perspective: "published",
      useCdn: true,
    });
  });

  it("reports projectConfigured/datasetConfigured false when unset", () => {
    const diagnostics = buildPreviewDiagnostics({
      projectId: undefined,
      dataset: undefined,
      apiVersion: "v",
      previewMode: false,
      previewToken: undefined,
    });
    expect(diagnostics.projectConfigured).toBe(false);
    expect(diagnostics.datasetConfigured).toBe(false);
  });

  it("never includes a token value anywhere in its own serialized output", () => {
    const diagnostics = buildPreviewDiagnostics({
      projectId: "p",
      dataset: "d",
      apiVersion: "v",
      previewMode: true,
      previewToken: "sk-super-secret-token",
    });
    expect(JSON.stringify(diagnostics)).not.toContain("sk-super-secret-token");
  });
});

describe("dedupeDraftsAndPublished", () => {
  function doc(overrides: Partial<{ _id: string; slug: string; name: string }> = {}): RawAppToolDoc {
    return {
      _id: "appTool-slotsmith",
      slug: "slotsmith",
      name: "SlotSmith",
      tagline: "t",
      category: "c",
      shortDescription: "s",
      image: "/images/slotsmith/cover.svg",
      screenshots: [],
      problem: "p",
      solution: "sol",
      whoItsFor: [],
      prompt: "prompt",
      ctaLabel: "Build",
      ctaHref: "#",
      relatedSlugs: [],
      faq: [],
      ...overrides,
    };
  }

  it("passes a single document through unchanged (minus _id)", () => {
    const result = dedupeDraftsAndPublished([doc()]);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("slotsmith");
    expect(result[0]).not.toHaveProperty("_id");
  });

  it("collapses a draft + published pair for the same slug into exactly one entry — never duplicate cards", () => {
    const published = doc({ _id: "appTool-slotsmith", name: "SlotSmith (published)" });
    const draft = doc({ _id: "drafts.appTool-slotsmith", name: "SlotSmith (draft)" });
    const result = dedupeDraftsAndPublished([published, draft]);
    expect(result).toHaveLength(1);
  });

  it("prefers the draft version when both exist, regardless of array order", () => {
    const published = doc({ _id: "appTool-slotsmith", name: "SlotSmith (published)" });
    const draft = doc({ _id: "drafts.appTool-slotsmith", name: "SlotSmith (draft)" });

    expect(dedupeDraftsAndPublished([published, draft])[0].name).toBe("SlotSmith (draft)");
    expect(dedupeDraftsAndPublished([draft, published])[0].name).toBe("SlotSmith (draft)");
  });

  it("keeps documents with different slugs entirely separate", () => {
    const a = doc({ _id: "appTool-orderly", slug: "orderly", name: "Orderly" });
    const b = doc({ _id: "appTool-bookly", slug: "bookly", name: "Bookly" });
    const result = dedupeDraftsAndPublished([a, b]);
    expect(result.map((r) => r.slug).sort()).toEqual(["bookly", "orderly"]);
  });

  it("never leaves a drafts.-prefixed value in the output slug", () => {
    const draft = doc({ _id: "drafts.appTool-slotsmith", slug: "slotsmith" });
    const result = dedupeDraftsAndPublished([draft]);
    expect(result[0].slug).toBe("slotsmith");
    expect(result[0].slug).not.toContain("drafts.");
  });

  it("strips _id from every returned entry, in every case", () => {
    const result = dedupeDraftsAndPublished([doc({ _id: "appTool-a", slug: "a" }), doc({ _id: "drafts.appTool-b", slug: "b" })]);
    for (const entry of result) {
      expect(entry).not.toHaveProperty("_id");
    }
  });

  it("with 5 published apps + 1 draft, returns 6 deduplicated entries (matching the expected preview count)", () => {
    const published = ["orderly", "bookly", "quotewave", "clientflow", "cardsnap"].map((slug) => doc({ _id: `appTool-${slug}`, slug, name: slug }));
    const draft = doc({ _id: "drafts.appTool-slotsmith", slug: "slotsmith", name: "SlotSmith" });
    const result = dedupeDraftsAndPublished([...published, draft]);
    expect(result).toHaveLength(6);
    expect(result.map((r) => r.slug)).toContain("slotsmith");
  });
});
