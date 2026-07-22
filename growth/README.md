# Growth data collectors, Normalizer, Growth Report Agent, and Experiment Decision Agent

Server-side scripts that pull raw growth-event data from external analytics
sources into dated local snapshots (`growth/data/raw/`), normalize them into
one processed growth-summary file (`growth/data/processed/`), generate an
LLM-assisted Growth Report from that summary (`growth/reports/`), and
finally produce an Experiment Decision from that report (`growth/decisions/`).
Nothing in this directory runs in the browser or ships with the Astro build.

Collectors implemented: **PostHog**, **GA4**, and **Search Console**. Whacka
conversion data is a future collector, not yet built. A deterministic
**Normalizer** turns those three raw snapshots into one processed
growth-summary file, which the **Growth Report Agent** reads to produce a
JSON + Markdown report, which the **Experiment Decision Agent** (see below)
in turn reads to record — but not execute — the next bounded experiment.

## PostHog collector

### Required environment variables

Set these in `.env` (see `.env.example`) — they are **server-side only**,
never prefixed with `PUBLIC_`, and never read by browser code:

| Variable | Description |
| --- | --- |
| `POSTHOG_PERSONAL_API_KEY` | A PostHog **Personal API Key** with read access to the project. |
| `POSTHOG_PROJECT_ID` | The numeric PostHog project ID to query. |
| `POSTHOG_API_HOST` | Your PostHog region's API host, e.g. `https://us.posthog.com`. |

### Personal API Key vs. project token

These are two different PostHog credentials — don't confuse them:

- **`PUBLIC_POSTHOG_KEY`** (`src/lib/posthog.ts`) is the **project API
  token**. It's safe to ship to the browser — it can only *send* events
  in, not read data out.
- **`POSTHOG_PERSONAL_API_KEY`** (this collector) is a **Personal API
  Key**, scoped to your PostHog user account. It can *read* data via the
  Query API and must never be exposed client-side, logged, or committed.
  Create one at PostHog under **Settings → Personal API Keys**.

### Running it

```bash
# Default: last 7 complete calendar days (UTC), ending yesterday
npm run growth:collect:posthog

# Custom range (ISO dates only, YYYY-MM-DD)
npm run growth:collect:posthog -- --start 2026-07-01 --end 2026-07-15

# Re-run the same range without creating a timestamped duplicate file
npm run growth:collect:posthog -- --start 2026-07-01 --end 2026-07-15 --overwrite
```

The collector queries PostHog's HogQL Query API (`POST
/api/projects/{id}/query/`) with a single aggregate query — it never
exports raw/bulk events. It counts these events only:

- `$pageview`
- `view_demo_click`
- `remix_click`
- `build_click`
- `copy_prompt_click`

grouped by `date`, `event`, `app_slug`, `app_name`, `page_type`,
`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, returning
`event_count` and `unique_users` (distinct `distinct_id`) per group.

### Output

Snapshots are written to:

```
growth/data/raw/posthog-{start}_to_{end}.json
```

containing the untouched PostHog API response (`results`/`columns`/
`types`/any other response metadata) plus collection metadata
(`source`, `collectedAt`, `period`, `queryName`). These files are
git-ignored (`growth/data/raw/*.json`) — only `.gitkeep` is committed, so
raw analytics data never lands in the repo.

If a snapshot for that exact date range already exists, the collector
**never overwrites it silently**: it either writes a new file with a
timestamp suffix, or overwrites in place if you pass `--overwrite`.

### Common errors

| Error | Cause |
| --- | --- |
| `Missing required environment variable(s): ...` | One of the three `POSTHOG_*` vars isn't set in `.env`. |
| `Invalid --start/--end date "..."` | A date wasn't `YYYY-MM-DD`, or isn't a real calendar date. |
| `--start (...) must not be after --end (...)` | The range is backwards. |
| `PostHog API responded with 401 ...` | The Personal API Key is invalid, expired, or lacks project access. |
| `PostHog API responded with 404 ...` | `POSTHOG_PROJECT_ID` doesn't match a project the key can access. |
| `Unexpected PostHog response shape: ...` | PostHog returned a response without a `results` array (e.g. an error payload with a different shape than expected). |

## GA4 collector

### Authentication prerequisite: Application Default Credentials

This collector authenticates with **local Application Default Credentials
(ADC)**, not a service-account key file. Before running it, log in once:

```bash
gcloud auth application-default login
```

`growth/collectors/ga4.ts` constructs `new BetaAnalyticsDataClient()` with
no explicit credentials — the Google client library discovers ADC on its
own (via `gcloud`'s cached login, a `GOOGLE_APPLICATION_CREDENTIALS` env
var, or the runtime's metadata server, in that order). There is no service-
account JSON file to download, store, or `.gitignore` for this collector,
and no manual OAuth client loading in this codebase.

The logged-in Google account/ADC principal needs **Viewer** access to the
GA4 property in Google Analytics (Admin → Property Access Management).

### Required environment variable

| Variable | Description |
| --- | --- |
| `GA4_PROPERTY_ID` | The **numeric** GA4 property ID (Admin → Property details), digits only — not the `G-XXXXXXX` measurement ID used by `gtag`/`PUBLIC_GA_MEASUREMENT_ID`. |

### Running it

```bash
# Default: last 7 complete calendar days (UTC), ending yesterday
npm run growth:collect:ga4

# Custom range (ISO dates only, YYYY-MM-DD)
npm run growth:collect:ga4 -- --start 2026-07-01 --end 2026-07-15

# Re-run the same range without creating a timestamped duplicate file
npm run growth:collect:ga4 -- --start 2026-07-01 --end 2026-07-15 --overwrite
```

Each run calls the GA4 Data API's `runReport` three times against
`properties/{GA4_PROPERTY_ID}`, all for the same date range:

| Report | Dimensions | Metrics |
| --- | --- | --- |
| `traffic_overview` | `date` | `sessions`, `activeUsers`, `screenPageViews`, `engagedSessions`, `engagementRate` |
| `traffic_acquisition` | `date`, `sessionSource`, `sessionMedium`, `sessionCampaignName` | `sessions`, `activeUsers`, `engagedSessions`, `engagementRate` |
| `landing_pages` | `date`, `landingPagePlusQueryString` | `sessions`, `activeUsers`, `screenPageViews`, `engagedSessions`, `engagementRate` |

### Output

Snapshots are written to:

```
growth/data/raw/ga4-{start}_to_{end}.json
```

containing `source`, `collectedAt`, `period`, `propertyId`, and one object
per report (`trafficOverview`, `trafficAcquisition`, `landingPages`), each
with that report's `headers` (dimension/metric names), `rows`, `rowCount`,
and any extra response metadata GA4 returned. Same collision convention as
the PostHog collector: an existing file for that exact range is never
overwritten silently — a timestamp suffix is used unless you pass
`--overwrite`. These files are git-ignored (`growth/data/raw/*.json`).

### Common errors

| Error | Cause |
| --- | --- |
| `Missing required environment variable: GA4_PROPERTY_ID` | Not set in `.env`. |
| `GA4_PROPERTY_ID must contain digits only ...` | You pasted the `G-XXXXXXX` measurement ID instead of the numeric property ID. |
| `Invalid --start/--end date "..."` / `--start (...) must not be after --end (...)` | Same date validation as the PostHog collector. |
| `GA4 runReport ("...") failed: ... 7 PERMISSION_DENIED ...` | Your ADC-logged-in account lacks Viewer access to this GA4 property. |
| `GA4 runReport ("...") failed: Could not load the default credentials ...` | You haven't run `gcloud auth application-default login` yet (or it expired). |
| `Unexpected GA4 response shape for report "...": ...` | GA4 returned a response without the expected headers/rows arrays. |

## Search Console collector

### Prerequisites

1. **Enable the API** for your Google Cloud project (one-time): visit
   https://console.developers.google.com/apis/api/searchconsole.googleapis.com
   and click Enable, or run:

   ```bash
   gcloud services enable searchconsole.googleapis.com
   ```

2. **Log in with the read-only scope** via Application Default Credentials:

   ```bash
   gcloud auth application-default login --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform
   ```

   Like the GA4 collector, `growth/collectors/gsc.ts` builds a
   `google.auth.GoogleAuth` client with no explicit credentials and lets
   the Google client library discover ADC on its own. There is no
   service-account JSON file, and no `secrets/google-oauth-client.json` or
   similar is read directly by this codebase.

3. The logged-in ADC principal needs access to the property in **Search
   Console → Settings → Users and permissions** (any permission level —
   Owner isn't required for read-only queries).

### Required environment variable: `GSC_SITE_URL`

Set this to your Search Console property **exactly** as it's registered —
this collector never adds or strips a trailing slash, since a mismatched
value won't resolve to your property at all. Two formats are accepted:

| Property type | Format | Example |
| --- | --- | --- |
| URL-prefix | `http://` or `https://`, including the trailing slash if that's how the property is registered | `https://example.com/` |
| Domain | `sc-domain:` followed by the bare domain (no protocol) | `sc-domain:example.com` |

A plain domain with no `sc-domain:` prefix (e.g. `example.com`) is
**rejected** — Search Console can't tell that apart from a malformed
URL-prefix property.

### Running it

```bash
# Default: last 7 complete Search Console calendar days, ending yesterday
npm run growth:collect:gsc

# Custom range (ISO dates only, YYYY-MM-DD)
npm run growth:collect:gsc -- --start 2026-07-01 --end 2026-07-15

# Re-run the same range without creating a timestamped duplicate file
npm run growth:collect:gsc -- --start 2026-07-01 --end 2026-07-15 --overwrite
```

**Important:** Search Console's date fields are defined by the API in
`America/Los_Angeles` time (PST/PDT), not UTC. The default range's
"yesterday" is computed on that calendar, so it can differ from the
PostHog/GA4 collectors' UTC-based default by a day depending on when you
run it.

Each run calls the Search Console Search Analytics `searchanalytics.query`
method four times against `siteUrl: GSC_SITE_URL`, all for the same date
range, `searchType: "web"`, `dataState: "all"` (includes not-yet-finalized
data, so the future normalizer can watch for it via each report's
`metadata.firstIncompleteDate`):

| Report | Dimensions |
| --- | --- |
| `daily_overview` | `date` |
| `queries` | `query` |
| `query_pages` | `query`, `page` |
| `pages` | `page` |

Each row keeps `keys`, `clicks`, `impressions`, `ctr`, and `position`
exactly as the API returns them — no aggregation or interpretation here.

### Pagination

Each report pages through results at the API's maximum `rowLimit` (25,000)
using `startRow`, stopping as soon as a page comes back with fewer than
25,000 rows (which includes an empty page). A 1,000-page safety cap
(25M rows) throws rather than looping forever if the API ever behaves
unexpectedly. Search Console's `rows` are the API's own top results for
the query — collecting every page it returns is not a guarantee that every
internal row imaginable has been retrieved.

### Output

Snapshots are written to:

```
growth/data/raw/gsc-{start}_to_{end}.json
```

containing `source`, `collectedAt`, `period`, `siteUrl`, and a `reports`
object with one entry per report (`dailyOverview`, `queries`,
`queryPages`, `pages`), each holding `dimensions`, `rows`, `rowCount`,
`responseAggregationType`, and `metadata`. Same collision convention as
the other collectors: an existing file for that exact range is never
overwritten silently — a timestamp suffix is used unless you pass
`--overwrite`. These files are git-ignored (`growth/data/raw/*.json`).

### Empty report behavior

A report with 0 rows is **not** treated as an error — it's saved as-is
(`rows: []`, `rowCount: 0`) and the CLI prints a warning per empty report
instead of failing. This is expected for a new site with no search
impressions yet, or for very recent dates that Search Console hasn't
finalized.

### Common errors

| Error | Cause |
| --- | --- |
| `Missing required environment variable: GSC_SITE_URL` | Not set in `.env`. |
| `GSC_SITE_URL "..." is not a valid Search Console property` | Value doesn't start with `http://`, `https://`, or `sc-domain:`, contains whitespace, or is a malformed URL. |
| `Invalid --start/--end date "..."` / `--start (...) must not be after --end (...)` | Same date validation as the other collectors. |
| `Search Console query ("...") failed: ... 403 ... insufficient authentication scopes ...` | Your ADC login didn't include `webmasters.readonly` — re-run the `gcloud auth application-default login --scopes=...` command above. |
| `Search Console query ("...") failed: ... 403 ... has not been used ... or it is disabled ...` | The Search Console API isn't enabled on your Google Cloud project — see Prerequisites. |
| `Search Console query ("...") failed: ... 403 ... does not have sufficient permission ...` | Your ADC-logged-in account isn't added as a user on this property in Search Console. |
| `Search Console query ("...") failed: ... 404 ...` | `GSC_SITE_URL` doesn't match a property that exists (or the account can't see it). |
| `GSC_SITE_URL "..." is not a valid Search Console property` (again) | You passed a bare domain instead of a full URL-prefix or `sc-domain:` value. |
| Empty `rows` in the saved snapshot | Not an error — see "Empty report behavior" above. |

## Normalizer

### What it is, and why Agents should read it instead of raw platform files

The three collectors above each speak their source's native API shape:
PostHog's grouped HogQL rows, GA4's `dimensionValues`/`metricValues` arrays
with `YYYYMMDD` dates, Search Console's `keys` arrays. That's fine for a
collector — it's just relaying what the API said — but it's the wrong
shape for anything that reasons about the data. Three different date
formats, three different "what counts as a unique user" answers, and three
different empty/missing conventions is a lot of platform-specific trivia
to re-derive correctly every time something needs "sessions this week."

`growth/normalizers/growth-summary.ts` (invoked by
`growth/scripts/normalize-growth-data.ts`) is a **deterministic,
non-LLM** transform: same three raw snapshots in, same processed JSON out,
every time. It does the boring-but-easy-to-get-wrong parts once — additive
sums vs. recomputed rates vs. "this can't be safely summed, so it's
`null`" — so the future Growth Report Agent (and Experiment Decision
Agent) can read one stable schema instead of three raw API shapes, and so
that reasoning about "why is this number what it is" never depends on an
LLM's arithmetic. See `growth/types/growth-summary.ts` for the full output
type.

