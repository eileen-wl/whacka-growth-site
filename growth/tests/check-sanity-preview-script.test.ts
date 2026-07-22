import { describe, expect, it } from "vitest";
import { CheckSanityPreviewArgsError, parseArgs, readEnv, run } from "../scripts/check-sanity-preview";
import { SanityPreviewConfigError } from "../../src/lib/sanity-shared";
import type { ReadOnlySanityClient } from "../scripts/check-sanity-preview";

function fullDoc(overrides: Record<string, unknown> = {}) {
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

const BASE_PROC_ENV = { PUBLIC_SANITY_PROJECT_ID: "test_project", PUBLIC_SANITY_DATASET: "production" } as NodeJS.ProcessEnv;

function fakeClientFn(docs: unknown[]): (config: unknown) => ReadOnlySanityClient {
  return () => ({ fetch: async <T>() => docs as T });
}

describe("parseArgs", () => {
  it("requires exactly one of --preview or --published", () => {
    expect(() => parseArgs([])).toThrow(CheckSanityPreviewArgsError);
    expect(() => parseArgs(["--preview", "--published"])).toThrow(CheckSanityPreviewArgsError);
  });

  it("accepts --preview alone", () => {
    expect(parseArgs(["--preview"])).toEqual({ mode: "preview" });
  });

  it("accepts --published alone", () => {
    expect(parseArgs(["--published"])).toEqual({ mode: "published" });
  });

  it("rejects an unrecognized argument", () => {
    expect(() => parseArgs(["--preview", "--bogus"])).toThrow(/Unrecognized argument/);
  });
});

describe("readEnv", () => {
  it("--preview forces SANITY_PREVIEW_DRAFTS to 'true' regardless of the actual process env", () => {
    const env = readEnv({ mode: "preview" }, { ...BASE_PROC_ENV, SANITY_PREVIEW_DRAFTS: "false" });
    expect(env.SANITY_PREVIEW_DRAFTS).toBe("true");
  });

  it("--published forces SANITY_PREVIEW_DRAFTS to 'false' regardless of the actual process env", () => {
    const env = readEnv({ mode: "published" }, { ...BASE_PROC_ENV, SANITY_PREVIEW_DRAFTS: "true" });
    expect(env.SANITY_PREVIEW_DRAFTS).toBe("false");
  });

  it("passes PUBLIC_SANITY_PROJECT_ID/DATASET/API_VERSION and SANITY_API_TOKEN through from process.env", () => {
    const env = readEnv({ mode: "published" }, { ...BASE_PROC_ENV, PUBLIC_SANITY_API_VERSION: "2026-07-09", SANITY_API_TOKEN: "sk-test-token" } as NodeJS.ProcessEnv);
    expect(env.PUBLIC_SANITY_PROJECT_ID).toBe("test_project");
    expect(env.PUBLIC_SANITY_DATASET).toBe("production");
    expect(env.PUBLIC_SANITY_API_VERSION).toBe("2026-07-09");
    expect(env.SANITY_API_TOKEN).toBe("sk-test-token");
  });
});

describe("run — --preview", () => {
  it("resolves perspective 'drafts', finds SlotSmith, and reports 6 deduplicated apps (5 published + 1 draft)", async () => {
    const docs = [
      fullDoc({ _id: "appTool-orderly", slug: "orderly", name: "Orderly" }),
      fullDoc({ _id: "appTool-bookly", slug: "bookly", name: "Bookly" }),
      fullDoc({ _id: "appTool-quotewave", slug: "quotewave", name: "QuoteWave" }),
      fullDoc({ _id: "appTool-clientflow", slug: "clientflow", name: "ClientFlow" }),
      fullDoc({ _id: "appTool-cardsnap", slug: "cardsnap", name: "CardSnap" }),
      fullDoc({ _id: "drafts.appTool-slotsmith", slug: "slotsmith", name: "SlotSmith" }),
    ];
    const result = await run(["--preview"], fakeClientFn(docs));
    expect(result.diagnostics.perspective).toBe("drafts");
    expect(result.diagnostics.previewMode).toBe(true);
    expect(result.diagnostics.useCdn).toBe(false);
    expect(result.slotSmithFound).toBe(true);
    expect(result.dedupedCount).toBe(6);
    expect(result.rawCount).toBe(6);
  });

  it("deduplicates when both a draft and published version of the same app are returned", async () => {
    const docs = [fullDoc({ _id: "appTool-slotsmith", slug: "slotsmith" }), fullDoc({ _id: "drafts.appTool-slotsmith", slug: "slotsmith" })];
    const result = await run(["--preview"], fakeClientFn(docs));
    expect(result.rawCount).toBe(2);
    expect(result.dedupedCount).toBe(1);
  });

  it("fails safely when SANITY_API_TOKEN is not configured", async () => {
    const originalToken = process.env.SANITY_API_TOKEN;
    const originalProject = process.env.PUBLIC_SANITY_PROJECT_ID;
    const originalDataset = process.env.PUBLIC_SANITY_DATASET;
    delete process.env.SANITY_API_TOKEN;
    process.env.PUBLIC_SANITY_PROJECT_ID = "test_project";
    process.env.PUBLIC_SANITY_DATASET = "production";
    try {
      await expect(run(["--preview"], fakeClientFn([]))).rejects.toThrow(SanityPreviewConfigError);
    } finally {
      if (originalToken !== undefined) process.env.SANITY_API_TOKEN = originalToken;
      if (originalProject !== undefined) process.env.PUBLIC_SANITY_PROJECT_ID = originalProject;
      else delete process.env.PUBLIC_SANITY_PROJECT_ID;
      if (originalDataset !== undefined) process.env.PUBLIC_SANITY_DATASET = originalDataset;
      else delete process.env.PUBLIC_SANITY_DATASET;
    }
  });
});

describe("run — --published", () => {
  it("resolves perspective 'published', does not find SlotSmith, and reports 5 apps", async () => {
    const docs = [
      fullDoc({ _id: "appTool-orderly", slug: "orderly", name: "Orderly" }),
      fullDoc({ _id: "appTool-bookly", slug: "bookly", name: "Bookly" }),
      fullDoc({ _id: "appTool-quotewave", slug: "quotewave", name: "QuoteWave" }),
      fullDoc({ _id: "appTool-clientflow", slug: "clientflow", name: "ClientFlow" }),
      fullDoc({ _id: "appTool-cardsnap", slug: "cardsnap", name: "CardSnap" }),
    ];
    const result = await run(["--published"], fakeClientFn(docs));
    expect(result.diagnostics.perspective).toBe("published");
    expect(result.diagnostics.previewMode).toBe(false);
    expect(result.diagnostics.useCdn).toBe(true);
    expect(result.slotSmithFound).toBe(false);
    expect(result.dedupedCount).toBe(5);
  });

  it("never requires a token", async () => {
    const originalToken = process.env.SANITY_API_TOKEN;
    delete process.env.SANITY_API_TOKEN;
    try {
      const result = await run(["--published"], fakeClientFn([]));
      expect(result.diagnostics.tokenConfigured).toBe(false);
    } finally {
      if (originalToken !== undefined) process.env.SANITY_API_TOKEN = originalToken;
    }
  });
});

describe("run — token safety", () => {
  it("the returned diagnostics never contain a token-shaped value, even when a token is configured", async () => {
    const originalToken = process.env.SANITY_API_TOKEN;
    process.env.SANITY_API_TOKEN = "sk-super-secret-token-value";
    try {
      const result = await run(["--preview"], fakeClientFn([]));
      const serialized = JSON.stringify(result.diagnostics);
      expect(serialized).not.toContain("sk-super-secret-token-value");
      expect(result.diagnostics.tokenConfigured).toBe(true);
    } finally {
      if (originalToken !== undefined) process.env.SANITY_API_TOKEN = originalToken;
      else delete process.env.SANITY_API_TOKEN;
    }
  });
});

describe("run — missing project/dataset configuration", () => {
  it("fails clearly when PUBLIC_SANITY_PROJECT_ID/PUBLIC_SANITY_DATASET are unset", async () => {
    const originalProject = process.env.PUBLIC_SANITY_PROJECT_ID;
    const originalDataset = process.env.PUBLIC_SANITY_DATASET;
    delete process.env.PUBLIC_SANITY_PROJECT_ID;
    delete process.env.PUBLIC_SANITY_DATASET;
    try {
      await expect(run(["--published"], fakeClientFn([]))).rejects.toThrow(CheckSanityPreviewArgsError);
    } finally {
      if (originalProject !== undefined) process.env.PUBLIC_SANITY_PROJECT_ID = originalProject;
      if (originalDataset !== undefined) process.env.PUBLIC_SANITY_DATASET = originalDataset;
    }
  });
});
