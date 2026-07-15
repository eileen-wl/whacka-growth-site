import { describe, expect, it, vi } from "vitest";
import {
  GSCApiError,
  GSCConfigError,
  GSCDateRangeError,
  GSCResponseShapeError,
  assertValidDateRange,
  collectGSCReports,
  isValidGSCSiteUrl,
  isValidIsoDate,
  readGSCEnv,
  runGSCReport,
} from "../collectors/gsc";
import { GSC_REPORTS } from "../types/gsc";
import type { GSCDataRow, GSCQueryRequest, GSCQueryResponse, GSCReportClient } from "../types/gsc";

function fakeRow(overrides: Partial<GSCDataRow> = {}): GSCDataRow {
  return { keys: ["2026-07-01"], clicks: 3, impressions: 40, ctr: 0.075, position: 4.2, ...overrides };
}

function mockClient(handler: (request: GSCQueryRequest) => GSCQueryResponse | Promise<GSCQueryResponse>): GSCReportClient {
  return { query: vi.fn(async (request: GSCQueryRequest) => handler(request)) };
}

describe("readGSCEnv", () => {
  it("returns the site URL when it's a valid URL-prefix property", () => {
    const env = readGSCEnv({ GSC_SITE_URL: "https://example.com/" } as NodeJS.ProcessEnv);
    expect(env).toEqual({ siteUrl: "https://example.com/" });
  });

  it("returns the site URL when it's a valid sc-domain property", () => {
    const env = readGSCEnv({ GSC_SITE_URL: "sc-domain:example.com" } as NodeJS.ProcessEnv);
    expect(env).toEqual({ siteUrl: "sc-domain:example.com" });
  });

  it("throws GSCConfigError when GSC_SITE_URL is missing", () => {
    expect(() => readGSCEnv({} as NodeJS.ProcessEnv)).toThrow(GSCConfigError);
    expect(() => readGSCEnv({ GSC_SITE_URL: "" } as NodeJS.ProcessEnv)).toThrow(GSCConfigError);
  });

  it("throws GSCConfigError for a malformed property", () => {
    expect(() => readGSCEnv({ GSC_SITE_URL: "example.com" } as NodeJS.ProcessEnv)).toThrow(GSCConfigError);
    expect(() => readGSCEnv({ GSC_SITE_URL: "ftp://example.com" } as NodeJS.ProcessEnv)).toThrow(GSCConfigError);
    expect(() => readGSCEnv({ GSC_SITE_URL: "https://exa mple.com" } as NodeJS.ProcessEnv)).toThrow(GSCConfigError);
    expect(() => readGSCEnv({ GSC_SITE_URL: "sc-domain:" } as NodeJS.ProcessEnv)).toThrow(GSCConfigError);
  });
});

describe("isValidGSCSiteUrl", () => {
  it("accepts URL-prefix properties, preserving trailing slash as-is", () => {
    expect(isValidGSCSiteUrl("https://example.com/")).toBe(true);
    expect(isValidGSCSiteUrl("http://example.com")).toBe(true);
  });

  it("accepts sc-domain properties", () => {
    expect(isValidGSCSiteUrl("sc-domain:example.com")).toBe(true);
  });

  it("rejects empty values", () => {
    expect(isValidGSCSiteUrl("")).toBe(false);
  });

  it("rejects ordinary domains without the sc-domain: prefix", () => {
    expect(isValidGSCSiteUrl("example.com")).toBe(false);
    expect(isValidGSCSiteUrl("www.example.com")).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isValidGSCSiteUrl("https://")).toBe(false);
    expect(isValidGSCSiteUrl("not a url")).toBe(false);
  });

  it("rejects values containing spaces", () => {
    expect(isValidGSCSiteUrl("https://example.com/ path")).toBe(false);
    expect(isValidGSCSiteUrl("sc-domain: example.com")).toBe(false);
  });

  it("does not silently add or strip a trailing slash", () => {
    // Both forms are valid independently; the function must not mutate/compare them as equal.
    expect(isValidGSCSiteUrl("https://example.com")).toBe(true);
    expect(isValidGSCSiteUrl("https://example.com/")).toBe(true);
  });
});

