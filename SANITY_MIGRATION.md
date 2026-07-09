# Sanity CMS migration

The five app records that used to live only in [src/data/apps.ts](src/data/apps.ts) can now be
managed in Sanity as `appTool` documents. The site still works with zero Sanity setup — it falls
back to `src/data/apps.ts` automatically until you connect a real project.

## 1. Create a Sanity project

1. Sign in / sign up at https://www.sanity.io/manage.
2. Create a new project (or use an existing one) and note its **Project ID**.
3. Create a dataset named `production` (the default).

## 2. Configure environment variables

**Root `.env`** (used by the Astro site and the seed script):

```bash
cp .env.example .env
```

Fill in:

- `PUBLIC_SANITY_PROJECT_ID` — your project ID
- `PUBLIC_SANITY_DATASET` — `production`
- `PUBLIC_SANITY_API_VERSION` — a date like `2024-01-01`, or today's date
- `SANITY_API_TOKEN` — only needed to run the seed script. Create one at
  Manage → API → Tokens with **Editor** permission. Keep this secret, it is
  never sent to the browser (not prefixed with `PUBLIC_`).

**`studio/.env`** (used only by Sanity Studio):

```bash
cp studio/.env.example studio/.env
```

Fill in `SANITY_STUDIO_PROJECT_ID` and `SANITY_STUDIO_DATASET` with the same
values as above (Studio requires its own `SANITY_STUDIO_` prefix; it doesn't
read the root `.env`).

## 3. Run the seed script

From the project root:

```bash
npm run seed
```

This reads the five apps from `src/data/apps.ts` and upserts them into Sanity
as `appTool` documents with deterministic IDs (`appTool-orderly`,
`appTool-bookly`, `appTool-quotewave`, `appTool-clientflow`,
`appTool-cardsnap`). Running it again updates the same five documents instead
of creating duplicates, so it's safe to re-run after editing the source data.

## 4. Run Sanity Studio (optional, to edit content visually)

```bash
cd studio
npm install
npm run dev
```

Opens the Studio locally (default http://localhost:3333) where you can edit
the `appTool` documents, including the new fields that don't exist in the
static data yet: `demoUrl`, `remixUrl`, `buildUrl`, `status`, `notes`, and
`utmContent`.

## 5. Run the site against Sanity

```bash
npm run dev
```

`src/lib/sanity.ts` fetches `appTool` documents from Sanity when
`PUBLIC_SANITY_PROJECT_ID`/`PUBLIC_SANITY_DATASET` are set. If they're unset,
the fetch fails, or Sanity returns zero documents, the site silently falls
back to the static list in `src/data/apps.ts` — `npm run dev` and
`npm run build` both work with no Sanity project configured at all.

## Notes on schema choices

To keep this migration simple, the `appTool` schema intentionally does **not**
use Sanity's native `image` asset type or document references yet:

- `image` and `screenshots[].image` are plain string paths (e.g.
  `/images/orderly/cover.svg`), same as before.
- `relatedSlugs` is a plain array of slug strings, not a reference field.
- All copy (`problem`, `solution`, `prompt`, etc.) is plain text, not
  Portable Text.

These can be upgraded later without changing the current site design.
