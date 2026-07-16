# Signal Sources

Local, deterministic adapters that feed the Signal Mining Agent
(`growth/agents/signal-mining-agent.ts`, step 1 of the fixed Growth Loop).
Every adapter implements the same provider-neutral interface
(`provider.ts`) and returns `SignalSourceRecord[]` — the Agent's own
deterministic, LLM-independent catalog of concise evidence units. No
adapter here calls an LLM, and no adapter here makes a network request.

## The adapter interface

```ts
interface SignalSourceContext {
  period: DateRange;
  campaign: CampaignInfo;
  now: string; // ISO timestamp, injectable for deterministic tests
}

interface SignalSourceAdapter {
  readonly name: string;
  collect(context: SignalSourceContext): Promise<SignalSourceRecord[]>;
}
```

`collect()` is `async` even though every current adapter is synchronous
internally — that's deliberate, so a future network-backed adapter (see
below) fits the same interface without a breaking change to the Agent.

## Current adapters

| Adapter | Input | What it produces |
| --- | --- | --- |
| `NormalizedGrowthSummaryAdapter` | An already-loaded, already-validated `GrowthSummary` (growth/types/growth-summary.ts) | GA4 acquisition/landing-page records, PostHog per-app/per-UTM records, Search Console query/page records (only when `search.status === "ok"`) |
| `GrowthLoopFeedbackAdapter` | An already-loaded, already-validated `GrowthLoopFeedback \| null` (growth/contracts/loop-feedback.ts) | One record per feedback instruction, always `confidence: "low"`, always disclosing it's a prior-decision instruction — not measured evidence |
| `ManualJsonSignalAdapter` | Already-validated `ManualSignalSourceRecord[]` (from `--manual-input`, see growth/README.md) | One record per manual entry, verbatim |

None of these adapters do file discovery or file reading themselves — the
CLI script (`growth/scripts/run-signal-mining.ts`) loads and validates each
input first (reusing `growth/lib/snapshot-discovery.ts` for the Growth
Summary, the same way `generate-growth-report.ts` does), then constructs the
adapter with the already-validated object. This mirrors how
`runGrowthReportAgent`/`runExperimentDecisionAgent` are handed an
already-loaded input rather than doing their own file I/O.

## Why no live external adapters yet

Reddit, X, Product Hunt, Google Trends, search-volume tools, competitor
crawling, and social scraping are all explicitly out of scope for this
version of the Signal Mining Agent — see growth/README.md's Signal Mining
section for the full list. Two reasons: (1) none of these have a confirmed,
authorized integration yet (API keys, ToS review, rate-limit handling), and
(2) building them now would make the Agent's core contract-assembly and
deduplication logic hard to test deterministically and offline. The
adapter interface above exists specifically so adding one later is additive,
not a rewrite.

## Adding a future adapter

1. Implement `SignalSourceAdapter` in a new file in this directory (e.g.
   `reddit-adapter.ts`).
2. Do the network/API call inside `collect()`, but still return
   `SignalSourceRecord[]` built the same way the current adapters do:
   deterministic `id` (via `deterministicId(...)` from `growth/lib/ids.ts`),
   concise `content` (not an entire raw payload), explicit `metrics` (never
   fabricated), and honest `quality.confidence`/`limitations`.
3. Register the new adapter alongside the existing three in
   `growth/scripts/run-signal-mining.ts` — the Agent
   (`growth/agents/signal-mining-agent.ts`) already accepts an arbitrary
   list of `SignalSourceRecord[]`, so nothing about its contract-assembly,
   deduplication, or validation logic needs to change.
4. Never put credentials, auth headers, or environment values into a
   `SignalSourceRecord` — see the "no credential storage in source records"
   rule below.

## No credential storage in source records

`SignalSourceRecord` (growth/types/signal-mining.ts) has no field for an API
key, token, or auth header, and none of the current adapters accept one as
part of a record. Manual input records are additionally validated
(`growth/signal-sources/manual-json-signal-adapter.ts`) to reject any
credential-shaped key (`apiKey`, `token`, `authorization`, `password`,
`secret`, `cookie`, `accessToken`) anywhere in the record, including nested
inside `metadata` — the whole record is rejected, not silently stripped. A
future live adapter must read its own credentials directly from
`process.env` inside its own module (the same pattern the PostHog/GA4/
Search Console collectors already use) and must never place a credential
value inside a `SignalSourceRecord` that gets embedded in
`FinalSignalMiningRun.sourceRecordCatalog` or sent to a provider.
