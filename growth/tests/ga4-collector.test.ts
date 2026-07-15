import { describe, expect, it, vi } from "vitest";
import {
  GA4ApiError,
  GA4ConfigError,
  GA4DateRangeError,
  GA4ResponseShapeError,
  assertValidDateRange,
  collectGA4Reports,
  isValidIsoDate,
  readGA4Env,
  runGA4Report,
  toPropertyResource,
} from "../collectors/ga4";
import { GA4_REPORTS } from "../types/ga4";
import type { GA4ReportClient, GA4RunReportRequest, GA4RunReportResponse } from "../types/ga4";

function fakeResponse(overrides: Partial<GA4RunReportResponse> = {}): GA4RunReportResponse {
  return {
    dimensionHeaders: [{ name: "date" }],
    metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }],
    rows: [
      {
        dimensionValues: [{ value: "20260701" }],
        metricValues: [{ value: "42" }],
      },
    ],
    rowCount: 1,
    ...overrides,
  };
}

function mockClient(handler: (request: GA4RunReportRequest) => GA4RunReportResponse | Promise<GA4RunReportResponse>): GA4ReportClient {
  return {
    runReport: vi.fn(async (request: GA4RunReportRequest): Promise<[GA4RunReportResponse]> => [await handler(request)]),
  };
}

