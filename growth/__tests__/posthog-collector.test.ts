import { describe, expect, it, vi } from "vitest";
import {
  PostHogApiError,
  PostHogConfigError,
  PostHogDateRangeError,
  PostHogResponseShapeError,
  assertValidDateRange,
  buildGrowthEventsQuery,
  isValidIsoDate,
  quoteHogQLString,
  queryPostHog,
  readPostHogEnv,
} from "../collectors/posthog";
import { GROWTH_EVENTS } from "../types/posthog";
import type { PostHogEnv } from "../types/posthog";

const FAKE_ENV: PostHogEnv = {
  apiKey: "phx_test_secret_key",
  projectId: "12345",
  apiHost: "https://us.posthog.com",
};

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("readPostHogEnv", () => {
  it("returns the env when all required vars are present", () => {
    const env = readPostHogEnv({
      POSTHOG_PERSONAL_API_KEY: "key",
      POSTHOG_PROJECT_ID: "1",
      POSTHOG_API_HOST: "https://us.posthog.com",
    } as NodeJS.ProcessEnv);

    expect(env).toEqual({ apiKey: "key", projectId: "1", apiHost: "https://us.posthog.com" });
  });

  it("throws PostHogConfigError naming every missing variable", () => {
    expect(() => readPostHogEnv({} as NodeJS.ProcessEnv)).toThrow(PostHogConfigError);

    try {
      readPostHogEnv({ POSTHOG_PROJECT_ID: "1" } as NodeJS.ProcessEnv);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PostHogConfigError);
      const message = (err as Error).message;
      expect(message).toContain("POSTHOG_PERSONAL_API_KEY");
      expect(message).toContain("POSTHOG_API_HOST");
      expect(message).not.toContain("POSTHOG_PROJECT_ID");
    }
  });
});

describe("isValidIsoDate / assertValidDateRange", () => {
  it("accepts well-formed ISO dates", () => {
    expect(isValidIsoDate("2026-07-15")).toBe(true);
  });

  it("rejects malformed or non-existent dates", () => {
    expect(isValidIsoDate("2026-7-15")).toBe(false);
    expect(isValidIsoDate("07-15-2026")).toBe(false);
    expect(isValidIsoDate("not-a-date")).toBe(false);
    expect(isValidIsoDate("2026-02-30")).toBe(false);
  });

  it("throws PostHogDateRangeError for an invalid start date", () => {
    expect(() => assertValidDateRange("bad-date", "2026-07-15")).toThrow(PostHogDateRangeError);
  });

  it("throws PostHogDateRangeError for an invalid end date", () => {
    expect(() => assertValidDateRange("2026-07-01", "bad-date")).toThrow(PostHogDateRangeError);
  });

  it("throws PostHogDateRangeError when start is after end", () => {
    expect(() => assertValidDateRange("2026-07-15", "2026-07-01")).toThrow(PostHogDateRangeError);
  });

  it("allows start === end and start < end", () => {
    expect(() => assertValidDateRange("2026-07-01", "2026-07-01")).not.toThrow();
    expect(() => assertValidDateRange("2026-07-01", "2026-07-15")).not.toThrow();
  });
});

describe("quoteHogQLString", () => {
  it("wraps a plain value in single quotes", () => {
    expect(quoteHogQLString("$pageview")).toBe("'$pageview'");
  });

  it("doubles internal single quotes so they can't break out of the literal", () => {
    expect(quoteHogQLString("it's_an_event")).toBe("'it''s_an_event'");
  });
});

describe("buildGrowthEventsQuery", () => {
  it("scopes the query to exactly the five growth events", () => {
    const body = buildGrowthEventsQuery("2026-07-01", "2026-07-15");

    for (const eventName of GROWTH_EVENTS) {
      expect(body.query.query).toContain(eventName);
    }
    expect(body.query.kind).toBe("HogQLQuery");
  });

  it("uses single-quoted SQL string literals for event names, not JSON syntax", () => {
    const body = buildGrowthEventsQuery("2026-07-01", "2026-07-15");

    expect(body.query.query).toContain(
      "WHERE event IN ('$pageview', 'view_demo_click', 'remix_click', 'build_click', 'copy_prompt_click')"
    );
    expect(body.query.query).toContain("'$pageview'");
    expect(body.query.query).not.toContain('IN ["');
    expect(body.query.query).not.toContain('"$pageview"');
  });

  it("binds the date range as query values, not string interpolation", () => {
    const body = buildGrowthEventsQuery("2026-07-01", "2026-07-15");

    expect(body.query.values).toEqual({ start_date: "2026-07-01", end_date: "2026-07-15" });
    expect(body.query.query).not.toContain("2026-07-01");
    expect(body.query.query).not.toContain("2026-07-15");
  });

  it("groups by every Growth Data Specification dimension and counts users", () => {
    const body = buildGrowthEventsQuery("2026-07-01", "2026-07-15");

    for (const dimension of ["app_slug", "app_name", "page_type", "utm_source", "utm_medium", "utm_campaign", "utm_content"]) {
      expect(body.query.query).toContain(`properties.${dimension}`);
    }
    expect(body.query.query).toContain("event_count");
    expect(body.query.query).toContain("unique_users");
    expect(body.query.query).toContain("count(DISTINCT distinct_id)");
  });
});

describe("queryPostHog", () => {
  it("posts to the HogQL query endpoint with a bearer token and returns the parsed response", async () => {
    const results = [["2026-07-01", "$pageview", "", "", "home", "", "", "", "", 10, 8]];
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ results, columns: ["date"] }));

    const response = await queryPostHog(FAKE_ENV, "2026-07-01", "2026-07-15", fetchImpl as unknown as typeof fetch);

    expect(response.results).toEqual(results);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://us.posthog.com/api/projects/12345/query/");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_ENV.apiKey}`);
  });

  it("never lets the API key leak into a thrown error message", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "denied" }, { ok: false, status: 401, statusText: "Unauthorized" }));

    await expect(queryPostHog(FAKE_ENV, "2026-07-01", "2026-07-15", fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      PostHogApiError
    );

    try {
      await queryPostHog(FAKE_ENV, "2026-07-01", "2026-07-15", fetchImpl as unknown as typeof fetch);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PostHogApiError);
      expect((err as PostHogApiError).status).toBe(401);
      expect((err as Error).message).not.toContain(FAKE_ENV.apiKey);
    }
  });

  it("throws PostHogApiError with the HTTP status on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { ok: false, status: 500, statusText: "Internal Server Error" }));

    await expect(queryPostHog(FAKE_ENV, "2026-07-01", "2026-07-15", fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      status: 500,
    });
  });

  it("throws PostHogApiError when the network request itself fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(queryPostHog(FAKE_ENV, "2026-07-01", "2026-07-15", fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      PostHogApiError
    );
  });

  it("throws PostHogResponseShapeError when the response has no results array", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ notResults: [] }));

    await expect(queryPostHog(FAKE_ENV, "2026-07-01", "2026-07-15", fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      PostHogResponseShapeError
    );
  });

  it("rejects an invalid date range before ever calling fetch", async () => {
    const fetchImpl = vi.fn();

    await expect(queryPostHog(FAKE_ENV, "2026-07-15", "2026-07-01", fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      PostHogDateRangeError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
