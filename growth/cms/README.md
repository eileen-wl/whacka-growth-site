# CMS Writer (`growth/cms/`)

Step 4 of the fixed Growth Loop. **Deterministic only — not an LLM Agent.**
Consumes one validated `AssetBundle` (via a `FinalAssetGenerationRun` JSON
produced by step 3, the Asset Generation Agent) and deterministically
produces a Sanity `appTool` **draft** document, either as a local preview
(`--dry-run`, no network call) or as a real, gated Sanity write
(`--write-draft`, explicit human-review confirmation required).

See `growth/README.md` for the pipeline-level overview and CLI usage. This
file documents the internal mapping and module boundaries.

## Module boundaries

| File | Responsibility |
| --- | --- |
| `growth/scripts/write-cms-draft.ts` | CLI entry point: arg parsing, input discovery/validation, human-review gate, output writing |
| `growth/cms/asset-to-cms-request.ts` | Thin adapter onto `growth/contracts/cms-write-request.ts`'s `buildCmsWriteRequest` + draft-id derivation |
| `growth/cms/cms-writer.ts` | Orchestration: validates the AssetBundle, builds the `CMSWriteRequest`, calls the Sanity writer when writing a draft, assembles the `FinalCmsWriterRun` result |
| `growth/cms/sanity-draft-writer.ts` | The only file that constructs a real `@sanity/client` or makes a network call |
| `growth/renderers/cms-write-markdown.ts` | Human-readable Markdown review of a `FinalCmsWriterRun` |

`growth/contracts/cms-write-request.ts` (front-half contracts) owns the
actual `AssetBundle -> CMSWriteRequest -> appTool payload` field mapping and
is reused as-is — CMS Writer never reimplements it.

## AssetBundle -> CMSWriteRequest -> appTool payload mapping

| AssetBundle field | CMSWriteRequest / payload field |
| --- | --- |
| `app.name` | `payload.name` |
| `app.slug` | `payload.slug.current`, and (via `toDocId`) `target.documentId` / `payload._id` |
| `app.tagline` | `payload.tagline` |
| `app.category` | `payload.category` |
| `app.shortDescription` | `payload.shortDescription` |
| `app.image` | `payload.image` |
| `app.screenshots[]` | `payload.screenshots[]` (deterministic `_key` per item) |
| `app.problem` / `app.solution` | `payload.problem` / `payload.solution` |
| `app.whoItsFor` | `payload.whoItsFor` |
| `app.appPrompt` | `payload.prompt` |
| `app.ctaLabel` / `app.ctaHref` | `payload.ctaLabel` / `payload.ctaHref` |
| `app.relatedSlugs` | `payload.relatedSlugs` |
| `app.faq[]` | `payload.faq[]` (deterministic `_key` per item — the FAQ mapping is not duplicated inside `seo`) |
| `cta.demoUrl` / `cta.remixUrl` / `cta.buildUrl` | `payload.demoUrl` / `payload.remixUrl` / `payload.buildUrl` (null stays null, never a placeholder) |
| `cta.utmContent` | `payload.utmContent` |
| `seo.title` | `payload.seo.title` |
| `seo.metaDescription` | `payload.seo.metaDescription` |
| `seo.primaryKeyword` | `payload.seo.primaryKeyword` |
| `seo.secondaryKeywords` | `payload.seo.secondaryKeywords` |
| — | `payload.status` is always `"draft"` |
| — | `payload.notes` is always `null` (CMS Writer never invents editorial notes) |

`payload.seo` mirrors `studio/schemaTypes/appTool.ts`'s optional `seo`
object field. It is a required field on `CMSWriteRequest.payload` because
every `CMSWriteRequest` built by `buildCmsWriteRequest` always has a
validated `AssetBundle.seo` to map from — the Sanity schema field itself
stays optional so older documents without an `seo` object keep validating.

## Deterministic document id / draft id

- `target.documentId` (and `payload._id`) is always the **canonical**
  id, `appTool-{slug}` — identical to `scripts/seed.ts`'s own `toDocId()`
  convention. This is enforced by `growth/contracts/cms-write-request.ts`'s
  own schema refinements and is never changed by CMS Writer.
- The **actual Sanity write target** is derived one layer up, in
  `growth/cms/asset-to-cms-request.ts`'s `buildDraftDocumentId()`:
  `drafts.{canonicalDocumentId}`. Sanity treats any document whose `_id`
  starts with `drafts.` as an unpublished draft — there is no separate
  boolean flag. `growth/cms/sanity-draft-writer.ts` is the only place that
  sends this draft-prefixed `_id` to `client.createOrReplace()`; the
  canonical (published-style) id is never written to.
- `idempotencyKey` is deterministic from the AssetBundle id, the target
  document id, and the operation (see `buildCmsWriteRequest`) — re-running
  CMS Writer against an unchanged AssetBundle always produces the same
  `CMSWriteRequest.id` / `idempotencyKey`, so `createOrReplace` is a safe,
  idempotent re-run rather than an accumulating duplicate.

## Human-review gate

A real Sanity write (`--write-draft`) requires, in addition to a
structurally valid `AssetBundle`:

- `--confirm-reviewed`
- `--reviewed-by <non-empty name>`
- optionally `--review-note "..."`

These flags never mutate the source Asset Generation JSON — they are
recorded only in the CMS Writer's own output (`review` block of the
`FinalCmsWriterRun` / receipt). They are approval to create a Sanity
**draft** only — never approval to publish.

Mock Asset Generation input (`generation.isMock`) is rejected by
`--write-draft` unless `--allow-mock-input` is explicitly passed; a
`--dry-run` preview may always use mock input. An AssetBundle that fails
its own contract validation can never be written, with or without any
override flag.

## Credential safety

- `SANITY_API_TOKEN` (already used by `scripts/seed.ts`) is the only
  credential CMS Writer reads, and only inside the `--write-draft` code
  path — `--dry-run` never reads or requires it.
- The Sanity write client (`growth/cms/sanity-draft-writer.ts`) is
  constructed lazily, only once `--write-draft` has passed every gate.
  `useCdn: false`, matching `scripts/seed.ts`'s existing server-side write
  client.
- The token is never logged, never included in any request/receipt output
  file, and any upstream Sanity error message is sanitized before being
  surfaced (auth/permission/network failures are mapped to a generic,
  token-free message).

## Dry-run vs draft-write

| | `--dry-run` | `--write-draft` |
| --- | --- | --- |
| Network request | None | One `createOrReplace` call |
| Sanity credentials required | No | Yes |
| Human-review flags required | No | Yes |
| Mock input allowed | Yes | Only with `--allow-mock-input` |
| Output | `growth/cms-output/requests/cms-write-request-{start}_to_{end}-{topic-id}.json`/`.md` | `growth/cms-output/receipts/cms-write-receipt-{start}_to_{end}-{topic-id}.json`/`.md` |
| Publishes | Never | Never |

## Remaining manual step

CMS Writer only ever creates or replaces a Sanity **draft** document. No
code path in this project publishes a document or triggers a deployment —
publishing the draft in Sanity Studio (and any subsequent site rebuild)
remains a deliberate, manual, human action outside this pipeline.