describe("isValidIsoDate / assertValidDateRange", () => {
  it("accepts well-formed ISO dates", () => {
    expect(isValidIsoDate("2026-07-15")).toBe(true);
  });

  it("rejects malformed or non-existent dates", () => {
    expect(isValidIsoDate("2026-7-15")).toBe(false);
    expect(isValidIsoDate("not-a-date")).toBe(false);
    expect(isValidIsoDate("2026-02-30")).toBe(false);
  });

  it("throws GSCDateRangeError for an invalid start or end date", () => {
    expect(() => assertValidDateRange("bad-date", "2026-07-15")).toThrow(GSCDateRangeError);
    expect(() => assertValidDateRange("2026-07-01", "bad-date")).toThrow(GSCDateRangeError);
  });

  it("throws GSCDateRangeError when start is after end", () => {
    expect(() => assertValidDateRange("2026-07-15", "2026-07-01")).toThrow(GSCDateRangeError);
  });

  it("allows start === end and start < end", () => {
    expect(() => assertValidDateRange("2026-07-01", "2026-07-01")).not.toThrow();
    expect(() => assertValidDateRange("2026-07-01", "2026-07-15")).not.toThrow();
  });
});

describe("runGSCReport", () => {
  it("sends searchType web, dataState all, and the report's dimensions", async () => {
    let captured: GSCQueryRequest | undefined;
    const client = mockClient((request) => {
      captured = request;
      return { rows: [fakeRow()], responseAggregationType: "byPage" };
    });

    await runGSCReport(client, "sc-domain:example.com", GSC_REPORTS.queryPages, "2026-07-01", "2026-07-15");

    expect(captured?.siteUrl).toBe("sc-domain:example.com");
    expect(captured?.requestBody.searchType).toBe("web");
    expect(captured?.requestBody.dataState).toBe("all");
    expect(captured?.requestBody.dimensions).toEqual(["query", "page"]);
    expect(captured?.requestBody.startDate).toBe("2026-07-01");
    expect(captured?.requestBody.endDate).toBe("2026-07-15");
  });

  it("uses the maximum rowLimit (25000) and starts at startRow 0", async () => {
    let captured: GSCQueryRequest | undefined;
    const client = mockClient((request) => {
      captured = request;
      return { rows: [] };
    });

    await runGSCReport(client, "sc-domain:example.com", GSC_REPORTS.pages, "2026-07-01", "2026-07-15");

    expect(captured?.requestBody.rowLimit).toBe(25000);
    expect(captured?.requestBody.startRow).toBe(0);
  });

  it("paginates with startRow advancing by the page size until a short page ends it", async () => {
    const seenStartRows: number[] = [];
    const client = mockClient((request) => {
      seenStartRows.push(request.requestBody.startRow);
      if (request.requestBody.startRow === 0) {
        return { rows: Array.from({ length: 25000 }, () => fakeRow()) };
      }
      if (request.requestBody.startRow === 25000) {
        return { rows: Array.from({ length: 25000 }, () => fakeRow()) };
      }
      return { rows: Array.from({ length: 10 }, () => fakeRow()) };
    });

    const snapshot = await runGSCReport(client, "sc-domain:example.com", GSC_REPORTS.queries, "2026-07-01", "2026-07-15");

    expect(seenStartRows).toEqual([0, 25000, 50000]);
    expect(snapshot.rowCount).toBe(25000 + 25000 + 10);
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it("stops after a single page when the first page is already short", async () => {
    const client = mockClient(() => ({ rows: [fakeRow(), fakeRow()] }));

    const snapshot = await runGSCReport(client, "sc-domain:example.com", GSC_REPORTS.dailyOverview, "2026-07-01", "2026-07-15");

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(snapshot.rowCount).toBe(2);
  });

  it("stops on an empty response without erroring", async () => {
    const client = mockClient(() => ({ rows: [] }));

    const snapshot = await runGSCReport(client, "sc-domain:example.com", GSC_REPORTS.dailyOverview, "2026-07-01", "2026-07-15");

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.rowCount).toBe(0);
  });

  it("accepts a response with rows entirely absent (not just empty)", async () => {
    const client = mockClient(() => ({ responseAggregationType: "byPage" }));

    const snapshot = await runGSCReport(client, "sc-domain:example.com", GSC_REPORTS.dailyOverview, "2026-07-01", "2026-07-15");

    expect(snapshot.rows).toEqual([]);
    expect(snapshot.rowCount).toBe(0);
  });

  it("preserves incomplete-data metadata (firstIncompleteDate) untouched", async () => {
    const client = mockClient(() => ({
      rows: [fakeRow()],
      metadata: { firstIncompleteDate: "2026-07-15" },
    }));

    const snapshot = await runGSCReport(client, "sc-domain:example.com", GSC_REPORTS.dailyOverview, "2026-07-01", "2026-07-15");

    expect(snapshot.metadata).toEqual({ firstIncompleteDate: "2026-07-15" });
  });

  it("preserves each row's keys/clicks/impressions/ctr/position exactly", async () => {
    const row = fakeRow({ keys: ["widget install guide"], clicks: 12, impressions: 500, ctr: 0.024, position: 8.3 });
    const client = mockClient(() => ({ rows: [row] }));

    const snapshot = await runGSCReport(client, "sc-domain:example.com", GSC_REPORTS.queries, "2026-07-01", "2026-07-15");

    expect(snapshot.rows[0]).toEqual(row);
  });

  it("throws GSCApiError when the client call rejects, without leaking tokens/credentials", async () => {
    const client: GSCReportClient = {
      query: vi.fn(async () => {
        throw new Error("403 The caller does not have permission");
      }),
    };

    try {
      await runGSCReport(client, "sc-domain:example.com", GSC_REPORTS.dailyOverview, "2026-07-01", "2026-07-15");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GSCApiError);
      const message = (err as Error).message;
      expect(message).toContain("403");
      expect(message.toLowerCase()).not.toContain("token");
      expect(message.toLowerCase()).not.toContain("credential");
      expect(message.toLowerCase()).not.toContain("bearer");
    }
  });

  it("throws GSCResponseShapeError when rows isn't an array", async () => {
    const client = mockClient(() => ({ rows: "oops" }) as unknown as GSCQueryResponse);

    await expect(
      runGSCReport(client, "sc-domain:example.com", GSC_REPORTS.dailyOverview, "2026-07-01", "2026-07-15")
    ).rejects.toThrow(GSCResponseShapeError);
  });

  it("throws GSCApiError if pagination exceeds the safety limit instead of looping forever", async () => {
    // A single reused full-size page, with a small `maxPages` override so this test doesn't
    // have to allocate the real ~25M-row limit to prove the cap logic works.
    const fullPage = Array.from({ length: 25000 }, () => fakeRow());
    const client = mockClient(() => ({ rows: fullPage }));

    await expect(
      runGSCReport(client, "sc-domain:example.com", GSC_REPORTS.dailyOverview, "2026-07-01", "2026-07-15", 2)
    ).rejects.toThrow(GSCApiError);
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});

describe("collectGSCReports", () => {
  it("requests all four reports (daily_overview, queries, query_pages, pages) for the same range", async () => {
    const seenDimensionSets: string[] = [];
    const client = mockClient((request) => {
      seenDimensionSets.push(request.requestBody.dimensions.join(","));
      return { rows: [fakeRow()] };
    });

    const reports = await collectGSCReports("sc-domain:example.com", "2026-07-01", "2026-07-15", client);

    expect(client.query).toHaveBeenCalledTimes(4);
    expect(seenDimensionSets).toContain(GSC_REPORTS.dailyOverview.dimensions.join(","));
    expect(seenDimensionSets).toContain(GSC_REPORTS.queries.dimensions.join(","));
    expect(seenDimensionSets).toContain(GSC_REPORTS.queryPages.dimensions.join(","));
    expect(seenDimensionSets).toContain(GSC_REPORTS.pages.dimensions.join(","));
    expect(reports.dailyOverview).toBeDefined();
    expect(reports.queries).toBeDefined();
    expect(reports.queryPages).toBeDefined();
    expect(reports.pages).toBeDefined();
  });

  it("accepts all-empty reports without throwing", async () => {
    const client = mockClient(() => ({ rows: [] }));

    const reports = await collectGSCReports("sc-domain:example.com", "2026-07-01", "2026-07-15", client);

    expect(reports.dailyOverview.rowCount).toBe(0);
    expect(reports.queries.rowCount).toBe(0);
    expect(reports.queryPages.rowCount).toBe(0);
    expect(reports.pages.rowCount).toBe(0);
  });

  it("rejects an invalid date range before ever calling the client", async () => {
    const client = mockClient(() => ({ rows: [] }));

    await expect(collectGSCReports("sc-domain:example.com", "2026-07-15", "2026-07-01", client)).rejects.toThrow(
      GSCDateRangeError
    );
    expect(client.query).not.toHaveBeenCalled();
  });

  it("propagates a single report's API error", async () => {
    let calls = 0;
    const client: GSCReportClient = {
      query: vi.fn(async () => {
        calls++;
        if (calls === 2) throw new Error("404 Not Found");
        return { rows: [fakeRow()] };
      }),
    };

    await expect(collectGSCReports("sc-domain:example.com", "2026-07-01", "2026-07-15", client)).rejects.toThrow(GSCApiError);
  });
});