### Required raw files and the matching date-range requirement

The normalizer looks for exactly one raw snapshot per source for the
**requested** `--start`/`--end` range:

```
growth/data/raw/posthog-{start}_to_{end}*.json   (required)
growth/data/raw/ga4-{start}_to_{end}*.json       (required)
growth/data/raw/gsc-{start}_to_{end}*.json       (optional)
```

The `*` matches the collision-safe timestamp suffix collectors append when
a snapshot for that range already exists (see each collector's "Collision
handling" above) — if more than one matches, the one with the latest
`collectedAt` is used, and the CLI prints a notice saying which file it
picked. PostHog and GA4 are required for v0 and normalization **fails
immediately**, naming the expected filename and date range, if either is
missing. Search Console is optional: a missing file is accepted with a
warning (`inputs.searchConsole.status: "missing"`); a file whose four
reports all have zero rows is also accepted, marked `"empty"` instead of
`"missing"`.

Every selected snapshot's own `period` field is checked against the
requested range — a raw file that doesn't actually cover the range you
asked for is rejected rather than silently normalized as if it did.

### Running it

```bash
npm run growth:normalize -- --start 2026-07-08 --end 2026-07-14

# Optional: override the default campaign metadata
npm run growth:normalize -- --start 2026-07-08 --end 2026-07-14 \
  --campaign-id small_business_toolkit_v0 \
  --campaign-name "Small Business Mini App Toolkit"

# Re-run the same range without creating a timestamped duplicate file
npm run growth:normalize -- --start 2026-07-08 --end 2026-07-14 --overwrite
```

`--start`/`--end` are required (ISO `YYYY-MM-DD`) — unlike the collectors,
there's no "last 7 days" default here, since guessing a range risks
silently normalizing against raw files that don't exist for it.

### Output

```
growth/data/processed/growth-summary-{start}_to_{end}.json
```

Same collision convention as the collectors: an existing summary for that
exact range is never overwritten silently — a timestamp suffix is used
unless you pass `--overwrite`. These files are git-ignored
(`growth/data/processed/*.json`).

### What "partial" data quality means

`dataQuality.overallStatus` is almost always `"partial"` right now, and
that's expected, not a bug. It reflects real, current measurement gaps —
not a broken pipeline:

- Whacka product-side conversion data (signups, first app created, app
  published) isn't connected yet — `productConversions.status` is always
  `"not_connected"` and those fields are always `null`, never `0`.
- Search Console may have no data yet for a brand-new property, or may be
  missing for the range.
- Certain unique-user metrics genuinely cannot be derived from the current
  raw snapshots (see below) — they're `null` with an explanatory note
  rather than a wrong number.

`overallStatus` is `"complete"` only when none of the above apply and
there are zero data-quality warnings; it's `"invalid"` if a selected
snapshot's period didn't actually match the requested range (defense in
depth — the loader already rejects this before normalization runs).

### Why `activeUsers` and grouped unique-user counts need special handling

Both GA4 and PostHog can tell you "how many distinct people did X on day
N," but neither raw snapshot gives you "how many distinct people did X
across the whole period" for free — and naively adding up the daily/grouped
numbers produces a number that's too high, silently, with no indication
anything's wrong:

- **GA4 `activeUsers`**: the same visitor can be active on multiple days
  within the range, so summing `trafficOverview`'s daily `activeUsers`
  rows double-counts them. The normalizer only reports
  `traffic.overview.activeUsers` when GA4's response includes a genuine
  period-level total (via `metricAggregations`, which the current
  collector doesn't request); otherwise it's `null` with
  `activeUsersMeasurementNote` explaining why, plus a data-quality warning.
- **PostHog grouped `unique_users`**: the raw snapshot's `unique_users`
  column is a per-*group* distinct count (grouped by date/event/app/utm/…),
  and the same `distinct_id` can appear in multiple groups (e.g. one
  person who both viewed a demo and copied a prompt). Summing those grouped
  values isn't a valid site-wide unique-user count, so
  `behavior.uniqueUsers` is always `null` in the current design, with
  `uniqueUsersMeasurementNote` and a matching warning.

Event *counts* (not user counts) are safe to sum in both cases, because
the grouped/daily rows partition the underlying events — that's why
`eventTotals`, `traffic.overview.sessions`, etc. are ordinary additive
sums.

### Current Whacka attribution placeholder

`productConversions` (`signups`, `firstAppCreated`, `appPublished`) is
always `null` with `status: "not_connected"` — this is a placeholder for a
not-yet-built Whacka product-side collector, not a real "zero conversions"
result. Never treat these `null`s as `0`; a future collector will populate
them once Whacka's product-side attribution is connected.

## Growth Report Agent

### Role in the fixed Growth Loop, and how it differs from the Experiment Decision Agent

This is step 7 of the confirmed Growth Loop, reading the Normalizer's
output (step 6) and preparing inputs for the Experiment Decision Agent
(step 8, not yet built). Its job is **explanation, not decision**:

- It explains what the evidence shows for the period — observed facts,
  interpretations, data limitations — and packages `decisionInputs`
  (signals worth reviewing, open questions) for the next agent.
- It never picks the next experiment, topic, CTA, or distribution channel.
  The system prompt explicitly forbids this (see below), and the schema
  has no field for "next action" — there's nowhere to put one even if the
  model tried.
- The **Experiment Decision Agent** (future) is the one that reads this
  report's `decisionInputs` and actually decides what to try next. Keeping
  the boundary strict means the evidence-grounded explanation step can't
  be silently skipped or short-circuited by an eager "just tell me what to
  do next" prompt.

### Why it reads normalized data, not raw platform files

The Agent only ever reads one `growth-summary-*.json` file — never
`posthog-*.json`/`ga4-*.json`/`gsc-*.json` directly. The Normalizer already
resolved every platform-specific quirk (GA4's `YYYYMMDD` dates, PostHog's
per-group `unique_users`, three different "empty data" conventions) into
one stable schema with additive-safe metrics and explicit `null`s where a
number can't be safely derived. Reading raw files here would mean
re-deriving that logic (and re-introducing its failure modes) a second
time, in a prompt, where mistakes are invisible until a report reads badly.

### Provider-neutral architecture

```
growth/agents/growth-report-agent.ts   — orchestration; imports only growth/llm/provider.ts's
                                          LLMProvider interface, never an SDK directly
growth/llm/provider.ts                 — the LLMProvider interface + shared error types
growth/llm/mock-provider.ts            — no API key, no network call, schema-valid output
growth/llm/anthropic-provider.ts       — the only file that imports @anthropic-ai/sdk
growth/prompts/growth-report-prompt.ts — system/user prompt construction (provider-agnostic)
growth/renderers/growth-report-markdown.ts — pure JSON -> Markdown renderer (never LLM-generated)
```

Swapping providers is a constructor call, not a rewrite: `new
MockGrowthReportProvider()` or `new AnthropicGrowthReportProvider({ apiKey,
model })`, both satisfying the same `LLMProvider` interface. The evidence
catalog (deterministic facts derived from the growth summary, each with a
stable `id`) is the only thing the model is allowed to cite — it never
recalculates a metric or invents one.

### Why the Anthropic SDK is wired up even though there's no API key yet

`@anthropic-ai/sdk` is a real dependency and `anthropic-provider.ts` is
fully implemented — using `client.messages.parse()` with
`output_config.format: zodOutputFormat(growthReportAnalysisSchema)` for
structured output — but nothing about *importing* that module or
*constructing* an `AnthropicGrowthReportProvider` requires a key: the real
`Anthropic` client is only constructed lazily, inside `generateStructuredReport()`,
and only when no test client was injected. This means the live path is
fully built, type-checked, and unit-tested (with the SDK's error classes
thrown from a mocked client) today, and becomes usable the moment
`ANTHROPIC_API_KEY` and `GROWTH_REPORT_MODEL` are set — no code changes.

**Claude Code being installed or logged in on this machine does not
provide `ANTHROPIC_API_KEY` to this application.** Claude Code's own
credentials are separate from — and inaccessible to — this Node script;
`ANTHROPIC_API_KEY` must be an Anthropic API key set explicitly in `.env`.

### Running it

```bash
# Dry run: loads the summary, builds the evidence catalog and prompts,
# writes a request preview — makes no provider call, needs no key/model.
npm run growth:report -- --start 2026-07-08 --end 2026-07-14 --dry-run

# Full local pipeline with the Mock Provider — no key, no network call,
# exercises every step through JSON + Markdown output.
npm run growth:report -- --start 2026-07-08 --end 2026-07-14 --provider mock

# Future live run, once ANTHROPIC_API_KEY and GROWTH_REPORT_MODEL are set
# and GROWTH_REPORT_LLM_PROVIDER=anthropic in .env:
npm run growth:report -- --start 2026-07-08 --end 2026-07-14

# Other flags: --input <file> (use an exact summary file instead of
# discovery), --language en|zh-CN (default en), --overwrite
```

### Required live environment variables

| Variable | Required for |
| --- | --- |
| `GROWTH_REPORT_LLM_PROVIDER=anthropic` | Selecting Anthropic as the default provider for a plain `npm run growth:report` (no `--provider` flag). `--provider mock` and `--dry-run` ignore this. |
| `GROWTH_REPORT_MODEL` | Any live Anthropic call. Left blank in `.env.example` on purpose — the model isn't confirmed yet, and this script never hardcodes a default. |
| `ANTHROPIC_API_KEY` | Any live Anthropic call. Never required for `--dry-run` or `--provider mock`. |
| `GROWTH_REPORT_MAX_TOKENS` | Optional, defaults to `6000`. |

### Output locations

```
growth/data/processed/growth-report-request-{start}_to_{end}.json   (--dry-run preview)
growth/reports/growth-report-{start}_to_{end}.json                  (Mock/live run)
growth/reports/growth-report-{start}_to_{end}.md                    (Mock/live run)
```

Same collision convention as every other script here: an existing file for
that exact range is never overwritten silently — a timestamp suffix is
used unless you pass `--overwrite`. JSON/Markdown reports are written
atomically (write-to-temp-file-then-rename) so a failed write can't leave
a truncated file behind. Generated reports are git-ignored
(`growth/reports/*.json`, `growth/reports/*.md`) — only `.gitkeep` is
committed.

### The evidence-reference mechanism

Every fact the model can cite lives in a deterministic **evidence
catalog** built from the growth summary before any provider is called —
entries like `traffic.sessions`, `behavior.total_cta_clicks`,
`search.top_query.1`, each with a stable `id`, `label`, `value`, `source`,
and `measurementBasis`. The model's structured response must cite these
IDs in every `evidenceRefs` array instead of retyping numbers or inventing
a metric path. After the response comes back, the Agent:

1. Validates it against the Zod schema (required for the Mock Provider,
   which skips the Anthropic SDK's own client-side schema parsing).
2. Confirms every cited evidence ID actually exists in the catalog —
   unknown IDs reject the whole response; nothing is silently dropped.
3. Requires at least one `dataLimitations` entry whenever data quality
   isn't `"complete"`.

Any failure here means **no final report is written** — the Markdown
renderer then resolves each cited ID back to its label/value/source, so
every claim in the report is traceable to a specific measured number.

### Partial-data and empty-Search-Console behavior

A `"partial"` `dataQuality.overallStatus` from the Normalizer is
**accepted**, not rejected — only `"invalid"` is refused (see the
Normalizer section above for what triggers each status). In practice
`"partial"` is the expected/common case today, since GA4's period-level
`activeUsers` and PostHog's site-wide unique-user count are both
unavailable by design. When Search Console is `"empty"` or `"missing"`,
the evidence catalog still includes `search.status` reflecting that, the
system prompt explicitly instructs the model to acknowledge it, and the
Mock Provider adapts its own placeholder text to the same status. Whacka
product-side conversions are always `null`/`"not_connected"` for the same
reason — the system prompt forbids treating that as "zero" or fabricating
a number for it.

### Common errors

| Error | Cause |
| --- | --- |
| `growth:report requires --start and --end ...` | Missing `--start`/`--end` (required even with `--input`). |
| `No normalized growth summary found for ... — run growth:normalize for this range first.` | No matching `growth-summary-*.json` in `growth/data/processed/`. |
| `"..." does not match the expected normalized growth-summary schema.` | The input file isn't shaped like a Normalizer output (or isn't a growth summary at all). |
| `... has dataQuality.overallStatus = "invalid" ...` | The summary itself is invalid (its inputs' periods didn't match); `"partial"` is fine, `"invalid"` is refused. |
| `Growth summary snapshot's period (...) does not match the requested period (...)` | The selected/`--input` file covers a different date range than `--start`/`--end`. |
| `No LLM provider configured. Pass --provider mock ...` | Neither `--provider` nor `GROWTH_REPORT_LLM_PROVIDER` is set, and this isn't a dry run. |
| `ANTHROPIC_API_KEY is required for a live Anthropic run ...` | Live Anthropic mode without a key. |
| `GROWTH_REPORT_MODEL is required for a live Anthropic run ...` | Live Anthropic mode without a model. |
| `Anthropic rejected the request: authentication failed ...` | The API key is invalid/revoked. |
| `Anthropic refused to generate a structured report ...` / `... was truncated at the max_tokens limit ...` | `stop_reason` was `refusal` / `max_tokens` — see growth/llm/anthropic-provider.ts. |
| `Model response referenced unknown evidence ID(s): ...` | The model cited an ID not in the evidence catalog — the report is rejected, not patched. |
| `Model response did not match the required schema: ...` | Zod validation failed (bad enum, unknown key, too-short array, etc.). |

## Experiment Decision Agent

### Role in the fixed Growth Loop, and how it differs from the Growth Report Agent

This is step 8 of the confirmed Growth Loop — the last step before results
feed back into the next Signal Mining / Topic Pool cycle:

1. Signal Mining Agent · 2. Topic Scoring Agent · 3. Asset Generation Agent ·
4. CMS Writer · 5. Growth Site Engine · 6. Tracking Layer ·
**7. Growth Report Agent** · **8. Experiment Decision Agent** ·
9. results return to the next Signal / Topic Pool cycle

The two LLM agents have a strict, deliberate division of labor:

- **Growth Report Agent** *explains what happened* — observed facts,
  interpretations, disclosed limitations, and a set of decision inputs. It
  never picks a next step.
- **Experiment Decision Agent** *chooses or defers* the next bounded
  experiment, using only that report's evidence, findings, and limitations
  as its inputs. It compares evidence-backed options, ranks them, and
  either recommends exactly one or explicitly defers — but it **records** a
  decision, it does not **execute** one. There is no code path anywhere in
  this Agent that publishes an experiment, edits the CMS, changes the site,
  or picks a distribution channel; every decision file it writes carries
  `humanReview.required: true` and `humanReview.approved: false` by
  construction.

### Why it reads the final Growth Report, not raw analytics

Like the Growth Report Agent reads the Normalizer's output instead of raw
platform files, the Experiment Decision Agent reads only the **final
Growth Report JSON** (`growth/reports/growth-report-*.json` — never the
`.md` brief, and never `growth-summary-*.json` or any raw PostHog/GA4/
Search Console snapshot). The report already did the work of turning
platform-specific data into evidence-graded findings with disclosed
limitations; re-deriving that from raw data a second time inside a
decision prompt would just reintroduce the same failure modes (wrong
date formats, double-counted unique users, event-count-as-conversion-rate
mistakes) in a second, harder-to-audit place.

### Why it may defer instead of always recommending something

`decisionStatus` is `"proceed"` or `"defer"` — deferring is a **valid,
expected outcome**, not a failure mode, and the system prompt says so
explicitly. Examples of when deferring is the right call: the source
Growth Report is mock-generated, there's almost no traffic, no topic/CTA
shows meaningful variation, channel attribution is absent, Search Console
is empty and the decision would depend on it, or the evidence supports
multiple incompatible interpretations. A deferred decision still explains
what's missing (`deferDecision.missingEvidence`), what to observe next
(`requiredNextObservations`), and what would unblock a real decision
(`earliestDecisionCondition`) — it's a structured "not yet," not silence.

### Why it cannot invent a new topic or channel before Signal Mining

`decisionScope` (`availableTopics`, `availableCtaTypes`, `availableChannels`)
is built **deterministically from the Growth Report's own metrics** —
observed app slugs/names (excluding the synthetic `"unassigned"` bucket),
CTA types with at least one observed click this period, and GA4/PostHog
channel combinations that actually appear in the data. The system prompt
forbids targeting anything outside this scope, and the Agent's own
validation rejects a response that tries. Discovering genuinely new topics
or channels is Signal Mining's job (step 1) — by the time this Agent runs,
that discovery hasn't happened yet for anything not already observed, so
proposing e.g. a TikTok channel or an unbuilt app here would be
unfounded, not evidence-backed.

### Provider-neutral architecture (shared with the Growth Report Agent)

```
growth/agents/experiment-decision-agent.ts       — orchestration; imports only
                                                    growth/llm/experiment-decision-provider.ts's
                                                    interface, never an SDK directly
growth/llm/experiment-decision-provider.ts       — the ExperimentDecisionProvider interface
                                                    (re-exports the same LLMProviderConfigError/
                                                    LLMProviderResponseError as the Growth Report Agent)
growth/llm/mock-experiment-decision-provider.ts  — no API key, no network call
growth/llm/anthropic-experiment-decision-provider.ts — the only file here that imports @anthropic-ai/sdk
growth/llm/anthropic-structured-client.ts        — shared by BOTH Anthropic providers: client
                                                    construction, structured-call execution, and
                                                    SDK error sanitization live here exactly once
growth/prompts/experiment-decision-prompt.ts     — system/user prompt construction
growth/renderers/experiment-decision-markdown.ts — pure JSON -> Markdown renderer
```

Building this Agent required one small, behavior-preserving refactor of
the existing Growth Report Agent infrastructure: `SupportedLanguage` and
`LLMStructuredResult<T>` moved to a task-neutral `growth/types/llm.ts`
(re-exported from `growth/types/growth-report.ts` unchanged, so nothing
importing them broke), and the Growth Report Agent's Anthropic client
construction / structured-request execution / error-mapping logic moved
into the new shared `anthropic-structured-client.ts`, with
`AnthropicGrowthReportProvider` becoming a thin wrapper around it. The
Growth Report Agent's public API, CLI, output schema, filenames, and full
test suite (122 tests) were re-verified unchanged after the refactor.

### Environment variables and fallback resolution

Reuses `ANTHROPIC_API_KEY`. Provider and model each resolve through a
fallback chain, so both agents use the same Anthropic provider/model by
default while still allowing a separate decision-specific one later:

| Setting | Resolution order |
| --- | --- |
| Provider | `--provider` flag → `EXPERIMENT_DECISION_LLM_PROVIDER` → `GROWTH_REPORT_LLM_PROVIDER` → configuration error (live runs only) |
| Model | `EXPERIMENT_DECISION_MODEL` → `GROWTH_REPORT_MODEL` → configuration error (live Anthropic runs only) |
| Max tokens | `EXPERIMENT_DECISION_MAX_TOKENS` → defaults to `6000` |

`--dry-run` and `--provider mock` need none of this — no provider, model,
or API key required.

### Running it

```bash
# Dry run: loads the Growth Report, builds the decision scope and
# catalogs, writes a request preview — no provider call, no key/model needed.
npm run growth:decide -- --start 2026-07-08 --end 2026-07-14 --dry-run

# Full local pipeline with the Mock Provider — no key, no network call.
npm run growth:decide -- --start 2026-07-08 --end 2026-07-14 --provider mock

# Future live run, once ANTHROPIC_API_KEY and a resolved model are set:
npm run growth:decide -- --start 2026-07-08 --end 2026-07-14

# Other flags: --input <file>, --language en|zh-CN (default en), --overwrite,
# --allow-mock-input (see below)
```

### `--allow-mock-input`

The source Growth Report's `generation.isMock` flag records whether *that*
report came from the Mock Provider. Both `--dry-run` and `--provider mock`
may freely consume a mock-generated Growth Report (useful for pipeline
testing) — but a **live Anthropic run refuses a mock-generated Growth
Report by default**, since recommending a real experiment from placeholder
analysis would be misleading. Pass `--allow-mock-input` to override this
for explicit testing only. Every decision file's `provenance.sourceGrowthReportIsMock`
records the source report's mock status regardless, and the Markdown brief
surfaces it prominently.

### Output locations

```
growth/data/processed/experiment-decision-request-{start}_to_{end}.json   (--dry-run preview)
growth/decisions/experiment-decision-{start}_to_{end}.json                (Mock/live run)
growth/decisions/experiment-decision-{start}_to_{end}.md                  (Mock/live run)
```

Same collision convention as every other script here — timestamp suffix
unless `--overwrite` — and the same atomic (write-temp-then-rename) file
writes. Generated decisions are git-ignored (`growth/decisions/*.json`,
`growth/decisions/*.md`); only `.gitkeep` is committed.

### Evidence, finding, and limitation reference validation

The Agent never lets the model invent an ID. Three catalogs are built
deterministically before any provider call:

- **Evidence catalog** — reused directly from the source Growth Report,
  unmodified.
- **Finding catalog** — the Growth Report's own findings, wrapped with
  stable IDs (`finding.{growthReportFindingId}`).
- **Limitation catalog** — deterministic, code-derived limitations:
  `data_limit.product_conversions_not_connected` (always present),
  `data_limit.search_console_empty` / `data_limit.search_console_missing`
  (when applicable), `data_limit.mock_growth_report` (when the source
  report is mock), `data_limit.partial_data_quality` (when data quality
  is `"partial"`), plus the Growth Report's own disclosed
  `dataLimitations` carried over under `data_limit.from_report.*` IDs.

After the model responds, the Agent checks — and rejects the whole
response, writing nothing, if any check fails — that: every
`evidenceRefs`/measurement-metric reference exists in the evidence
catalog and is numeric (not a categorical value like `"ok"`); every
`findingRefs` value exists in the finding catalog; every `limitationRefs`
value exists in the limitation catalog; every non-null `target.topicOrApp`/
`ctaType`/`channel` exists in `decisionScope`; option ranks are unique and
sequential from 1; option IDs are unique; and the `proceed`/`defer` fields
are internally consistent (e.g. `proceed` requires a non-null
`recommendedExperiment` whose `experimentId` matches an actual option,
`defer` requires both to be null).

### Human-review requirement

Every decision file's `humanReview` object is fixed by the Agent, never by
the model: `required: true`, `approved: false`, `approvedBy: null`,
`approvedAt: null`. There is no code in this Agent (or anywhere in this
codebase yet) that flips `approved` to `true` or acts on a decision —
approval and execution are out of scope for this step, by design.

### Known limitations this Agent explicitly respects

- **Search Console empty**: if `search.status` is `"empty"` or
  `"missing"`, the system prompt forbids recommending a topic based on
  claimed search demand or SEO performance, and a
  `data_limit.search_console_*` entry is always added to the limitation
  catalog when applicable.
- **Whacka product attribution missing**: `signups`/`firstAppCreated`/
  `appPublished` are always `null` — the prompt forbids optimizing for
  them or treating `null` as `0`, and
  `data_limit.product_conversions_not_connected` is always in the
  limitation catalog.
- **Event-based CTA ratio**: `behavior.event_based_cta_rate` (from the
  Growth Report) may be used as a proxy engagement metric, but the prompt
  requires it be labeled an event-count ratio — never a user or session
  conversion rate.

### Common errors

| Error | Cause |
| --- | --- |
| `growth:decide requires --start and --end ...` | Missing `--start`/`--end` (required even with `--input`). |
| `No Growth Report found for ... — run growth:report for this range first.` | No matching `growth-report-*.json` in `growth/reports/`. |
| `"..." does not match the expected Growth Report schema ...` | The input file isn't shaped like a Growth Report Agent output. |
| `"..." contains evidenceRefs not present in its own evidenceCatalog: ...` | The source Growth Report itself is internally inconsistent — rejected before any decision is attempted. |
| `... has dataQuality.overallStatus = "invalid" ...` | The source report's own data quality was invalid; `"partial"` is fine, `"invalid"` is refused. |
| `Growth Report snapshot's period (...) does not match the requested period (...)` | The selected/`--input` file covers a different date range than `--start`/`--end`. |
| `The selected Growth Report ("...") was mock-generated ... pass --allow-mock-input to override` | Live Anthropic mode with a mock-generated source report and no override. |
| `No LLM provider configured. Pass --provider mock ...` | No provider resolved from `--provider`, `EXPERIMENT_DECISION_LLM_PROVIDER`, or `GROWTH_REPORT_LLM_PROVIDER`, and this isn't a dry run. |
| `No Anthropic model resolved (checked EXPERIMENT_DECISION_MODEL, then GROWTH_REPORT_MODEL) ...` | Live Anthropic mode with neither model variable set. |
| `Model response referenced unknown evidence ID(s)/finding ID(s)/limitation ID(s): ...` | The model cited an ID outside the supplied catalogs — rejected, not patched. |
| `... targets a topic/app/CTA type/channel ("...") outside the supplied decision scope.` | The model proposed something not actually observed in the Growth Report. |
| `Model response did not match the required schema: ...` | Zod validation failed (bad enum, unknown key, wrong array length, etc.). |

## Front-Half Contracts

`growth/contracts/` defines the shared data contracts for the front half of
the fixed Growth Loop (steps 1–5) — **not an Agent itself**, and no Agent for
Signal Mining, Topic Scoring, Asset Generation, or the CMS Writer exists yet.
This directory only provides the strict Zod v4 schemas, TypeScript types,
deterministic ID/compatibility helpers, and offline tests those future
Agents will build on:

```
SignalCandidate
→ TopicCandidate
→ ScoredTopic
→ AssetBundle
→ CMSWriteRequest
→ Sanity draft
→ Astro

ExperimentDecision
→ GrowthLoopFeedback
→ Signal Mining / Topic Pool
```

Highlights (full detail in `growth/contracts/README.md`):

- `AssetBundle.app` maps field-for-field to the real Sanity `appTool`
  schema (`studio/schemaTypes/appTool.ts`) and frontend `AppData` type
  (`src/data/apps.ts`) — every field Sanity requires is required here too.
  One discovered gap: Sanity has no SEO-specific fields today, so
  `AssetBundle.seo.*` (besides `faq`, which does map) can't yet be
  persisted by a `CMSWriteRequest`.
- `CMSWriteRequest` is a request, not a write — nothing in this directory
  calls `@sanity/client`. It's always `payload.status: "draft"` and
  `publishing: { publishRequested: false, publishAllowed: false }`, pinned
  to the literal `false` so no code path in this version can flip either.
- `buildGrowthLoopFeedback(finalExperimentDecision, options)` is a pure,
  deterministic adapter (no LLM/network/file-write) that turns step 8's
  output into input for the next Signal Mining / Topic Pool cycle —
  preserving proceed/defer status, `isMock`, and every evidence/finding/
  limitation reference verbatim from the source decision.
- Every contract carries `schemaVersion`, and every `validate*()` function
  rejects an unsupported major version clearly (`UnsupportedSchemaVersionError`)
  rather than silently misreading a breaking-changed document.

## Signal Mining Agent

### Role in the fixed Growth Loop, and how it differs from Topic Scoring

This is step 1 — the first step of the loop, and the one step 9 (results
returning to "the next Signal / Topic Pool cycle") feeds back into:

```
**1. Signal Mining Agent** · 2. Topic Scoring Agent · 3. Asset Generation Agent ·
4. CMS Writer · 5. Growth Site Engine · 6. Tracking Layer ·
7. Growth Report Agent · 8. Experiment Decision Agent ·
9. results return to the next Signal / Topic Pool cycle → back to step 1/2
```

Its job is **mining and normalizing, not judging**:

- It collects currently-available opportunity signals from local,
  deterministic sources (see below), converts them into validated
  `SignalCandidate` contracts, deduplicates them, and clusters validated
  signals into a `TopicCandidate` topic pool.
- It never scores, ranks, or decides advance/hold/reject for a topic — the
  system prompt explicitly forbids this, and neither the structured schema
  nor the final output has anywhere to put a score. That's the **Topic
  Scoring Agent**'s job (future work, not built yet).
- It never generates app content, SEO copy, or social copy — that's the
  **Asset Generation Agent**'s job (future work, not built yet).
- It never writes to Sanity or touches the Astro site.

### Currently supported local sources

Three local, deterministic adapters (`growth/signal-sources/` — see that
directory's own README for the adapter interface and how to add a future
one):

| Adapter | Reads | 
| --- | --- |
| `NormalizedGrowthSummaryAdapter` | An already-loaded, already-validated `GrowthSummary` (`growth-summary-{start}_to_{end}.json`) — GA4 acquisition/landing-page rows, PostHog per-app/per-UTM rows, Search Console query/page rows |
| `GrowthLoopFeedbackAdapter` | An already-loaded, already-validated `GrowthLoopFeedback` (see below) |
| `ManualJsonSignalAdapter` | An already-validated `--manual-input` JSON file (see below) |

### Why live external adapters are not enabled yet

Reddit, X, Product Hunt, Google Trends, search-volume tools, competitor
crawling, and social scraping are all explicitly out of scope for this
version — none has a confirmed, authorized integration yet (API access,
ToS review, rate-limit handling), and building the Agent's core
contract-assembly/deduplication logic against live network sources would
make it impossible to test deterministically and offline. See
`growth/signal-sources/README.md` for exactly how a future adapter plugs
into the same `SignalSourceAdapter` interface without changing the Agent.

### Growth Summary input behavior

Reads only the normalized `growth-summary-{start}_to_{end}*.json` (never
raw PostHog/GA4/Search Console snapshots directly) — same discovery
convention as the Growth Report Agent (`--summary <path>` bypasses
discovery, otherwise the latest-`generatedAt` match in
`growth/data/processed/` is selected). A `"partial"` `dataQuality`
status is accepted; `"invalid"` is refused. When Search Console is
`"empty"` or `"missing"`, zero query/page source records are produced —
never a fabricated keyword signal — and the empty/missing status is
preserved as a factual data-quality warning instead.

### GrowthLoopFeedback input behavior

`--feedback <path>` loads and validates one `GrowthLoopFeedback` (see the
Front-Half Contracts section above); when omitted, the CLI looks for
`growth/decisions/growth-loop-feedback-{start}_to_{end}*.json` and
continues without it (non-fatal notice) if none exists — nothing currently
writes such a file, so in practice this just means "no feedback" today.
Feedback is **an instruction and constraint source, not measured demand
evidence** — its instructions become low-confidence source records (via
`GrowthLoopFeedbackAdapter`) explicitly disclosing they're carried over
from a prior Experiment Decision, and its `constraints`
(`allowedTopics`/`allowedCtaTypes`/`allowedChannels`/`mustCollectEvidence`/
`mustNotClaim`) are passed to the model as context, never as something it
cites as evidence.

### Mock feedback behavior

`GrowthLoopFeedback.sourceDecision.isMock` records whether the underlying
Experiment Decision was mock-generated. `--dry-run` and `--provider mock`
may freely consume mock feedback. A **live Anthropic run refuses
mock-generated feedback by default** — pass `--allow-mock-input` to
override for explicit testing. `FinalSignalMiningRun.provenance.sourceFeedbackIsMock`
always records this regardless, and the Markdown review surfaces it
prominently.

### Manual JSON input format

`--manual-input <path>` accepts a JSON file containing either a bare array
of records or `{ "records": [...] }`. See
`growth/data/manual/signal-input.example.json` for a copyable template.
Each record:

```json
{
  "id": "optional_external_id",
  "sourceType": "mentor_input",
  "sourceName": "Weekly mentor meeting",
  "title": "SMBs repeatedly ask for WhatsApp order handling",
  "text": "Full source note or observation",
  "url": null,
  "publishedAt": null,
  "capturedAt": "2026-07-15T18:00:00.000Z",
  "tags": ["whatsapp", "orders", "smb"],
  "metrics": [],
  "metadata": {}
}
```

`sourceType` is one of `mentor_input`, `user_feedback`, `manual`,
`competitor_page`, `social_discussion`, `keyword_source`, `product_request`,
`research_note`. `sourceType`/`sourceName`/`title`/`text` are required;
`url` must be a valid URL when present; timestamps must be valid ISO 8601.
A record containing a credential-shaped key (`apiKey`, `token`,
`authorization`, `password`, `secret`, `cookie`, `accessToken` — at any
nesting depth, including inside `metadata`) is rejected outright, naming
its index — never silently stripped. `metadata` is validated but never
forwarded to a provider. CSV input is not supported in this version.

### Running it

```bash
# Dry run: loads inputs, builds the deterministic source record and
# existing content catalogs, writes a request preview — no provider call.
npm run growth:signals -- --start 2026-07-08 --end 2026-07-14 --dry-run

# Full local pipeline with the Mock Provider — no key, no network call.
npm run growth:signals -- --start 2026-07-08 --end 2026-07-14 --provider mock

# Future live run, once ANTHROPIC_API_KEY and a resolved model are set:
npm run growth:signals -- --start 2026-07-08 --end 2026-07-14

# Other flags: --summary <path>, --feedback <path>, --manual-input <path>,
# --language en|zh-CN (default en), --overwrite, --allow-mock-input
```

### Required live environment variables

| Variable | Resolution |
| --- | --- |
| Provider | `--provider` → `SIGNAL_MINING_LLM_PROVIDER` → `GROWTH_REPORT_LLM_PROVIDER` → configuration error (live runs only) |
| Model | `SIGNAL_MINING_MODEL` → `GROWTH_REPORT_MODEL` → configuration error (live Anthropic runs only) |
| `SIGNAL_MINING_MAX_TOKENS` | Optional, defaults to `8000`. |
| `SIGNAL_MINING_MAX_SOURCE_RECORDS` | Optional, defaults to `100` — the maximum source records used per run; higher-volume records are kept deterministically when the collected count exceeds this. |
| `ANTHROPIC_API_KEY` | Any live Anthropic call. Never required for `--dry-run` or `--provider mock`. |

### Output paths

```
growth/data/processed/signal-mining-request-{start}_to_{end}.json   (--dry-run preview)
growth/signals/signal-mining-{start}_to_{end}.json                  (Mock/live run)
growth/signals/signal-mining-{start}_to_{end}.md                    (Mock/live run)
```

Same collision convention, atomic writes, and git-ignored generated output
(`growth/signals/*.json`, `growth/signals/*.md`, only `.gitkeep` committed)
as every other script in this directory.

### Source-record and contract traceability

Every source record (`SignalSourceRecord` — an internal Agent input type,
**not** a public front-half contract) has a deterministic id and is the
only thing the model may cite by id (`sourceRecordRefs`). After the
model's structured response is validated, `SignalCandidate` contracts are
assembled deterministically: metrics are copied only from the cited source
records (the model never invents or alters one), a deterministic id is
derived from campaign + normalized title + sorted source-record ids, and
exact/normalized duplicates (identical id, normalized title, or identical
sorted source-record-ref set) are removed, with the count recorded in
`deduplication`. `TopicCandidate` contracts resolve each cluster's
temporary signal references to final `SignalCandidate` ids, and every
`relatedAppSlugs` value is validated against the real
`src/data/apps.ts` app list — the model can never invent an app slug.

### Human-review requirement

Every run's `humanReview` object is fixed by the Agent, never by the
model: `required: true`, `approved: false`, `approvedBy: null`,
`approvedAt: null`. Every assembled `SignalCandidate`/`TopicCandidate` also
carries its own human-review markers per the front-half contracts above.
`TopicCandidate.status` is only ever `"candidate"` or `"needs_review"` —
never automatically `"rejected"` or `"archived"`.

### Common errors

| Error | Cause |
| --- | --- |
| `growth:signals requires --start and --end ...` | Missing `--start`/`--end` (required even with `--summary`). |
| `No normalized growth summary found for ... — run growth:normalize for this range first.` | No matching `growth-summary-*.json` in `growth/data/processed/`. |
| `No usable source records were found ...` | The Growth Summary, feedback, and manual input together produced zero source records for a non-dry-run — add `--manual-input`, supply `--feedback`, or use `--dry-run`. |
| `Manual input record at index N is invalid: ...` / `... contains a credential-shaped key ...` | `--manual-input` file failed validation — see "Manual JSON input format" above. |
| `The selected Growth Loop Feedback (...) was mock-generated ... pass --allow-mock-input to override` | Live Anthropic mode with mock-generated feedback and no override. |
| `No LLM provider configured. Pass --provider mock ...` | Neither `--provider` nor `SIGNAL_MINING_LLM_PROVIDER`/`GROWTH_REPORT_LLM_PROVIDER` is set, and this isn't a dry run. |
| `Model response referenced unknown sourceRecordRef(s)/signalProposalRef(s)/app slug(s): ...` | The model cited something outside the supplied catalogs — rejected, not patched. |
| `Model response did not match the required schema: ...` | Zod validation failed (bad enum, unknown key, too-short array, etc.). |

## Topic Scoring Agent

### Role in the fixed Growth Loop, and how it differs from Signal Mining

Step 2 — reads step 1's output and prepares input for Asset Generation
(step 3, not yet built):

```
1. Signal Mining Agent · **2. Topic Scoring Agent** · 3. Asset Generation Agent ·
4. CMS Writer · 5. Growth Site Engine · 6. Tracking Layer ·
7. Growth Report Agent · 8. Experiment Decision Agent ·
9. results return to the next Signal / Topic Pool cycle
```

Signal Mining *mines and normalizes* — it never scores a topic. Topic
Scoring *assesses and ranks* — it never collects a new signal, never does
web research, and never calls Reddit/X/Google Trends/Product Hunt/any
search-volume tool. It reads exactly one validated
`FinalSignalMiningRun` (`growth/signals/signal-mining-*.json` — never the
`.md` file, never raw platform files, never a growth summary/report/
decision) and produces a `ScoredTopic[]` for every `candidate`/
`needs_review` topic in that run's `topicPool`. An `advance`
recommendation is still not approval — nothing in this Agent starts Asset
Generation, and `humanReviewRequired` is always `true`.

### Input and output paths

```
growth/signals/signal-mining-{start}_to_{end}*.json                     (input, discovered or --input)
growth/data/processed/topic-scoring-request-{start}_to_{end}.json       (--dry-run preview)
growth/scores/topic-scoring-{start}_to_{end}.json                       (Mock/live run)
growth/scores/topic-scoring-{start}_to_{end}.md                         (Mock/live run)
```

Same collision convention, atomic writes, and git-ignored generated output
(`growth/scores/*.json`, `growth/scores/*.md`, only `.gitkeep` committed)
as every other script in this directory.

### Fixed scoring profile

`small_business_topic_scoring@1.0.0` — one fixed, versioned constant
(`growth/scoring/topic-scoring-profile.ts`), not a runtime-configurable
rubric. Seven dimensions, weights summing to exactly `1.0`:

| Dimension | Weight | Direction |
| --- | --- | --- |
| `demand` | 0.20 | Real, repeated need/engagement in the supplied signals — not total market demand, never invented search volume. |
| `audience_relevance` | 0.15 | Match to the audiences actually present in the supplied signals/TopicCandidate. |
| `product_fit` | 0.20 | Fit as a Whacka-style mini-app/growth-site use case, from supplied context only. |
| `competition` | 0.10 | **Opportunity favourability** — higher means *less* observed overlap/saturation, not a whole-market claim. |
| `feasibility` | 0.15 | How narrowly the topic can become a testable mini-app concept with the current system. |
| `novelty` | 0.10 | How distinct the topic is from the campaign's existing apps/topic pool. |
| `evidence_strength` | 0.10 | How strong, direct, diverse, and traceable the supporting signals are. |

Full meanings, the fallback-score policy, deterministic math, ranking
tie-breaks, and recommendation thresholds are documented in
**`growth/scoring/README.md`** — the authoritative reference; this section
only summarizes.

### Insufficient-evidence fallback policy

A dimension lacking real evidence uses `scoreBasis: "policy_default"` and
the fixed score **50** — "insufficient evidence to move the score
positively or negatively," never a measured average. Schema-enforced: a
`policy_default` dimension must use exactly this score and must carry at
least one limitation; an `evidence` dimension must cite at least one real
`signalRef`/`sourceRecordRef`. The Markdown always labels which is which.

### Deterministic calculations, ranking, and recommendation

The model only ever supplies raw per-dimension scores (0-100) plus
`scoreBasis`/rationale/citations — never a weight, weighted score, total,
rank, or recommendation (the schema has no field for any of them). This
Agent computes, deterministically, every time:

- `weightedScore = score × weight`, `totalScore = sum(weightedScore)` —
  reusing `growth/contracts/scored-topic.ts`'s own
  `computeWeightedScore`/`computeTotalScore`, never a second
  reimplementation.
- **Ranking:** totalScore desc → `evidence_strength` score desc → `demand`
  score desc → topicId asc (stable final tie-breaker).
- **Recommendation** (`growth/scoring/topic-scoring-engine.ts`'s
  `computeRecommendation`): `hold` if totalScore < 50 or any blocker
  exists (blockers always win); `advance` only if totalScore ≥ 70,
  `evidence_strength` ≥ 60, zero blockers, confidence high/medium, the
  source Signal Mining run was **not** mock, and its topics **were**
  human-approved; everything else that isn't `hold` is
  `needs_human_review`. `reject` is never assigned automatically in v1 —
  see `growth/scoring/README.md` for why.

### Confidence caps

The provider's own topic-level confidence is capped to the **minimum** of
itself and every applicable rule: source run mock-generated → `low`;
source topics not human-approved → `medium`; more than 3 of 7 dimensions
used `policy_default` → `low`; the topic has 0-1 supporting signals →
`low`. Only caps that actually reduce confidence produce a recorded reason
(`confidenceAdjustments` in the final JSON, and shown per-topic in the
Markdown) — nothing is silently downgraded.

### Mock-input and unreviewed-input behavior

`FinalSignalMiningRun.generation.isMock` and `.humanReview.approved` are
both preserved into `FinalTopicScoringRun.provenance`
(`sourceSignalMiningIsMock`/`sourceSignalsHumanReviewed`) and drive the
confidence caps and recommendation rule above. `--dry-run` and
`--provider mock` may freely consume mock or unreviewed input; a **live
Anthropic run refuses a mock-generated Signal Mining run by default** —
pass `--allow-mock-input` to override for explicit testing. Because the
confidence cap alone already excludes `advance` for a mock source, and the
human-approval check independently excludes it for an unreviewed source,
scoring a current (mock, unreviewed) Signal Mining run normally yields
`needs_human_review` for every topic, never `advance` — the Mock Provider
test suite asserts exactly this.

### Running it

```bash
# Dry run: loads and validates the Signal Mining run, builds per-topic
# contexts and the fixed rubric, writes a request preview — no provider call.
npm run growth:score-topics -- --start 2026-07-08 --end 2026-07-14 --dry-run

# Full local pipeline with the Mock Provider — no key, no network call.
npm run growth:score-topics -- --start 2026-07-08 --end 2026-07-14 --provider mock

# Future live run, once ANTHROPIC_API_KEY and a resolved model are set:
npm run growth:score-topics -- --start 2026-07-08 --end 2026-07-14

# Other flags: --input <path>, --language en|zh-CN (default en), --overwrite,
# --allow-mock-input
```

### Required live environment variables

| Variable | Resolution |
| --- | --- |
| Provider | `--provider` → `TOPIC_SCORING_LLM_PROVIDER` → `GROWTH_REPORT_LLM_PROVIDER` → configuration error (live runs only) |
| Model | `TOPIC_SCORING_MODEL` → `GROWTH_REPORT_MODEL` → configuration error (live Anthropic runs only) |
| `TOPIC_SCORING_MAX_TOKENS` | Optional, defaults to `8000`. |
| `ANTHROPIC_API_KEY` | Any live Anthropic call. Never required for `--dry-run` or `--provider mock`. |

`TOPIC_SCORING_PROFILE` in `.env.example` is informational only — the
scoring profile is a fixed code constant (`growth/scoring/topic-scoring-profile.ts`),
not something the script reads or lets you swap at runtime.

### Human-review boundary and why "advance" is not automatic approval

Every run's `humanReview` object is fixed by the Agent, never by the
model: `required: true`, `approved: false`, `selectedTopicIds: []`,
`approvedBy: null`, `approvedAt: null`. `advance` means "this topic cleared
every deterministic threshold" — it is not a publish action, does not
write anywhere, and does not start Asset Generation. A human still
reviews the ranked list and explicitly selects which topic(s) proceed;
nothing in this codebase yet flips `approved` to `true` or acts on a
selection.

### Why no external market data is claimed

`competition`, `demand`, and `feasibility` are the dimensions most likely
to tempt an LLM into fabricating an external fact. The system prompt
forbids inventing search volume, market size, competitors, user feedback,
traffic, product conversions, or an unsupported Whacka capability;
`competition` is explicitly framed as opportunity favourability *within
the supplied evidence and this campaign's own content catalog* — never a
claim about the whole external market. Whacka product-side conversions
stay `null`/not-connected throughout, exactly as the Growth Report and
Experiment Decision Agents already treat them.

### Common errors

| Error | Cause |
| --- | --- |
| `growth:score-topics requires --start and --end ...` | Missing `--start`/`--end` (required even with `--input`). |
| `No Signal Mining run found for ... — run growth:signals for this range first.` | No matching `signal-mining-*.json` in `growth/signals/`. |
| `"..." contains duplicate SignalCandidate id "..."` / `duplicate TopicCandidate id "..."` | The source Signal Mining run is internally inconsistent — rejected before scoring is attempted. |
| `"..." TopicCandidate "..." references unknown SignalCandidate "..."` | A topic's `signalRefs` doesn't resolve within its own run — rejected. |
| `"..." TopicCandidate "..." has status "..."; only "candidate" or "needs_review" ...` | The run contains a `rejected`/`archived` topic — Topic Scoring refuses to score it. |
| `... has dataQuality.overallStatus = "invalid" ...` | The source run's own data quality was invalid; `"partial"` is fine, `"invalid"` is refused. |
| `Signal Mining run's period (...) does not match the requested period (...)` | The selected/`--input` file covers a different date range than `--start`/`--end`. |
| `The selected Signal Mining run ("...") was mock-generated ... pass --allow-mock-input to override` | Live Anthropic mode with a mock-generated source run and no override. |
| `No LLM provider configured. Pass --provider mock ...` | No provider resolved from `--provider`, `TOPIC_SCORING_LLM_PROVIDER`, or `GROWTH_REPORT_LLM_PROVIDER`, and this isn't a dry run. |
| `Model response contains an assessment for unknown topic "..."` / `is missing an assessment for topic(s): ...` | The model's topic coverage didn't exactly match the supplied topics — rejected, not patched. |
| `Topic "..." dimension "..." references ... outside its own supplied signals/source records.` | The model cited a signal/source record that doesn't belong to that topic's own scoped context. |
| `Model response did not match the required schema: ...` | Zod validation failed (bad enum, missing/duplicate dimension, out-of-range score, unknown key, etc.). |

## Asset Generation Agent

### Role in the fixed Growth Loop, and how it differs from Topic Scoring

Step 3 — reads step 2's output and prepares input for CMS Writer (step 4,
below):

```
1. Signal Mining Agent · 2. Topic Scoring Agent · **3. Asset Generation Agent** ·
4. CMS Writer · 5. Growth Site Engine · 6. Tracking Layer ·
7. Growth Report Agent · 8. Experiment Decision Agent ·
9. results return to the next Signal / Topic Pool cycle
```

Topic Scoring *assesses and ranks* — it never writes app copy. Asset
Generation *designs content* — it never scores, ranks, or picks a topic;
it turns **one explicitly selected** already-scored topic into one
complete `AssetBundle` (app copy, creative brief, SEO copy, CTA labels,
optional social copy). It reads exactly one validated
`FinalTopicScoringRun` (`growth/scores/topic-scoring-*.json` — never the
`.md` file, never Signal Mining/Growth Summary/Growth Report/Experiment
Decision files, never an external website) and never writes to Sanity,
never creates a `CMSWriteRequest`, never touches the Astro site, and never
deploys anything.

### Explicit `--topic-id` requirement — no automatic rank-1 selection

`--topic-id <topic_id>` is **always required**. There is no fallback to
`ranking.topTopicId`, no "use rank 1," and no implicit selection of any
kind — the selected topic ID must exist in the run's `topicCatalog`, and a
matching `ScoredTopic` must exist in `scoredTopics`, or the run fails
before any provider call. The selected topic ID is recorded explicitly in
`FinalAssetGenerationRun.provenance.selectedTopicId`.

### Approval and override behavior

The current Topic Scoring output typically has `humanReview.approved =
false` and `humanReview.selectedTopicIds = []` — an `advance`
recommendation or a #1 rank is **never** treated as human approval.

| Condition | dry-run / Mock | Live Anthropic |
| --- | --- | --- |
| Mock-generated Topic Scoring input | Allowed | Refused unless `--allow-mock-input` |
| Topics not human-approved (`humanReview.approved = false`) | Allowed | Refused unless `--allow-unapproved-topic` |
| Selected topic's recommendation is `hold` | Refused unless `--allow-hold-topic` | **Always refused in v1**, regardless of any flag |

Every override actually used is recorded in
`provenance.allowMockInputUsed` / `allowUnapprovedTopicUsed` /
`allowHoldTopicUsed` and shown prominently in the Markdown. An override is
explicitly a development/engineering-validation escape hatch — it is never
equivalent to approval, and `AssetBundle.validation.humanReviewRequired`
stays `true` regardless.

### Provider-neutral architecture (same pattern as every other Agent)

```
growth/agents/asset-generation-agent.ts          — orchestration; imports only
                                                    growth/llm/asset-generation-provider.ts's
                                                    interface, never an SDK directly
growth/llm/asset-generation-provider.ts          — the AssetGenerationProvider interface
growth/llm/mock-asset-generation-provider.ts     — no API key, no network call
growth/llm/anthropic-asset-generation-provider.ts — the only file here that imports @anthropic-ai/sdk
growth/prompts/asset-generation-prompt.ts        — system/user prompt construction
growth/renderers/asset-generation-markdown.ts    — pure JSON -> Markdown renderer
```

The provider never produces IDs, URLs, UTM values, status fields, provider
metadata, topic scores, or CMS/publication fields — the response schema
(`AssetGenerationAnalysis`) has no field for any of them. All of that is
computed deterministically afterward by the Agent.

### Running it

```bash
# Dry run: loads and validates the Topic Scoring run, resolves the
# explicitly selected topic, builds the generation context, writes a
# request preview — no provider call.
npm run growth:generate-assets -- \
  --start 2026-07-08 --end 2026-07-14 --topic-id topic_0219d6e950cc913e --dry-run

# Full local pipeline with the Mock Provider — no key, no network call.
npm run growth:generate-assets -- \
  --start 2026-07-08 --end 2026-07-14 --topic-id topic_0219d6e950cc913e --provider mock

# Future live run, once ANTHROPIC_API_KEY and a resolved model are set,
# and the topic has actually been human-approved:
npm run growth:generate-assets -- \
  --start 2026-07-08 --end 2026-07-14 --topic-id <approved-topic-id>

# Other flags: --input <path>, --language en|zh-CN (default en),
# --social-channels linkedin,x (default: none), --overwrite,
# --allow-mock-input, --allow-unapproved-topic, --allow-hold-topic
```

### Optional social channel behavior

No social channels are requested by default — `social.posts` is `[]`.
`--social-channels linkedin,x` normalizes (trim, lowercase, dedupe) and
passes through an explicit allow-list; the model may only produce posts
for those exact channels, and any post for an unrequested channel is
rejected outright (not silently dropped). Social copy never implies the
post was actually published anywhere. There is no automatic posting or
scheduling anywhere in this pipeline — `growth:generate-assets` only ever
writes local JSON/Markdown files.

### Social content is collection-level, not one isolated app

App-page assets (`app.*`, SEO, FAQ, the app-page CTA) are generated **per
topic/app**, exactly as before, and remain entirely about the selected
app. Social assets (when any `--social-channels` are requested) are
generated **for the whole collection/campaign** instead — a mentor
decision: promoting one isolated mini-app on social media isn't
meaningful. The selected app is used as one example, or as a fresh content
angle, never as the sole subject of a post.

`AssetBundle.social.strategy` (present only when `social.posts` is
non-empty; omitted for a zero-channel run, and omitted on files written
before this field existed — old files remain readable) records this
explicitly:

```ts
social.strategy: {
  scope: "collection";
  campaignId: string;
  campaignName: string;
  featuredAppSlugs: string[]; // the new app's own final slug + existing catalog apps
  destinationUrl: string | null;
  utmContent: string; // collection-level, always distinct from the app's own slug
}
```

Content angles the model is asked to use: a shared operational problem
("several small businesses juggle X"), a toolkit/list of lightweight
mini-app ideas, a scenario spanning several everyday tasks, or educational
examples — never a standalone product launch. `featuredAppSlugs` always
includes the new app's own slug plus, when the existing-app catalog
(`src/data/apps.ts`, the same 5 real apps used everywhere else in this
pipeline — never duplicated) has two or more entries and any channel was
requested, at least two of them. Existing catalog apps are already live at
`/apps/{slug}`; the new concept is only a draft — copy must not conflate
the two.

Banned in social copy (validated deterministically, not just by prompt —
see "Deterministic validation" below): standalone-launch patterns
("Introducing `<AppName>`", "Launching `<AppName>`", "Try our new
`<AppName>` app", "`<AppName>` is the solution", "Build this one app
now"), and the overclaim phrases "proven demand", "validated
opportunity", "confirmed user need", "market-leading", "top-performing
product".

**CTA and destination:** social CTA targets the collection landing page —
never the selected app's own build/demo/remix URL, and never the Whacka
dashboard. This reuses the site's existing `PUBLIC_SITE_URL` (already
used by `astro.config.mjs`/sitemap/canonical links — see .env.example) as
the collection landing page URL, since this single-campaign site's
homepage already lists the full app catalog. When `PUBLIC_SITE_URL` isn't
configured, `destinationUrl` stays `null` — never fabricated — and a
clear warning is recorded in `validation.warnings`. Generated social copy
may still contain a textual call to action ("Explore the Small Business
Mini App Toolkit"), but must never claim a working link exists when
`destinationUrl` is null.

**Deterministic validation** (`growth/agents/asset-generation-agent.ts`)
rejects the model's response — a clear regeneration failure, never a
silent rewrite — when: a social post uses standalone-launch or overclaim
language; a featured slug isn't in the selected app or the existing
catalog; fewer than `min(2, catalog size)` existing apps are featured
while a channel was requested; or (defensively, should never actually
happen) the computed `destinationUrl` would collide with the Whacka
dashboard or the app's own CTA URLs.

**CMS Writer never sees this.** `AssetBundle.social` (posts or strategy)
has no corresponding field in the Sanity `appTool` payload schema — the
CMS Writer mapping (`growth/contracts/cms-write-request.ts`) only ever
reads `app.*`/`seo.*`/`cta.*`, so collection-level social metadata is
structurally impossible to leak into a Sanity draft.

Future collections (e.g. an "Education" campaign) can reuse this exact
architecture unchanged — `campaignId`/`campaignName` already come from
the run's own `campaign` object, never hardcoded, so a new campaign only
needs its own Topic Scoring run and, optionally, its own collection
landing page. That future collection is not implemented here.

### AssetBundle compatibility and SEO persistence

`AssetBundle.app.*` maps field-for-field onto the real Sanity `appTool`
schema and `AppData` type (see the Front-Half Contracts section above) —
this Agent reuses that existing contract unchanged. **SEO persistence is
resolved:** the Sanity `appTool` schema now has a `seo` object field
(`title`, `metaDescription`, `primaryKeyword`, `secondaryKeywords` — see
`studio/schemaTypes/appTool.ts`), and CMS Writer (step 4, below) maps
`AssetBundle.seo.*` onto it when it builds a Sanity draft.
`compatibility.seoPersistenceAvailable` is `true` for every run produced
by this Agent going forward; the obsolete "SEO fields ... does not yet
persist them" warning no longer appears in `validation.warnings` or
`compatibility.warnings`. AssetBundle files generated before this change
are not migrated — they still carry the old warning text and
`seoPersistenceAvailable: false`, which is expected and harmless.

### CTA URL and UTM rules

- `demoUrl`/`remixUrl` are **always `null`** — no real per-app demo or
  remix target exists yet for a not-yet-built concept, and this Agent
  never invents one.
- `buildUrl` reuses the one real, already-existing, platform-wide "start
  building" destination (`src/lib/utm.ts`'s `HOMEPAGE_DASHBOARD_URL`,
  `https://whacka.app/dashboard`) — not per-app, not invented, safe to
  offer for any generated concept.
- `app.ctaHref` is the real `buildUrl` when the primary CTA type is
  `"build"`, or `"#"` — the same no-real-target placeholder convention
  already used by every current app fixture — otherwise. Never a
  placeholder string like `"TBD"`, never a fabricated URL.
- `cta.utmContent` is set deterministically to the final resolved slug,
  matching `src/lib/utm.ts`'s own `getUtmContent()` fallback. `utm_source`/
  `utm_campaign`/`utm_medium` stay code constants exactly as they already
  are — this Agent never invents a UTM value.

### Deterministic slug and AssetBundle ID behavior

The provider may suggest a name/slug; the **final** slug is always
resolved deterministically: lowercased, URL-safe, no spaces, no leading/
trailing hyphen. A conflict with an existing app slug (checked against the
real `src/data/apps.ts` catalog) never silently overwrites that app —
instead a deterministic suffix derived from the topic ID is appended, and
a factual warning records the original suggestion. The final
`AssetBundle.id` is deterministic from campaign ID + topic ID + final slug
+ language + prompt version (a stricter basis than
`growth/contracts/asset-bundle.ts`'s own `buildAssetBundleId`, which this
Agent deliberately does not modify or reuse — see the code comment in
`growth/agents/asset-generation-agent.ts` for why language must be part of
the hash).

### Human-review boundary

Every run's `humanReview` object is fixed by the Agent, never by the
model: `required: true`, `approved: false`, `approvedBy: null`,
`approvedAt: null`. `AssetBundle.validation.status` is computed
deterministically too (never provider-supplied): it is `"needs_review"`
whenever any review trigger applies (mock source, unapproved topic,
override flags used, a non-`"advance"` recommendation, generated
assumptions/limitations, an unavailable primary CTA URL, Mock Provider
generation), and `"draft"` only once every one of those no longer
applies. In practice a real (non-mock, human-approved, `"advance"`)
generation can now reach `"draft"` — SEO persistence is no longer an
unconditional blocker. **Confirmed: this Agent never calls
`@sanity/client`, never writes a document, and never modifies an Astro
page** — `compatibility.cmsWritePerformed` and `.siteModified` are always
`false`, checked by tests.

### Common errors

| Error | Cause |
| --- | --- |
| `growth:generate-assets requires --topic-id ...` | `--topic-id` was omitted — there is no automatic selection. |
| `growth:generate-assets requires --start and --end ...` | Missing `--start`/`--end` (required even with `--input`). |
| `No Topic Scoring run found for ... — run growth:score-topics for this range first.` | No matching `topic-scoring-*.json` in `growth/scores/`. |
| `Selected topic ID "..." was not found in this Topic Scoring run's topicCatalog.` | The given `--topic-id` doesn't exist in the loaded run (including a zero-topic run). |
| `No ScoredTopic found for topic ID "..." ...` | The topic exists but has no corresponding score — should not happen for a valid Topic Scoring run. |
| `... has dataQuality.overallStatus = "invalid" ...` | The source run's own data quality was invalid; `"partial"` is fine, `"invalid"` is refused. |
| `Topic Scoring run's period (...) does not match the requested period (...)` | The selected/`--input` file covers a different date range than `--start`/`--end`. |
| `The selected Topic Scoring run ("...") was mock-generated ... pass --allow-mock-input to override` | Live Anthropic mode with a mock-generated source run and no override. |
| `... topics have not been human-approved ... pass --allow-unapproved-topic to override` | Live Anthropic mode with an unapproved run and no override. |
| `Selected topic's recommendation is "hold". Pass --allow-hold-topic ...` | Dry-run/Mock mode with a `hold` topic and no override. |
| `Selected topic's recommendation is "hold". Live Anthropic generation for a 'hold' topic is not supported in v1 ...` | Live Anthropic mode with a `hold` topic — never overridable. |
| `Model generated a social post for channel "...", which was not requested.` | The model produced a post outside the explicit `--social-channels` allow-list — rejected, not patched. |
| `Social post for channel "..." uses standalone-app-launch language ...` | Social copy read like a single-app product launch ("Introducing `<App>`", etc.) — rejected, regenerate. |
| `Social post for channel "..." makes an unsupported claim ...` | Social copy claimed proven/validated demand or similar — rejected, regenerate. |
| `Model's socialFeaturedExistingAppSlugs references "...", which is not in the supplied existing-app catalog.` | The model invented or misspelled an existing-app slug. |
| `Social content must feature at least N existing app(s) ...` | The selected app would have been the sole featured subject even though other collection apps are available. |
| `Could not resolve a valid slug from the suggested name "..."` | The provider's slug suggestion normalized to an empty string. |
| `Model response did not match the required schema: ...` | Zod validation failed (bad enum, empty required field, unknown key, invented URL/ID/status field, etc.). |

### Integration-test mode — engineering verification only, never a business experiment

`--integration-test` is a tightly-controlled escape hatch that lets a real
Anthropic call reach a `hold` topic, **for engineering verification of the
Asset Generation → human review → CMS Writer pipeline only**. It does not
change Topic Scoring's output or recommendation, does not authorize a
growth experiment, and does not write or publish anything automatically.
Normal live behavior is completely unchanged: a `hold` topic is still
rejected in live Anthropic mode with no flags, exactly as before.

Required flags, **all together**, with no other override existing anywhere
in this pipeline (no `--force`, `--skip-validation`, `--publish`, or
`--approve-topic`):

- `--integration-test`
- `--confirm-integration-test`
- `--reviewed-by "<name>"`
- `--allow-hold-topic` (only needed when the selected topic actually is `hold`)
- `--allow-unapproved-topic` (only needed when the source run isn't human-approved — the existing, unchanged gate)

Optional: `--review-note "<text>"`.

Validation rules:

| Combination | Result |
| --- | --- |
| `--integration-test` without `--confirm-integration-test` | Rejected |
| `--confirm-integration-test` without `--integration-test` | Rejected |
| `--integration-test` without `--reviewed-by <name>` | Rejected |
| `--integration-test` with `--dry-run` | Rejected — `--dry-run` never calls a provider, so there is nothing to integration-test; use `--provider mock` to preview locally instead |
| An invalid/unknown `--topic-id` | Always rejected — no flag combination ever bypasses topic resolution |
| An unsupported Topic Scoring `schemaVersion` | Always rejected — no flag combination ever bypasses schema validation |

```bash
npm run growth:generate-assets -- \
  --start 2026-07-08 --end 2026-07-14 \
  --topic-id <hold-topic-id> \
  --provider anthropic \
  --integration-test --confirm-integration-test --reviewed-by "Joy" \
  --review-note "Engineering integration test only; the source topic remains hold." \
  --allow-hold-topic --allow-unapproved-topic
```

What the output records (see `growth/types/asset-generation.ts`):

- `executionPurpose: "integration_test"` (normal runs resolve to `"business_experiment"` — always set explicitly, optional on the type only for backward compatibility with runs written before this field existed).
- `integrationTestReview: { confirmed: true, reviewedBy, reviewNote, sourceRecommendation, businessApprovalGranted: false }` — `sourceRecommendation` is the topic's actual (unmodified) recommendation; `businessApprovalGranted` can never be `true` anywhere in this contract.
- Four explicit `AssetBundle.validation.warnings`: generated under an explicit engineering integration-test override; the source recommendation; not approved as a business experiment; human content review required before any CMS draft write.
- `assetBundle.validation.status` stays `"needs_review"`, `humanReview.required` stays `true`, `compatibility.cmsWritePerformed`/`.siteModified` stay `false`, `compatibility.seoPersistenceAvailable` stays `true` — identical guarantees to a normal run.
- The source `ScoredTopic` (recommendation, blockers) is never mutated — Topic Scoring's own output file is never touched.
- The Anthropic prompt itself is told this is an engineering integration test: it must not claim demand is validated or that the topic is approved, must avoid phrases like "proven demand"/"validated opportunity"/"top-performing market"/"confirmed user need", and must still produce the complete AssetBundle content (app prompt, page copy, SEO title, meta description, keywords, FAQ, social copy, CTA labels, UTM-mapping-ready fields) so the pipeline can actually be exercised end-to-end.

Output filenames are visibly distinguishable from normal business assets:

```
growth/assets/asset-generation-{start}_to_{end}-{topic-id}.integration-test.json
growth/assets/asset-generation-{start}_to_{end}-{topic-id}.integration-test.md
```

Collision-safe timestamping and `--overwrite` work exactly as for a normal
run. Normal (non-integration-test) filenames are completely unchanged.

## CMS Writer

### Role in the fixed Growth Loop, and why it is not an Agent

Step 4 — reads step 3's output (one `FinalAssetGenerationRun`) and turns it
into a Sanity `appTool` **draft** document:

```
1. Signal Mining Agent · 2. Topic Scoring Agent · 3. Asset Generation Agent ·
**4. CMS Writer** · 5. Growth Site Engine · 6. Tracking Layer ·
7. Growth Report Agent · 8. Experiment Decision Agent ·
9. results return to the next Signal / Topic Pool cycle
```

CMS Writer is **deliberately not an LLM Agent** — every other module in
this list calls a provider-neutral LLM interface (Mock or Anthropic); CMS
Writer never does. It is a deterministic mapping (`growth/cms/asset-to-cms-request.ts`
+ `growth/contracts/cms-write-request.ts`) plus one gated, real Sanity API
call (`growth/cms/sanity-draft-writer.ts`). It never regenerates content,
never changes topic scores, never collects new signals, and never creates
another Agent.

### SEO fields are now persisted

The Sanity `appTool` schema has an optional `seo` object field (`title`,
`metaDescription`, `primaryKeyword`, `secondaryKeywords` —
`studio/schemaTypes/appTool.ts`), and the Astro app-detail page
(`src/pages/apps/[slug].astro` via `src/layouts/BaseLayout.astro`) uses
`seo.title`/`seo.metaDescription` for page metadata when present, falling
back to the existing tagline/`shortDescription`-based title and
description otherwise — no visible layout change, no new page section.
This closes the SEO-persistence gap the Asset Generation Agent previously
flagged in every run (see that section above).

### Input boundary

CMS Writer reads **only**
`growth/assets/asset-generation-{start}_to_{end}-{topic-id}*.json` — never
Topic Scoring, Signal Mining, Growth Summary, analytics raw files, Growth
Report, Experiment Decision, or any arbitrary content file. It validates:
the file parses as JSON and matches the `FinalAssetGenerationRun` shape;
the requested period matches; the selected topic/scored-topic identity is
internally consistent; the embedded `AssetBundle` passes its own contract
validation (`validateAssetBundle`); `AssetBundle.app.status` is `"draft"`;
the source run's `compatibility.cmsWritePerformed` and `.siteModified` are
both `false`. An unsupported schema major version is rejected (delegated
to `validateAssetBundle`'s own `assertSupportedMajorVersion` check).

### Running it

```bash
# Dry run: discovers and validates the Asset Generation run, builds the
# CMSWriteRequest and the Sanity draft payload, writes a local preview —
# no network request, no Sanity token required.
npm run growth:cms-write -- \
  --start 2026-07-08 --end 2026-07-14 --topic-id topic_0219d6e950cc913e --dry-run

# Explicit input instead of discovery:
npm run growth:cms-write -- \
  --start 2026-07-08 --end 2026-07-14 \
  --input growth/assets/asset-generation-2026-07-08_to_2026-07-14-topic_....json --dry-run

# Real Sanity draft write — requires explicit human-review confirmation
# and full Sanity configuration (see below):
npm run growth:cms-write -- \
  --input growth/assets/asset-generation-....json \
  --write-draft --confirm-reviewed --reviewed-by "Joy"

# Other flags: --review-note "...", --allow-mock-input, --overwrite
```

Exactly one of `--dry-run` / `--write-draft` is required. `--topic-id` is
required for automatic discovery only — `--input` bypasses it.
**There is no `--publish` flag anywhere in this pipeline.**

### Human-review gate

A real Sanity write (`--write-draft`) requires **both**
`--confirm-reviewed` and a non-empty `--reviewed-by <name>` — neither is
implied by anything else. `--dry-run` never requires either. These flags
are recorded in the CMS Writer's own output (never in the source Asset
Generation JSON, which is never mutated) as approval to create a Sanity
**draft only** — never approval to publish. Mock Asset Generation input
(`generation.isMock`) is rejected by `--write-draft` by default;
`--allow-mock-input` opts in explicitly (recorded prominently in the
output) and even then only a draft is ever written. An `AssetBundle` that
fails its own contract validation can never be written, with or without
any override flag.

### Required environment variables for a real draft write

Reuses the exact variable names `scripts/seed.ts` and `src/lib/sanity.ts`
already use — nothing new to add to `.env`:

- `PUBLIC_SANITY_PROJECT_ID`
- `PUBLIC_SANITY_DATASET`
- `PUBLIC_SANITY_API_VERSION` (optional, defaults to `2024-01-01`)
- `SANITY_API_TOKEN` — server-side only, never exposed to the browser,
  never logged, never written to any output file

None of these are required for `--dry-run`.

### Deterministic IDs, draft-only writes, and idempotency

- The canonical document id is `appTool-{slug}` (same convention as
  `scripts/seed.ts`'s `toDocId()`), but CMS Writer **never writes that
  id**. The actual Sanity write target is always the draft-prefixed id,
  `drafts.appTool-{slug}` — Sanity treats any `_id` starting with
  `drafts.` as an unpublished draft; there is no separate flag.
- `idempotencyKey` is deterministic from the AssetBundle id, target, and
  operation — re-running CMS Writer against an unchanged AssetBundle
  reuses the same `CMSWriteRequest.id`/`idempotencyKey`, so `createOrReplace`
  is a safe, idempotent re-run rather than an accumulating duplicate.
- `_key` values for array fields (`screenshots`, `faq`) are deterministic
  (reusing `growth/lib/ids.ts`'s `deterministicId`), never `randomUUID()`.
- CMS Writer never calls `.publish()`, never writes the canonical
  (non-draft) document id, never deletes a document, and never touches any
  document other than the one it was asked to write.

### Output locations

- Dry-run preview: `growth/cms-output/requests/cms-write-request-{start}_to_{end}-{topic-id}.json`
  and matching `.md` — collision-safe (timestamp-suffixed unless
  `--overwrite`), written atomically, never containing a token or an
  absolute local path.
- Real draft-write receipt (only after a successful write):
  `growth/cms-output/receipts/cms-write-receipt-{start}_to_{end}-{topic-id}.json`
  and matching `.md`. States plainly that a Sanity **draft** was created
  or replaced, that the public site was **not** modified automatically,
  and that manual review/publish in Sanity Studio is still required.

Both directories are git-ignored (kept via `.gitkeep`), matching every
other generated-output folder in `growth/`.

### Common errors

| Error | Cause |
| --- | --- |
| `growth:cms-write requires exactly one of --dry-run or --write-draft.` | Neither or both flags were passed. |
| `growth:cms-write requires --topic-id for automatic discovery ...` | `--topic-id` omitted and `--input` not given. |
| `--write-draft requires --confirm-reviewed ...` / `--write-draft requires --reviewed-by <name> ...` | The human-review gate wasn't satisfied. |
| `No Asset Generation run found for ... — run growth:generate-assets for this topic first.` | No matching `asset-generation-*-{topic-id}*.json` in `growth/assets/`. |
| `... AssetBundle.app.status is "...", CMS Writer only accepts a "draft" AssetBundle.` | The loaded run's AssetBundle isn't a draft (should not happen for a valid Asset Generation output). |
| `The selected Asset Generation run ("...") was mock-generated ... pass --allow-mock-input to override` | `--write-draft` with mock input and no override. |
| `--write-draft requires Sanity configuration. Missing: ...` | One or more of `PUBLIC_SANITY_PROJECT_ID`/`PUBLIC_SANITY_DATASET`/`SANITY_API_TOKEN` is unset. |
| `Sanity rejected the request: authentication failed ...` / `Sanity denied permission ...` / `Sanity project or dataset not found ...` | A real write failed at Sanity's API — sanitized, never includes the token. |
| `The selected Asset Generation run ("...") is an engineering integration-test output ... pass --allow-integration-test-input to override` | `--write-draft` with `executionPurpose: "integration_test"` source input and no override. |

### Integration-test input (`executionPurpose: "integration_test"`)

An Asset Generation run produced under `--integration-test` (see above) is
never auto-discovered by plain `--topic-id` discovery — its
`.integration-test.json` filename is deliberately excluded from the
discovery pattern, so it can only ever be loaded via explicit `--input`.

- **`--dry-run`** accepts an integration-test `--input` file with no extra
  flag — the preview and its Markdown clearly show
  `sourceExecutionPurpose: "integration_test"`, a prominent banner, and
  state plainly that the source is not business-approved. No network
  request is made either way.
- **`--write-draft`** (a real Sanity write) refuses integration-test input
  by default. One additional explicit flag is required:

  ```
  --allow-integration-test-input
  ```

  Without it, the real draft write is rejected before any network call.
  Even with it: only a `drafts.appTool-*` document is ever written (never
  published, never the canonical id), the business experiment is never
  marked approved (no field in this pipeline can express that), and the
  override is recorded in the CMS receipt's provenance
  (`allowIntegrationTestInputUsed: true`). Integration-test metadata
  (`executionPurpose`, `integrationTestReview`) is never included in the
  Sanity `appTool` payload itself — that payload only ever maps from
  `AssetBundle`, which has no such fields.

```bash
# Future command — do not run until the integration-test AssetBundle has
# actually been human-reviewed:
npm run growth:cms-write -- \
  --input growth/assets/asset-generation-....integration-test.json \
  --write-draft --confirm-reviewed --reviewed-by "Joy" \
  --allow-integration-test-input
```

See `growth/cms/README.md` for the full AssetBundle → CMSWriteRequest →
appTool payload mapping.

## Growth Site Engine — Sanity draft preview mode

### Role in the fixed Growth Loop

Step 5 — renders `appTool` documents (`src/lib/sanity.ts`) as real Astro
pages (`src/pages/apps/[slug].astro`, `src/pages/index.astro`):

```
1. Signal Mining Agent · 2. Topic Scoring Agent · 3. Asset Generation Agent ·
4. CMS Writer · **5. Growth Site Engine** · 6. Tracking Layer ·
7. Growth Report Agent · 8. Experiment Decision Agent ·
9. results return to the next Signal / Topic Pool cycle
```

In **normal mode** (no flags, every existing `npm run dev`/`npm run build`),
this is completely unchanged: the site queries Sanity's default
`"published"` perspective (or falls back to `src/data/apps.ts` when Sanity
isn't configured) — an unpublished draft (e.g. `drafts.appTool-slotsmith`)
is never visible, and the current 5 published apps behave exactly as
before.

### Local Sanity draft preview mode

A one-off, **local-only, server-only** flag lets an engineer verify that a
real Sanity draft (e.g. one written by `growth:cms-write --write-draft`)
actually renders correctly as an Astro page **before** anyone publishes it
in Sanity Studio. This never publishes, never writes to Sanity, and never
deploys — it only changes what the *local* dev server reads.

```
SANITY_PREVIEW_DRAFTS=true   # server-only, default false — see .env.example
```

- Reuses the existing `PUBLIC_SANITY_PROJECT_ID` / `PUBLIC_SANITY_DATASET`
  / `SANITY_API_TOKEN` — no duplicate credential is introduced.
- Requires `SANITY_API_TOKEN` (the same write token `growth:cms-write`
  already uses, or any token with at least Viewer access) — draft content
  is never visible to an unauthenticated request. Missing the token while
  `SANITY_PREVIEW_DRAFTS=true` fails immediately and clearly (`astro
  dev`/`astro build` refuses to start), rather than silently falling back
  to published-only content.
- The token is **never** `PUBLIC_`-prefixed, so Astro/Vite never inlines
  it into a client-side bundle or rendered HTML — `src/lib/sanity.ts` is
  only ever imported from `.astro` frontmatter (server-side execution),
  never from a `<script>` block.
- Preview mode uses the `"drafts"` perspective — the current,
  non-deprecated value for the installed `@sanity/client@7.23.0`
  (`"previewDrafts"` is marked `@deprecated use 'drafts' instead` in the
  SDK's own type definitions; using it would be exactly the "blindly
  hard-coding an unsupported/legacy value" this avoids) — and
  `useCdn: false`, since Sanity's CDN never serves draft content. Normal
  mode's `useCdn: true` is unchanged.
- `drafts.appTool-slotsmith` resolves as the logical `appTool` document at
  route `/apps/slotsmith` — the `drafts.` prefix is never part of
  `slug`/the route, and when both a draft and a published version exist
  for the same slug, the draft is shown exactly once (never two cards, two
  pages, or a duplicate listing on the homepage) — `dedupeDraftsAndPublished`
  in `src/lib/sanity.ts` collapses them deterministically, preferring the
  draft.
- All existing Sanity → `AppData` mapping is preserved unchanged: SEO
  (`seo.title`/`metaDescription`/keywords), FAQ, CTA labels/href, steps,
  and the Whacka prompt all render exactly as they would once published.
  `demoUrl`/`remixUrl` being `null` still resolves to "unavailable" (never
  fabricated); `buildUrl` is unchanged.

### Why a shell-set `SANITY_PREVIEW_DRAFTS=true` didn't work at first, and how it's fixed

Confirmed root cause (from the installed packages' own source, not
guesswork): Astro's Vite instance sets `envPrefix: "PUBLIC_"`
(`node_modules/astro/dist/core/create-vite.js`), and Vite's `loadEnv()`
only ever includes vars matching that prefix
(`node_modules/vite/dist/node/chunks/dep-*.js`'s `loadEnv` function). Since
`SANITY_PREVIEW_DRAFTS` and `SANITY_API_TOKEN` are deliberately **not**
`PUBLIC_`-prefixed (so they're never inlined into a client bundle),
`import.meta.env` never carries either of them in a real `astro
dev`/`astro build` run — regardless of whether the value came from the
shell or from `.env`. A shell-set `$env:SANITY_PREVIEW_DRAFTS="true"`
therefore never reached `src/lib/sanity.ts` at all, so the site silently
stayed in normal (published-only) mode: the homepage still showed 5 apps,
and `/apps/slotsmith` 404'd because `getStaticPaths()` never saw the
draft.

The fix, in `src/lib/sanity.ts`:

1. `import "dotenv/config";` at the top of the file — populates
   `process.env` from the root `.env` (the same mechanism every
   `growth/scripts/*.ts` CLI already uses). `dotenv` never overwrites a
   value already present in `process.env` (its own documented default),
   so a shell-set value is always preserved.
2. `SANITY_PREVIEW_DRAFTS`/`SANITY_API_TOKEN` are now resolved with an
   explicit, documented precedence: **(1) `process.env`** — always
   reliable in Node/Astro SSR, unaffected by Vite's `PUBLIC_`-only
   `envPrefix` filtering, and what a shell-set value actually populates;
   **(2) `import.meta.env`** — kept as a defensive fallback; **(3)**
   `false`/unset. `PUBLIC_SANITY_PROJECT_ID`/`PUBLIC_SANITY_DATASET`/
   `PUBLIC_SANITY_API_VERSION` are unchanged — Astro/Vite already
   populates those correctly via the `PUBLIC_` prefix.
3. `SANITY_PREVIEW_DRAFTS` is normalized case-insensitively and trimmed
   (`" True "`/`"TRUE"` also activate preview mode).
4. The framework-neutral config/query/dedup logic (previously only
   reachable through Astro's `import.meta.env`) was extracted into
   `src/lib/sanity-shared.ts`, which has no dependency on
   `import.meta.env` at all — this is what makes the read-only diagnostic
   CLI below possible, and is also what every offline test in
   `src/lib/sanity-shared.test.ts` exercises directly.

### Diagnostic CLI — verify the real connection, read-only

```bash
npm run growth:check-sanity-preview -- --preview
npm run growth:check-sanity-preview -- --published
```

Reuses the exact same `src/lib/sanity-shared.ts` logic the Astro site
itself uses (not a reimplementation), so this diagnoses the *actual*
preview path. Makes exactly one read-only `client.fetch()` call — no
create/patch/delete method exists anywhere in
`growth/scripts/check-sanity-preview.ts`. `--preview`/`--published`
forces the corresponding mode directly (bypassing whatever
`SANITY_PREVIEW_DRAFTS` is currently set to), so the two runs give a
clean, direct comparison. Prints only safe fields — booleans, the
`perspective`/`useCdn` values, non-secret slugs, and counts — **never**
the token, a full environment dump, or a document body:

```
Preview mode: true
Project configured: true
Dataset configured: true
Token configured: true
Perspective: drafts
useCdn: false
Raw returned document count: 6
Returned slugs: orderly, bookly, quotewave, clientflow, cardsnap, slotsmith
SlotSmith found: yes
Deduplicated app count: 6
Read-only — no content was created, modified, or published.
```

`--published` is expected to show `Perspective: published`, `SlotSmith
found: no`, and a count of `5` (the draft is invisible under the default
perspective, exactly as production behaves).

### Preview indicator

Whenever `SANITY_PREVIEW_DRAFTS=true`, every page (via
`src/layouts/BaseLayout.astro`) shows a small banner: "⚠ Sanity draft
preview — unpublished content. Not visible in production." It never
appears in normal mode, and no internal integration-test metadata
(hold status, reviewer, etc.) is added to the public page — only this one
generic preview notice. A server-side console log also confirms preview
mode on startup; it never logs the token or any credential value.

### Running it locally (Windows PowerShell, from the project root)

```powershell
$env:SANITY_PREVIEW_DRAFTS="true"
npm run dev
```

Then open **http://localhost:4321/apps/slotsmith** (or whatever port
`astro dev` actually binds — it prints the real URL on startup) to see the
unpublished `drafts.appTool-slotsmith` draft rendered as a real page.

To go back to normal (published-only) mode in the same terminal session:

```powershell
Remove-Item Env:\SANITY_PREVIEW_DRAFTS
npm run dev
```

(Closing the terminal also clears it — `SANITY_PREVIEW_DRAFTS` is never
written to `.env` by this workflow, so a fresh terminal always starts in
normal mode.)

**Never deploy with `SANITY_PREVIEW_DRAFTS=true`** — a public Vercel
deployment (or any shared environment) with this flag set would make
unpublished draft content visible to real site visitors. This flag is for
a local `npm run dev` session only; there is no Vercel deployment command
for preview mode, and none should be added.

### Common errors

| Error | Cause |
| --- | --- |
| `SANITY_PREVIEW_DRAFTS=true requires SANITY_API_TOKEN to be set ...` | Preview mode was requested without a token — set `SANITY_API_TOKEN` or unset `SANITY_PREVIEW_DRAFTS`. Also the diagnostic CLI's own error for `--preview` without a token. |
| `growth:check-sanity-preview requires exactly one of --preview or --published.` | Neither or both flags were passed to the diagnostic CLI. |
| `PUBLIC_SANITY_PROJECT_ID and PUBLIC_SANITY_DATASET must both be set in .env to run this check.` | The diagnostic CLI needs both, in either mode (unlike the token, which `--published` never needs). |

**Integration-test drafts (e.g. `drafts.appTool-slotsmith`) must never be
published.** They exist only to prove the preview pipeline itself works
end-to-end — see "Integration-test mode" under CMS Writer above. Publishing
one in Sanity Studio would put unreviewed, non-business-approved content in
front of real site visitors the moment Vercel next rebuilds.

### Generated-app cover image fallback

`growth/agents/asset-generation-agent.ts` never generates a bespoke cover
illustration for a new app — no step in the fixed Growth Loop does. Earlier,
`assembleAssetBundle` wrote a guessed `/images/{slug}/cover.svg` path into
`AssetBundle.app.image` (and CMS Writer copied it verbatim into the Sanity
`appTool.image` field) even though that file was never created — which is
exactly why `drafts.appTool-slotsmith`'s local preview page requested
`/images/slotsmith/cover.svg` and got a real browser 404.

The fix has two parts:

1. **At generation time** (`growth/agents/asset-generation-agent.ts`):
   `app.image` is now set to the shared fallback path
   (`FALLBACK_COVER_IMAGE` from `src/lib/images.ts`,
   `/images/_fallback/cover.svg`) instead of a guessed, unverified
   per-slug path. That file is committed to the repo, so any future
   generated app's stored `image` value is guaranteed to resolve. No
   schema or contract change was needed — `AssetApp.image` /
   `AppToolPayload.image` were already plain, non-empty strings; this
   only changes what value gets written into them.
2. **At render time** (`src/lib/images.ts`, wired into `src/lib/sanity.ts`'s
   `fetchApps()`): every app's `image` and every `screenshots[].image` is
   resolved through `resolveImageSrc()`, which checks the real filesystem
   (`existsSync` against `public/`) and only ever returns either the
   original path (a real file backs it) or `FALLBACK_COVER_IMAGE`. This is
   the safety net for documents this fix can't rewrite — like the existing
   `drafts.appTool-slotsmith` draft, whose stored `image` still says
   `/images/slotsmith/cover.svg` — and for any hand-edited or older Sanity
   document. It never treats slug-based image existence as guaranteed and
   never hard-codes "slotsmith" (or any slug) anywhere in the resolver.

Because this happens once, centrally, in the data layer, `AppCard.astro`
and `AppDetail.astro` needed **no changes at all** — they still just render
`app.image`/`shot.image` directly, and it is always already a real path by
the time they see it. The five hand-authored apps (real files under
`public/images/{slug}/`) are completely unaffected — `resolveImageSrc`
finds their real file and returns the path unchanged. A remote
`http(s)://` image URL (not used by any current app, but supported by the
type) is passed through unchecked rather than treated as missing — this
project doesn't own that file to verify or fabricate it.

`resolveImageSrc`/`applyImageFallbacks` never require a generated image to
exist before a draft page can render, never fabricate or download an
external image, and never add integration-test-specific copy to the
fallback — it's one neutral "Preview coming soon" placeholder
(`public/images/_fallback/cover.svg`) shared by any app in this state.

### Deployment readiness

**Confirmed from this repository:**

- Git remote: `https://github.com/eileen-wl/whacka-growth-site.git`; local
  `main` tracks `origin/main` (`.git/config`).
- Build command: `npm run build` → `astro build` (`package.json`) — a
  standard Astro static build with no custom `vercel-build` script.
- No `vercel.json` in the repo — build/output settings, if customized at
  all, live only in the Vercel project's own dashboard, not in this repo.
- No `.vercel/` directory checked in, no `.github/workflows/` — there is no
  CI/CD pipeline definition of any kind inside this repository.
- No deploy hook URL, webhook config, or Sanity webhook definition exists
  anywhere in the repository, `.env.example`, or this README before this
  section — a Sanity → Vercel rebuild connection, if it exists, is
  configured entirely outside the repo (Sanity's manage UI + Vercel's
  dashboard).
- `PUBLIC_SITE_URL=https://whacka-growth-site.vercel.app` in `.env.example`
  matches the GitHub repo name, consistent with (but not proof of) a
  same-named Vercel project.
- The Astro site defaults to the `"published"` perspective and
  `useCdn: true` unless `SANITY_PREVIEW_DRAFTS=true` is explicitly set —
  see "Why a shell-set `SANITY_PREVIEW_DRAFTS=true` didn't work" above.
  Nothing in this repo sets it anywhere other than as a local, temporary
  shell variable.
- Sanity Studio's own config (`studio/sanity.config.ts`,
  `studio/sanity.cli.ts`) reads `SANITY_STUDIO_PROJECT_ID`/
  `SANITY_STUDIO_DATASET` (a separate env namespace from the Astro site's
  `PUBLIC_SANITY_*`), defaulting dataset to `"production"`. It has no
  webhook/hook configuration of its own.

**Still requires manual verification in the Vercel dashboard** (Vercel
Project Settings):

- Whether `eileen-wl/whacka-growth-site` is actually connected as this
  project's Git repository at all.
- Whether pushes to `main` are configured as the Production deployment
  trigger (Settings → Git → Production Branch).
- Whether a Deploy Hook exists for Sanity to call (Settings → Git → Deploy
  Hooks) — none is referenced anywhere in this repo.
- The actual `PUBLIC_SANITY_DATASET` / `PUBLIC_SANITY_PROJECT_ID` values
  set for the Production environment (Settings → Environment Variables) —
  this repo's `.env`/`.env.example` only prove what a local dev build
  reads, not what Vercel Production reads.
- **That `SANITY_PREVIEW_DRAFTS` is *not* set in the Production environment
  variables** — if it were ever set to `true` there, production would
  serve `drafts.appTool-slotsmith` (or any other draft) to real visitors.
  This repo's code defaults it to `false`/unset, but only the Vercel
  dashboard can confirm nothing overrides that in Production.
- Whether the Production domain actually matches `PUBLIC_SITE_URL`
  (Settings → Domains) — mismatches would produce wrong canonical URLs,
  sitemap entries, and social `destinationUrl` values.

**Still requires manual verification in the Sanity dashboard**
(manage.sanity.io):

- Whether an outbound webhook exists on the `production` dataset that
  calls a Vercel Deploy Hook on publish (Sanity does not rebuild a
  statically-built Astro site on its own — a webhook is the only mechanism
  that could make "Sanity publish → Vercel rebuild" happen automatically).
- If one exists, whether it filters to the `appTool` document type (or
  fires on every dataset write) and whether it fires on publish only or
  also on draft mutation.

### Safe deployment verification plan (documented, not executed in this task)

Goal: prove `Sanity publish → Vercel rebuild → updated public page` works,
without publishing `drafts.appTool-slotsmith` (not business-approved) and
without this task triggering Vercel or mutating Sanity itself.

**A. Sanity webhook test delivery / Vercel Deploy Hook — preferred, if the
above UI checks confirm both exist.** Sanity's manage UI has a "Test"
action on a configured webhook that sends a synthetic sample payload to its
target URL — this validates the Sanity → Vercel handoff without any real
content mutation. This is the safest option because it tests exactly the
automation path in question and touches no content at all. Only usable
once a webhook and Deploy Hook actually exist (currently unconfirmed — see
above).

**B. A harmless, reverted edit to a non-visible field on an already
published, real app — only if A isn't practical.** The Sanity `appTool`
schema's `notes` field ("Internal Notes... not shown on the site" per
`studio/schemaTypes/appTool.ts`) is confirmed, by inspection, to be read
into `AppToolData.notes` (`src/lib/sanity-shared.ts`) but never referenced
by `AppCard.astro`, `AppDetail.astro`, `index.astro`, or `[slug].astro` —
so editing then reverting it on one existing published app (e.g. Orderly)
would exercise a real publish → rebuild cycle without changing any rendered
public content. This is still a real Sanity mutation and a real Vercel
trigger — it requires its own explicit, separate human approval before
anyone runs it; it is not authorized by this task.

**C. A separate staging dataset + protected Vercel Preview environment —
fallback if A and B are both impractical.** Heavier to set up (a second
Sanity dataset, a second set of Vercel environment variables scoped to
Preview deployments) but fully isolates verification from the real
`production` dataset and the real Production deployment. Worth it only if
neither A nor B is workable.

**Do not use `drafts.appTool-slotsmith` for this test under any option** —
it is not business-approved for publication regardless of which
verification path is chosen.

None of A/B/C were implemented or executed as part of this task.

### Growth Site Engine readiness check CLI

```bash
npm run growth:check-site-readiness
```

Read-only: inspects local repository configuration only (env vars via the
same `src/lib/sanity-shared.ts` logic the site itself uses, the real
filesystem for `public/images/_fallback/cover.svg` and `vercel.json`).
Makes no network request to Sanity, Vercel, or anywhere else — it cannot
and does not check account-side settings; see "Deployment readiness"
above for what still needs manual verification. Prints only sanitized
booleans/enums, never a token or deploy-hook URL:

```
[check-site-readiness] Public site URL configured: true
[check-site-readiness] Sanity project configured: true
[check-site-readiness] Sanity dataset configured: true
[check-site-readiness] Production perspective: published
[check-site-readiness] Preview mode disabled by default: true
[check-site-readiness] Fallback cover image exists: true
[check-site-readiness] vercel.json present in repo: false
[check-site-readiness] Deployment automation status: requires_ui_verification
[check-site-readiness] Vercel/Sanity account-side settings (...) cannot be inspected from this repository — verify them in the Vercel and Sanity dashboards. See "Deployment readiness" in growth/README.md.
[check-site-readiness] Read-only — no content was created, modified, published, or deployed.
```

`deploymentAutomationStatus` is `"confirmed"` only when a `vercel.json`
exists in the repo (the one deployment-automation fact a checkout can
prove on its own) — `"requires_ui_verification"` does **not** mean
deployment automation is broken or missing, only that this script cannot
prove it either way from a git checkout.

### Exact next manual steps after this task

1. In the Vercel dashboard, confirm the repo-connection, production-branch,
   and Production environment variable items listed under "Deployment
   readiness" above.
2. In the Sanity manage UI, confirm whether a publish webhook + Vercel
   Deploy Hook already exist; if not, decide (separately from this task)
   whether to configure one.
3. Once both are confirmed, run **Option A** above (webhook test delivery)
   to verify the pipeline without publishing any content.
4. Only after the pipeline is verified — and only with explicit,
   separate business approval — consider publishing a real (non-draft,
   non-integration-test) app. `drafts.appTool-slotsmith` remains
   engineering-only and must not be that app.