describe("readGA4Env", () => {
  it("returns the property ID when it's set and numeric", () => {
    const env = readGA4Env({ GA4_PROPERTY_ID: "123456789" } as NodeJS.ProcessEnv);
    expect(env).toEqual({ propertyId: "123456789" });
    expect(Object.keys(env)).toEqual(["propertyId"]);
  });

  it("throws GA4ConfigError when GA4_PROPERTY_ID is missing", () => {
    expect(() => readGA4Env({} as NodeJS.ProcessEnv)).toThrow(GA4ConfigError);
    expect(() => readGA4Env({} as NodeJS.ProcessEnv)).toThrow(/GA4_PROPERTY_ID/);
  });

  it("throws GA4ConfigError when GA4_PROPERTY_ID isn't digits-only", () => {
    expect(() => readGA4Env({ GA4_PROPERTY_ID: "G-ABC123" } as NodeJS.ProcessEnv)).toThrow(GA4ConfigError);
    expect(() => readGA4Env({ GA4_PROPERTY_ID: "12a34" } as NodeJS.ProcessEnv)).toThrow(GA4ConfigError);
    expect(() => readGA4Env({ GA4_PROPERTY_ID: "" } as NodeJS.ProcessEnv)).toThrow(GA4ConfigError);
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

  it("throws GA4DateRangeError for an invalid start or end date", () => {
    expect(() => assertValidDateRange("bad-date", "2026-07-15")).toThrow(GA4DateRangeError);
    expect(() => assertValidDateRange("2026-07-01", "bad-date")).toThrow(GA4DateRangeError);
  });

  it("throws GA4DateRangeError when start is after end", () => {
    expect(() => assertValidDateRange("2026-07-15", "2026-07-01")).toThrow(GA4DateRangeError);
  });

  it("allows start === end and start < end", () => {
    expect(() => assertValidDateRange("2026-07-01", "2026-07-01")).not.toThrow();
    expect(() => assertValidDateRange("2026-07-01", "2026-07-15")).not.toThrow();
  });
});

describe("toPropertyResource", () => {
  it("formats the property ID as properties/{id}", () => {
    expect(toPropertyResource("123456789")).toBe("properties/123456789");
  });
});

describe("runGA4Report", () => {
  it("sends the correctly formatted property resource, dimensions, and metrics", async () => {
    let capturedRequest: GA4RunReportRequest | undefined;
    const client = mockClient((request) => {
      capturedRequest = request;
      return fakeResponse();
    });

    await runGA4Report(client, "123456789", GA4_REPORTS.trafficAcquisition, "2026-07-01", "2026-07-15");

    expect(capturedRequest?.property).toBe("properties/123456789");
    expect(capturedRequest?.dateRanges).toEqual([{ startDate: "2026-07-01", endDate: "2026-07-15" }]);
    expect(capturedRequest?.dimensions).toEqual([
      { name: "date" },
      { name: "sessionSource" },
      { name: "sessionMedium" },
      { name: "sessionCampaignName" },
    ]);
    expect(capturedRequest?.metrics).toEqual([
      { name: "sessions" },
      { name: "activeUsers" },
      { name: "engagedSessions" },
      { name: "engagementRate" },
    ]);
  });

  it("maps the response into headers/rows/rowCount", async () => {
    const client = mockClient(() => fakeResponse());

    const snapshot = await runGA4Report(client, "123456789", GA4_REPORTS.trafficOverview, "2026-07-01", "2026-07-15");

    expect(snapshot.headers).toEqual({ dimensionHeaders: ["date"], metricHeaders: ["sessions"] });
    expect(snapshot.rowCount).toBe(1);
    expect(snapshot.rows).toHaveLength(1);
  });

  it("preserves extra response fields (totals, metadata, ...) in responseMeta", async () => {
    const client = mockClient(() =>
      fakeResponse({ totals: [{ metricValues: [{ value: "42" }] }], metadata: { currencyCode: "USD" } })
    );

    const snapshot = await runGA4Report(client, "123456789", GA4_REPORTS.trafficOverview, "2026-07-01", "2026-07-15");

    expect(snapshot.responseMeta).toMatchObject({ metadata: { currencyCode: "USD" } });
    expect(snapshot.responseMeta).not.toHaveProperty("rows");
    expect(snapshot.responseMeta).not.toHaveProperty("dimensionHeaders");
  });

  it("throws GA4ApiError when the client call rejects, without leaking credentials", async () => {
    const client: GA4ReportClient = {
      runReport: vi.fn(async (): Promise<[GA4RunReportResponse]> => {
        throw new Error("7 PERMISSION_DENIED: User does not have sufficient permissions");
      }),
    };

    await expect(runGA4Report(client, "123456789", GA4_REPORTS.trafficOverview, "2026-07-01", "2026-07-15")).rejects.toThrow(
      GA4ApiError
    );

    try {
      await runGA4Report(client, "123456789", GA4_REPORTS.trafficOverview, "2026-07-01", "2026-07-15");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GA4ApiError);
      const message = (err as Error).message;
      expect(message).toContain("PERMISSION_DENIED");
      expect(message.toLowerCase()).not.toContain("credential");
      expect(message.toLowerCase()).not.toContain("token");
      expect(message.toLowerCase()).not.toContain("key");
    }
  });

  it("throws GA4ResponseShapeError when the response is missing the expected arrays", async () => {
    const client = mockClient(() => ({ rows: "not-an-array" }) as unknown as GA4RunReportResponse);

    await expect(runGA4Report(client, "123456789", GA4_REPORTS.trafficOverview, "2026-07-01", "2026-07-15")).rejects.toThrow(
      GA4ResponseShapeError
    );
  });

  it("tolerates an empty-data response (no rows at all)", async () => {
    const client = mockClient(() => ({ dimensionHeaders: [{ name: "date" }], metricHeaders: [{ name: "sessions" }] }));

    const snapshot = await runGA4Report(client, "123456789", GA4_REPORTS.trafficOverview, "2026-07-01", "2026-07-15");

    expect(snapshot.rows).toEqual([]);
    expect(snapshot.rowCount).toBe(0);
  });
});

describe("collectGA4Reports", () => {
  it("runs all three reports (traffic_overview, traffic_acquisition, landing_pages) for the same range", async () => {
    const seenReportNames: string[] = [];
    const client = mockClient((request) => {
      // Distinguish which report fired by its dimension set.
      seenReportNames.push(request.dimensions.map((d) => d.name).join(","));
      return fakeResponse();
    });

    const reports = await collectGA4Reports("123456789", "2026-07-01", "2026-07-15", client);

    expect(client.runReport).toHaveBeenCalledTimes(3);
    expect(seenReportNames).toContain(GA4_REPORTS.trafficOverview.dimensions.join(","));
    expect(seenReportNames).toContain(GA4_REPORTS.trafficAcquisition.dimensions.join(","));
    expect(seenReportNames).toContain(GA4_REPORTS.landingPages.dimensions.join(","));
    expect(reports.trafficOverview).toBeDefined();
    expect(reports.trafficAcquisition).toBeDefined();
    expect(reports.landingPages).toBeDefined();
  });

  it("rejects an invalid date range before ever calling the client", async () => {
    const client = mockClient(() => fakeResponse());

    await expect(collectGA4Reports("123456789", "2026-07-15", "2026-07-01", client)).rejects.toThrow(GA4DateRangeError);
    expect(client.runReport).not.toHaveBeenCalled();
  });

  it("propagates a single report's API error", async () => {
    let calls = 0;
    const client: GA4ReportClient = {
      runReport: vi.fn(async (): Promise<[GA4RunReportResponse]> => {
        calls++;
        if (calls === 2) throw new Error("5 NOT_FOUND: property not found");
        return [fakeResponse()];
      }),
    };

    await expect(collectGA4Reports("123456789", "2026-07-01", "2026-07-15", client)).rejects.toThrow(GA4ApiError);
  });
});
