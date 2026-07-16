import { deterministicId } from "../lib/ids";
import { manualSignalSourceRecordSchema } from "../types/signal-mining";
import type { SignalSourceAdapter, SignalSourceContext } from "./provider";
import type { ManualSignalSourceRecord, SignalSourceRecord } from "../types/signal-mining";

export class ManualInputValidationError extends Error {}

const CREDENTIAL_KEY_PATTERN = /api[_-]?key|token|authoriz|password|secret|cookie|access[_-]?token/i;

/** Recursively scans an object (including nested `metadata`) for a credential-shaped key. Returns the offending dotted path, or null. */
function findCredentialShapedKey(value: unknown, path = ""): string | null {
  if (value === null || typeof value !== "object") return null;
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const currentPath = path ? `${path}.${key}` : key;
    if (CREDENTIAL_KEY_PATTERN.test(key)) return currentPath;
    const nested = findCredentialShapedKey(val, currentPath);
    if (nested) return nested;
  }
  return null;
}

/** Accepts either a bare array of records, or `{ records: [...] }`. */
export function parseManualInputDocument(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as { records?: unknown }).records)) {
    return (raw as { records: unknown[] }).records;
  }
  throw new ManualInputValidationError(
    'Manual input file must be a JSON array of records, or an object with a "records" array. See growth/data/manual/signal-input.example.json.'
  );
}

/**
 * Validates every raw record before any provider call. A credential-shaped
 * key (apiKey/token/authorization/password/secret/cookie/accessToken — at
 * any nesting depth, including inside `metadata`) rejects the whole record
 * clearly, naming its index — never silently stripped.
 */
export function validateManualSignalRecords(rawRecords: unknown[]): ManualSignalSourceRecord[] {
  return rawRecords.map((raw, index) => {
    const credentialKey = findCredentialShapedKey(raw);
    if (credentialKey) {
      throw new ManualInputValidationError(
        `Manual input record at index ${index} contains a credential-shaped key "${credentialKey}"; remove it before running Signal Mining.`
      );
    }

    const parsed = manualSignalSourceRecordSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      throw new ManualInputValidationError(`Manual input record at index ${index} is invalid: ${issues.join("; ")}`);
    }

    return parsed.data;
  });
}

/**
 * Wraps already-validated manual records into `SignalSourceRecord`s. Note
 * `metadata` is validated (rejecting credential-shaped keys, see above) but
 * deliberately never copied into the record's content/entities/metrics — it
 * is accepted for the user's own bookkeeping only and is never forwarded to
 * a provider.
 */
export class ManualJsonSignalAdapter implements SignalSourceAdapter {
  readonly name = "manual_json";

  constructor(
    private readonly records: ManualSignalSourceRecord[],
    private readonly campaignId: string
  ) {}

  async collect(context: SignalSourceContext): Promise<SignalSourceRecord[]> {
    return this.records.map((record, index) => {
      const capturedAt = record.capturedAt ?? context.now;
      return {
        id: deterministicId("sourcerecord", "manual", this.campaignId, record.sourceType, record.sourceName, record.title, String(index)),
        source: {
          type: record.sourceType,
          name: record.sourceName,
          recordId: record.id ?? null,
          url: record.url ?? null,
          publishedAt: record.publishedAt ?? null,
          retrievedAt: capturedAt,
          isInternal: true,
        },
        title: record.title,
        content: record.text,
        entities: { keywords: record.tags ?? [], topics: [], audiences: [], productsOrApps: [], channels: [] },
        metrics: (record.metrics ?? []).map((m) => ({
          name: m.name,
          value: m.value,
          unit: m.unit ?? null,
          measurementBasis: m.measurementBasis ?? `Reported directly in manual input record "${record.sourceName}".`,
          period: m.period ?? null,
        })),
        references: { evidenceRefs: [], findingRefs: [], limitationRefs: [] },
        quality: { confidence: "medium", limitations: [] },
      };
    });
  }
}
