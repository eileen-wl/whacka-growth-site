# Growth data collectors

Server-side scripts that pull raw growth-event data from external analytics
sources into dated local snapshots (`growth/data/raw/`), for the Growth
Report Agent (not yet built) to consume downstream. Nothing in this
directory runs in the browser or ships with the Astro build.

Currently implemented: **PostHog** and **GA4**. Search Console and Whacka
conversion data are future collectors, not yet built.

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
