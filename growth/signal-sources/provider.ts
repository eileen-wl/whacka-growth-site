import type { CampaignInfo, DateRange } from "../types/growth-summary";
import type { SignalSourceRecord } from "../types/signal-mining";

/**
 * Provider-neutral contract for anything that can contribute
 * `SignalSourceRecord`s to a Signal Mining run. All three current adapters
 * (growth/signal-sources/normalized-growth-summary-adapter.ts,
 * growth-loop-feedback-adapter.ts, manual-json-signal-adapter.ts) are local
 * and deterministic — no network call. A future live adapter (Reddit, X,
 * Product Hunt, Google Trends, ...) implements this same interface without
 * changing growth/agents/signal-mining-agent.ts at all; see
 * growth/signal-sources/README.md for the extension boundary.
 */
export interface SignalSourceContext {
  period: DateRange;
  campaign: CampaignInfo;
  /** Injectable for deterministic tests; defaults to the current time where used. */
  now: string;
}

export interface SignalSourceAdapter {
  readonly name: string;
  collect(context: SignalSourceContext): Promise<SignalSourceRecord[]>;
}
