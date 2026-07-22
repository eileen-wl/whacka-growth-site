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

describe("src/lib/sanity.ts — module wiring, env precedence, and end-to-end behavior", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    createClientMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preview mode defaults to false when SANITY_PREVIEW_DRAFTS is unset anywhere", async () => {
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

  it("an explicit process.env value takes precedence over a stale/absent import.meta.env value (the real PowerShell $env: scenario)", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_API_TOKEN", "sk-test-token");
    // Simulate: import.meta.env never received SANITY_PREVIEW_DRAFTS at all (it isn't
    // PUBLIC_-prefixed, so Astro's Vite instance — envPrefix: "PUBLIC_" — never
    // populates it there), while the shell (PowerShell's $env:) set it directly on
    // process.env. vi.stubEnv keeps both in sync, so we override process.env only,
    // afterward, to reproduce the actual real-world mismatch.
    vi.stubEnv("SANITY_PREVIEW_DRAFTS", "false");
    process.env.SANITY_PREVIEW_DRAFTS = "true";

    const mod = await import("./sanity");
    expect(mod.SANITY_PREVIEW_MODE).toBe(true);
  });

  it("preview mode requires SANITY_API_TOKEN — importing without it throws", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_PREVIEW_DRAFTS", "true");
    vi.stubEnv("SANITY_API_TOKEN", "");
    delete process.env.SANITY_API_TOKEN;
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

  it("preview mode: 5 published apps + 1 draft yields exactly 6 apps", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_PREVIEW_DRAFTS", "true");
    vi.stubEnv("SANITY_API_TOKEN", "sk-test-token");
    fetchMock.mockResolvedValue([
      fullDoc({ _id: "appTool-orderly", slug: "orderly", name: "Orderly" }),
      fullDoc({ _id: "appTool-bookly", slug: "bookly", name: "Bookly" }),
      fullDoc({ _id: "appTool-quotewave", slug: "quotewave", name: "QuoteWave" }),
      fullDoc({ _id: "appTool-clientflow", slug: "clientflow", name: "ClientFlow" }),
      fullDoc({ _id: "appTool-cardsnap", slug: "cardsnap", name: "CardSnap" }),
      fullDoc({ _id: "drafts.appTool-slotsmith", slug: "slotsmith", name: "SlotSmith" }),
    ]);

    const mod = await import("./sanity");
    const apps = await mod.getApps();
    expect(apps).toHaveLength(6);
    expect(apps.map((a) => a.slug)).toContain("slotsmith");
  });

  it("normal mode: 5 published apps only (no draft in the response) yields exactly 5 apps", async () => {
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
    expect(apps).toHaveLength(5);
    expect(apps.map((a) => a.slug)).not.toContain("slotsmith");
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

  it("falls back to src/data/apps.ts when Sanity isn't configured — unchanged existing behavior", async () => {
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "");
    const mod = await import("./sanity");
    const apps = await mod.getApps();
    expect(apps.map((a) => a.slug).sort()).toEqual(["bookly", "cardsnap", "clientflow", "orderly", "quotewave"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("preview mode never logs the token — console.log output is inspectable and token-free", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("PUBLIC_SANITY_PROJECT_ID", "test_project");
    vi.stubEnv("PUBLIC_SANITY_DATASET", "production");
    vi.stubEnv("SANITY_PREVIEW_DRAFTS", "true");
    vi.stubEnv("SANITY_API_TOKEN", "sk-super-secret-token-value");
    fetchMock.mockResolvedValue([fullDoc({ _id: "drafts.appTool-slotsmith" })]);

    const mod = await import("./sanity");
    await mod.getApps();

    const allLoggedText = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(allLoggedText).not.toContain("sk-super-secret-token-value");
    logSpy.mockRestore();
  });
});
