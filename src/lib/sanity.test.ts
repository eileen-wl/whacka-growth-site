import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const createClientMock = vi.fn((_config: unknown) => ({ fetch: fetchMock }));

/**
 * The only Sanity mock in this file — `@sanity/client`'s `createClient` is
 * replaced module-wide, so no test here can ever reach the real project.
 * Matches the exact pattern already used in
 * growth/tests/write-cms-draft-script.test.ts.
 */
vi.mock("@sanity/client", () => ({
  createClient: (config: unknown) => createClientMock(config),
}));

import { buildClientConfig, dedupeDraftsAndPublished, resolveSanityConfig, SanityPreviewConfigError } from "./sanity";
import type { ResolvedSanityConfig } from "./sanity";

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

  it("enables previewMode only when SANITY_PREVIEW_DRAFTS is exactly 'true', with a token present", () => {
    const config = resolveSanityConfig({ ...BASE_ENV, SANITY_PREVIEW_DRAFTS: "true", SANITY_API_TOKEN: "sk-test-token" });
    expect(config.previewMode).toBe(true);
    expect(config.previewToken).toBe("sk-test-token");
  });

  it("treats any value other than the literal 'true' as preview disabled", () => {
    for (const value of ["1", "yes", "True", ""]) {
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
    const clientConfig = buildClientConfig(previewConfig);
    expect(clientConfig.perspective).toBe("drafts");
  });

  it("preview mode sets useCdn to false", () => {
    expect(buildClientConfig(previewConfig).useCdn).toBe(false);
  });

  it("preview mode carries the server-only token into the client config, never into the published-mode config", () => {
    expect(buildClientConfig(previewConfig).token).toBe("sk-test-token");
    expect(buildClientConfig(publishedConfig).token).toBeUndefined();
  });

  it("never includes a token-shaped value anywhere in the serialized published-mode config", () => {
    const serialized = JSON.stringify(buildClientConfig(publishedConfig));
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("sk-test");
  });
});

