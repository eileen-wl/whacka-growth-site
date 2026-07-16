import { describe, expect, it } from "vitest";
import {
  ManualInputValidationError,
  ManualJsonSignalAdapter,
  parseManualInputDocument,
  validateManualSignalRecords,
} from "../signal-sources/manual-json-signal-adapter";

const CONTEXT = { period: { start: "2026-07-08", end: "2026-07-14" }, campaign: { id: "test_campaign", name: "Test Campaign" }, now: "2026-07-15T00:00:00.000Z" };

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    sourceType: "mentor_input",
    sourceName: "Weekly mentor meeting",
    title: "SMBs want WhatsApp order handling",
    text: "Three founders described wanting to log WhatsApp orders without retyping them.",
    capturedAt: "2026-07-15T18:00:00.000Z",
    tags: ["whatsapp", "orders"],
    ...overrides,
  };
}

describe("parseManualInputDocument", () => {
  it("accepts a bare array", () => {
    expect(parseManualInputDocument([validRecord()])).toEqual([validRecord()]);
  });

  it("accepts an object with a records array", () => {
    expect(parseManualInputDocument({ records: [validRecord()] })).toEqual([validRecord()]);
  });

  it("rejects a document that is neither shape", () => {
    expect(() => parseManualInputDocument({ foo: "bar" })).toThrow(ManualInputValidationError);
    expect(() => parseManualInputDocument("not an object")).toThrow(ManualInputValidationError);
  });
});

describe("validateManualSignalRecords", () => {
  it("accepts a well-formed record", () => {
    expect(() => validateManualSignalRecords([validRecord()])).not.toThrow();
  });

  it("reports the record index for an invalid record", () => {
    try {
      validateManualSignalRecords([validRecord(), { sourceType: "mentor_input" }]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ManualInputValidationError);
      expect((err as Error).message).toContain("index 1");
    }
  });

  it("rejects an invalid URL", () => {
    expect(() => validateManualSignalRecords([validRecord({ url: "not-a-url" })])).toThrow(ManualInputValidationError);
  });

  it("accepts a null URL", () => {
    expect(() => validateManualSignalRecords([validRecord({ url: null })])).not.toThrow();
  });

  it("rejects an invalid capturedAt timestamp", () => {
    expect(() => validateManualSignalRecords([validRecord({ capturedAt: "not-a-timestamp" })])).toThrow(ManualInputValidationError);
  });

  it("rejects a top-level credential-shaped key", () => {
    expect(() => validateManualSignalRecords([validRecord({ apiKey: "sk-test" })])).toThrow(/credential-shaped key/);
  });

  it("rejects a credential-shaped key nested inside metadata", () => {
    expect(() => validateManualSignalRecords([validRecord({ metadata: { nested: { accessToken: "abc" } } })])).toThrow(/credential-shaped key/);
  });

  it("rejects a token-shaped key", () => {
    expect(() => validateManualSignalRecords([validRecord({ metadata: { token: "abc" } })])).toThrow(ManualInputValidationError);
  });

  it("accepts optional metrics", () => {
    const record = validRecord({ metrics: [{ name: "similarRequestsThisMonth", value: 4, unit: "count" }] });
    expect(() => validateManualSignalRecords([record])).not.toThrow();
  });

  it("accepts an empty metrics array", () => {
    expect(() => validateManualSignalRecords([validRecord({ metrics: [] })])).not.toThrow();
  });

  it("rejects a missing required field (title)", () => {
    expect(() => validateManualSignalRecords([validRecord({ title: undefined })])).toThrow(ManualInputValidationError);
  });

  it("rejects an unknown sourceType", () => {
    expect(() => validateManualSignalRecords([validRecord({ sourceType: "reddit_post" })])).toThrow(ManualInputValidationError);
  });
});

describe("ManualJsonSignalAdapter", () => {
  it("builds one SignalSourceRecord per validated record, verbatim", async () => {
    const records = validateManualSignalRecords([validRecord()]);
    const adapter = new ManualJsonSignalAdapter(records, "test_campaign");
    const result = await adapter.collect(CONTEXT);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("SMBs want WhatsApp order handling");
    expect(result[0].source.type).toBe("mentor_input");
    expect(result[0].source.name).toBe("Weekly mentor meeting");
  });

  it("does not forward metadata into the built record", async () => {
    const records = validateManualSignalRecords([validRecord({ metadata: { attendees: 3 } })]);
    const adapter = new ManualJsonSignalAdapter(records, "test_campaign");
    const result = await adapter.collect(CONTEXT);
    expect(JSON.stringify(result[0])).not.toContain("attendees");
  });

  it("produces deterministic ids across repeated runs on the same records", async () => {
    const records = validateManualSignalRecords([validRecord()]);
    const adapter = new ManualJsonSignalAdapter(records, "test_campaign");
    const first = await adapter.collect(CONTEXT);
    const second = await adapter.collect(CONTEXT);
    expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
  });

  it("falls back to context.now when capturedAt is absent", async () => {
    const records = validateManualSignalRecords([validRecord({ capturedAt: undefined })]);
    const adapter = new ManualJsonSignalAdapter(records, "test_campaign");
    const result = await adapter.collect(CONTEXT);
    expect(result[0].source.retrievedAt).toBe(CONTEXT.now);
  });

  it("carries reported metrics through unchanged", async () => {
    const records = validateManualSignalRecords([validRecord({ metrics: [{ name: "similarRequestsThisMonth", value: 4 }] })]);
    const adapter = new ManualJsonSignalAdapter(records, "test_campaign");
    const result = await adapter.collect(CONTEXT);
    expect(result[0].metrics).toEqual([{ name: "similarRequestsThisMonth", value: 4, unit: null, measurementBasis: expect.any(String), period: null }]);
  });
});
