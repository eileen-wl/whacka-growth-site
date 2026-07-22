import { describe, expect, it } from "vitest";
import { applyImageFallbacks, FALLBACK_COVER_IMAGE, resolveImageSrc } from "./images";
import type { AppToolData } from "./sanity-shared";

function baseApp(overrides: Partial<AppToolData> = {}): AppToolData {
  return {
    slug: "orderly",
    name: "Orderly",
    tagline: "t",
    category: "c",
    shortDescription: "s",
    image: "/images/orderly/cover.svg",
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

describe("resolveImageSrc", () => {
  it("returns the path unchanged when a real file backs it", () => {
    const exists = () => true;
    expect(resolveImageSrc("/images/orderly/cover.svg", { exists })).toBe("/images/orderly/cover.svg");
  });

  it("returns the shared fallback when no real file backs the path", () => {
    const exists = () => false;
    expect(resolveImageSrc("/images/slotsmith/cover.svg", { exists })).toBe(FALLBACK_COVER_IMAGE);
  });

  it("returns the fallback for a null/undefined/empty path without checking the filesystem", () => {
    const exists = () => {
      throw new Error("must not be called");
    };
    expect(resolveImageSrc(undefined, { exists })).toBe(FALLBACK_COVER_IMAGE);
    expect(resolveImageSrc(null, { exists })).toBe(FALLBACK_COVER_IMAGE);
    expect(resolveImageSrc("", { exists })).toBe(FALLBACK_COVER_IMAGE);
    expect(resolveImageSrc("   ", { exists })).toBe(FALLBACK_COVER_IMAGE);
  });

  it("passes a remote http(s) URL through unchanged, never touching the filesystem", () => {
    const exists = () => {
      throw new Error("must not be called for a remote URL");
    };
    expect(resolveImageSrc("https://example.com/cover.png", { exists })).toBe("https://example.com/cover.png");
    expect(resolveImageSrc("http://example.com/cover.png", { exists })).toBe("http://example.com/cover.png");
  });

  it("normalizes a path without a leading slash before checking existence", () => {
    let checkedPath = "";
    const exists = (p: string) => {
      checkedPath = p;
      return true;
    };
    resolveImageSrc("images/orderly/cover.svg", { exists, publicDir: "/pub" });
    expect(checkedPath.replace(/\\/g, "/")).toBe("/pub/images/orderly/cover.svg");
  });

  it("against the real filesystem: an existing app's real cover image resolves unchanged", () => {
    expect(resolveImageSrc("/images/orderly/cover.svg")).toBe("/images/orderly/cover.svg");
  });

  it("against the real filesystem: a slug-guessed path with no real file resolves to the fallback", () => {
    expect(resolveImageSrc("/images/slotsmith/cover.svg")).toBe(FALLBACK_COVER_IMAGE);
  });

  it("the fallback asset itself exists on the real filesystem (it would be self-defeating otherwise)", () => {
    expect(resolveImageSrc(FALLBACK_COVER_IMAGE)).toBe(FALLBACK_COVER_IMAGE);
  });
});

describe("applyImageFallbacks", () => {
  it("resolves app.image and leaves an app with a real cover image untouched", () => {
    const exists = (p: string) => p.replace(/\\/g, "/").endsWith("/images/orderly/cover.svg");
    const [resolved] = applyImageFallbacks([baseApp({ image: "/images/orderly/cover.svg" })], { exists });
    expect(resolved.image).toBe("/images/orderly/cover.svg");
  });

  it("resolves an app without a real cover image to the shared fallback", () => {
    const exists = () => false;
    const [resolved] = applyImageFallbacks([baseApp({ slug: "slotsmith", image: "/images/slotsmith/cover.svg" })], { exists });
    expect(resolved.image).toBe(FALLBACK_COVER_IMAGE);
  });

  it("also resolves every screenshot image the same way", () => {
    const exists = () => false;
    const [resolved] = applyImageFallbacks(
      [baseApp({ screenshots: [{ image: "/images/slotsmith/screenshot-1.svg", caption: "c" }] })],
      { exists }
    );
    expect(resolved.screenshots[0].image).toBe(FALLBACK_COVER_IMAGE);
  });

  it("never mutates the input app objects", () => {
    const exists = () => false;
    const original = baseApp({ image: "/images/slotsmith/cover.svg" });
    applyImageFallbacks([original], { exists });
    expect(original.image).toBe("/images/slotsmith/cover.svg");
  });
});