describe("dedupeDraftsAndPublished", () => {
  function doc(overrides: Partial<{ _id: string; slug: string; name: string }> = {}) {
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
});

describe("module wiring — getApps()/getAppBySlug() end to end (real Sanity network access never reachable)", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    createClientMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function fullDoc(overrides: Record<string, unknown> = {}) {
    return {
      _id: "appTool-slotsmith",
      slug: "slotsmith",
      name: "SlotSmith",
      tagline: "A clean appointment booking form your clients can fill in seconds",
      category: "Scheduling & Booking",
      shortDescription: "Collect and manage appointment requests in one tidy view.",
      image: "/images/slotsmith/cover.svg",
      screenshots: [],
      problem: "Owners juggle bookings across texts and calls.",
      solution: "One shared booking form.",
      whoItsFor: ["Solo service providers"],
      prompt: "Build a mini app called SlotSmith.",
      ctaLabel: "Build your own version",
      ctaHref: "https://whacka.app/dashboard",
      relatedSlugs: [],
      faq: [{ question: "What does SlotSmith do?", answer: "Collects appointment requests." }],
      demoUrl: null,
      remixUrl: null,
      buildUrl: "https://whacka.app/dashboard",
      status: "draft",
      notes: null,
      utmContent: "slotsmith",
      seo: {
        title: "SlotSmith: Simple Booking Form for Small Businesses",
        metaDescription: "SlotSmith is a lightweight booking and appointment form.",
        primaryKeyword: "booking form for small businesses",
        secondaryKeywords: ["appointment booking form"],
      },
      ...overrides,
    };
  }

  it("preview mode defaults to false when SANITY_PREVIEW_DRAFTS is unset", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    const mod = await import("./sanity");
    expect(mod.SANITY_PREVIEW_MODE).toBe(false);
  });

  it("normal mode constructs the client with useCdn: true and no perspective/token", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    await import("./sanity");
    expect(createClientMock).toHaveBeenCalledWith(expect.objectContaining({ useCdn: true }));
    const calledConfig = createClientMock.mock.calls[0][0] as Record<string, unknown>;
    expect(calledConfig).not.toHaveProperty("perspective");
    expect(calledConfig).not.toHaveProperty("token");
  });

  it("preview mode requires SANITY_API_TOKEN — importing without it throws", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_PREVIEW_DRAFTS", "true");
    await expect(import("./sanity")).rejects.toThrow(/SANITY_API_TOKEN/);
  });

  it("preview mode with a token constructs the client with perspective 'drafts' and useCdn: false", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_PREVIEW_DRAFTS", "true");
    vi.stubEnv("SANITY_API_TOKEN", "sk-test-token");
    const mod = await import("./sanity");
    expect(mod.SANITY_PREVIEW_MODE).toBe(true);
    expect(createClientMock).toHaveBeenCalledWith(expect.objectContaining({ useCdn: false, perspective: "drafts", token: "sk-test-token" }));
  });

  it("preview mode: a draft resolves as the logical appTool document at slug 'slotsmith', never 'drafts.appTool-slotsmith'", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_PREVIEW_DRAFTS", "true");
    vi.stubEnv("SANITY_API_TOKEN", "sk-test-token");
    fetchMock.mockResolvedValue([fullDoc({ _id: "drafts.appTool-slotsmith" })]);

    const mod = await import("./sanity");
    const app = await mod.getAppBySlug("slotsmith");
    expect(app).toBeDefined();
    expect(app?.slug).toBe("slotsmith");
    expect(await mod.getAppBySlug("drafts.appTool-slotsmith")).toBeUndefined();
  });

  it("preview mode: draft + published for the same slug never renders as two entries", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_PREVIEW_DRAFTS", "true");
    vi.stubEnv("SANITY_API_TOKEN", "sk-test-token");
    fetchMock.mockResolvedValue([fullDoc({ _id: "appTool-slotsmith" }), fullDoc({ _id: "drafts.appTool-slotsmith" })]);

    const mod = await import("./sanity");
    const apps = await mod.getApps();
    expect(apps.filter((a) => a.slug === "slotsmith")).toHaveLength(1);
  });

  it("preview mode: SEO fields render", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_PREVIEW_DRAFTS", "true");
    vi.stubEnv("SANITY_API_TOKEN", "sk-test-token");
    fetchMock.mockResolvedValue([fullDoc({ _id: "drafts.appTool-slotsmith" })]);

    const mod = await import("./sanity");
    const app = await mod.getAppBySlug("slotsmith");
    expect(app?.seo?.title).toBe("SlotSmith: Simple Booking Form for Small Businesses");
    expect(app?.seo?.metaDescription).toContain("SlotSmith");
  });

  it("preview mode: FAQ and CTA mapping remain intact", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_PREVIEW_DRAFTS", "true");
    vi.stubEnv("SANITY_API_TOKEN", "sk-test-token");
    fetchMock.mockResolvedValue([fullDoc({ _id: "drafts.appTool-slotsmith" })]);

    const mod = await import("./sanity");
    const app = await mod.getAppBySlug("slotsmith");
    expect(app?.faq).toEqual([{ question: "What does SlotSmith do?", answer: "Collects appointment requests." }]);
    expect(app?.ctaLabel).toBe("Build your own version");
  });

  it("preview mode: null demoUrl/remixUrl stay unavailable, buildUrl remains unchanged", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_PREVIEW_DRAFTS", "true");
    vi.stubEnv("SANITY_API_TOKEN", "sk-test-token");
    fetchMock.mockResolvedValue([fullDoc({ _id: "drafts.appTool-slotsmith" })]);

    const mod = await import("./sanity");
    const app = await mod.getAppBySlug("slotsmith");
    expect(app?.demoUrl).toBeFalsy();
    expect(app?.remixUrl).toBeFalsy();
    expect(app?.buildUrl).toBe("https://whacka.app/dashboard");
  });

  it("normal mode: published-only fetch results are returned as-is, current apps remain compatible", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    fetchMock.mockResolvedValue([
      fullDoc({ _id: "appTool-orderly", slug: "orderly", name: "Orderly" }),
      fullDoc({ _id: "appTool-bookly", slug: "bookly", name: "Bookly" }),
      fullDoc({ _id: "appTool-quotewave", slug: "quotewave", name: "QuoteWave" }),
      fullDoc({ _id: "appTool-clientflow", slug: "clientflow", name: "ClientFlow" }),
      fullDoc({ _id: "appTool-cardsnap", slug: "cardsnap", name: "CardSnap" }),
    ]);

    const mod = await import("./sanity");
    const apps = await mod.getApps();
    expect(apps.map((a) => a.slug).sort()).toEqual(["bookly", "cardsnap", "clientflow", "orderly", "quotewave"]);
  });

  it("normal mode: an unpublished draft is never visible (the mocked fetch never returns one, matching the API's own published-perspective default)", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    fetchMock.mockResolvedValue([fullDoc({ _id: "appTool-slotsmith" })]); // no draft in the response — the published perspective's own guarantee

    const mod = await import("./sanity");
    const apps = await mod.getApps();
    expect(apps).toHaveLength(1);
    expect(createClientMock.mock.calls[0][0]).not.toHaveProperty("perspective");
  });

  it("falls back to src/data/apps.ts when Sanity isn't configured — unchanged existing behavior", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "");
    const mod = await import("./sanity");
    const apps = await mod.getApps();
    expect(apps.map((a) => a.slug).sort()).toEqual(["bookly", "cardsnap", "clientflow", "orderly", "quotewave"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });
});
