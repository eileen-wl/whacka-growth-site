# Growth data collectors

Server-side scripts that pull raw growth-event data from external analytics
sources into dated local snapshots (`growth/data/raw/`), for the Growth
Report Agent (not yet built) to consume downstream. Nothing in this
directory runs in the browser or ships with the Astro build.

Collectors implemented: **PostHog**, **GA4**, and **Search Console**. Whacka
conversion data is a future collector, not yet built. A deterministic
**Normalizer** (see below) turns those three raw snapshots into one
processed growth-summary file — that's what the future Growth Report Agent
will actually read.

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
