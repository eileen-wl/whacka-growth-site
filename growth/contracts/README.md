# Front-Half Growth Loop Contracts

This directory is **not an Agent**. It has no LLM calls, no network calls, no
file writes, and no Sanity/website side effects. It defines the shared,
strictly-validated data contracts that the front half of the fixed Growth
Loop (steps 1–5) will pass between each other once those Agents are built,
plus the one adapter (`GrowthLoopFeedback`) that lets step 8's output feed
back into steps 1–2 of the next cycle.

```
1. Signal Mining Agent      → SignalCandidate
2. Topic Scoring Agent      → TopicCandidate, ScoredTopic
3. Asset Generation Agent   → AssetBundle
4. CMS Writer                → CMSWriteRequest → Sanity draft
5. Growth Site Engine        → Astro (already built, unaffected)
6. Tracking Layer             (already built, unaffected)
7. Growth Report Agent       (already built)
8. Experiment Decision Agent (already built) → GrowthLoopFeedback
9. → back into step 1/2's signal & topic pool
```

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

## Why each contract exists

### SignalCandidate vs TopicCandidate

A `SignalCandidate` is **one observation** — a single search query row, one
piece of user feedback, one competitor page note. It is evidence, not a
decision: it never carries a score or a topic recommendation. Multiple
`SignalCandidate`s (usually from different sources) get deduplicated and
normalized into a single `TopicCandidate` (`signalRefs` records which ones).
A `TopicCandidate` is still not scored — it's "here's a coherent potential
topic," not "here's whether we should pursue it."

### TopicCandidate vs ScoredTopic

`ScoredTopic` never mutates a `TopicCandidate` — it references one via
`topicId` and layers a dimension-by-dimension score on top
(`demand`, `audience_relevance`, `product_fit`, `competition`, `feasibility`,
`novelty`, `evidence_strength`). `totalScore` must equal the sum of each
dimension's `weightedScore` (`score * weight`) within a small floating-point
tolerance — an LLM-provided total that doesn't match is **rejected**, never
silently recomputed to "fix" it, because a scorer that can't add is a scorer
whose reasoning shouldn't be trusted either. `recommendation: "advance"` is
not the same as publishing — it only means "this cleared the scoring bar,"
and `humanReviewRequired` is always `true` regardless.

If a future scoring pass needs a different dimension vocabulary, bump
`scoringVersion` and document the mapping here rather than changing what an
existing dimension key means for topics already scored under an earlier
version.

### ScoredTopic vs AssetBundle

`AssetBundle` is the complete generated content for one **approved**
`ScoredTopic` (its `recommendation` must not be `"reject"` —
`validateScoredTopicForAssetGeneration` enforces this). It is the only
contract in this directory whose fields are dictated by something outside
this pipeline: the real Sanity `appTool` schema and the real frontend
`AppData` type. See the mapping table below.

### AssetBundle vs CMSWriteRequest

`AssetBundle` is content. `CMSWriteRequest` is a **request to write that
content**, built by `buildCmsWriteRequest()` — still not the write itself.
No file in this directory calls `@sanity/client`. A `CMSWriteRequest`:

- always has `mode: "dry_run"` or `"draft_write"`, never anything that
  implies a live publish
- always has `payload.status === "draft"`
- always has `publishing: { publishRequested: false, publishAllowed: false }`
  — pinned to the literal `false` at the type level, so no code path in this
  version of the contract can flip either to `true`
- carries an `idempotencyKey` and a deterministic `target.documentId`
  (`appTool-{slug}`, the same convention `scripts/seed.ts`'s `toDocId()`
  already uses) so re-issuing the same request is a no-op, not a duplicate

Actually writing a draft to Sanity — calling `client.createOrReplace()` with
`payload` — is future CMS Writer work, out of scope here.

### Why CMSWriteRequest is always draft-only

Because nothing upstream of it (Signal Mining, Topic Scoring, Asset
Generation) involves a human decision yet — every upstream record is machine
generated and `humanReviewRequired: true` by construction. Publishing a
document a human hasn't looked at would defeat the human-review boundary the
rest of this pipeline (Growth Report Agent, Experiment Decision Agent) is
already built around. A later, explicitly-scoped "Publish" pathway can read
an already-`humanReviewed: true` `CMSWriteRequest` and go from draft to
published — that pathway does not exist yet and is not implied by anything
in this directory.

### How Experiment Decision feeds the next loop via GrowthLoopFeedback

`buildGrowthLoopFeedback(finalExperimentDecision, options)` is a pure
function: no LLM call, no network call, no file write. It reads one already-
validated `FinalExperimentDecision` (growth/types/experiment-decision.ts) and:

- copies `handoff.forNextLoop` items destined for `signal_mining` or
  `topic_pool` verbatim (items aimed at `asset_generation`/`manual_review`
  are out of this contract's scope and are intentionally left out — not
  lost, they stay in the source decision on disk)
- for a **deferred** decision, turns each `requiredNextObservations` entry
  into a `signal_mining` instruction and sets `feedbackType:
  "collect_more_data"`
- for a **proceed** decision, turns `recommendedExperiment` into one
  `topic_pool` instruction (using the matching `rankedExperimentOptions`
  entry for `target.topicOrApp`/`ctaType`/`channel`) and derives
  `feedbackType` from that option's `lever` (`cta` → `test_cta`, `channel` →
  `review_channel`, `topic` → `expand_topic`)
- every `evidenceRefs`/`findingRefs`/`limitationRefs` value is copied
  directly from the decision's own catalogs (classified by the existing
  `finding.*` / `data_limit.*` ID prefixes already used by
  `growth/agents/experiment-decision-agent.ts` — never invented here), and a
  defensive post-build check (`assertAllRefsExistInDecision`) throws if any
  ref doesn't actually exist in the source decision's catalogs
- `constraints.allowedTopics` / `allowedCtaTypes` / `allowedChannels` are
  copied from `decision.decisionScope` verbatim — this contract cannot
  expand what Signal Mining/Topic Pool are allowed to touch beyond what the
  Growth Report already observed
- `humanReview` is always `{ required: true, approved: false, approvedBy:
  null, approvedAt: null }`
- a mock-generated decision (`generation.isMock`) is carried through as
  `sourceDecision.isMock` unchanged — never laundered into a non-mock record

`GrowthLoopFeedback` itself does not call Signal Mining or Topic Scoring —
it is input material for whatever consumes it next, same as every other
contract here.

## Null vs. zero semantics

Every numeric metric in this directory (`SignalMetric.value`,
`ScoringDimension.score`/`weight`/`weightedScore`) is a plain
`z.number()` — zero is a valid, meaningful measurement and is never confused
with "we don't know." When a value is genuinely unavailable, the field is
typed `T | null` and set to `null` — it is never fabricated as `0`,
an empty string, or a placeholder URL. This mirrors the rule already
established for the Growth Data Normalizer and Growth Report Agent.

URLs are the clearest example: `AssetBundle.cta.demoUrl` /
`.remixUrl` / `.buildUrl` are `string (url) | null`. The frontend already
hides a CTA whose URL is unavailable — `null` must never be replaced with a
placeholder link to satisfy a "required-looking" field.

## Provenance and reference traceability

Every top-level contract carries a `provenance` block (see
`growth/contracts/common.ts`): which pipeline step generated it
(`generatedBy`), which upstream files/hashes/record IDs it was built from,
whether an LLM was involved and which provider/model, whether it was a mock
run, and whether a human has reviewed it. `sourceFileNames` entries are
validated to be plain filenames — never an absolute local filesystem path.

Every `evidenceRefs` / `findingRefs` / `limitationRefs` / `signalRefs` array
holds **stable ID strings only** — never a re-typed copy of the value they
point at. A consumer resolves the ID against the catalog it came from
(`evidenceCatalog`, `findingCatalog`, `limitationCatalog`, or the upstream
`SignalCandidate[]`) rather than trusting a duplicated, driftable copy.

## Human-review boundaries

Every generated record's human-review flag is hardcoded by the assembling
code, never settable by a model or by the record's own data:

- `SignalCandidate.humanReviewRequired` — `z.literal(true)`
- `ScoredTopic.humanReviewRequired` — `z.literal(true)`
- `AssetBundle.validation.humanReviewRequired` — `z.literal(true)`
- `CMSWriteRequest.validation.humanReviewed` — a plain `boolean`, defaulting
  `false`; the request stays draft-only regardless of its value
- `GrowthLoopFeedback.humanReview` — `{ required: true, approved: false,
  approvedBy: null, approvedAt: null }` by construction, matching the same
  shape `growth/types/experiment-decision.ts`'s `HumanReview` already uses

## Schema versioning

Every top-level contract has a `schemaVersion` string (`"1.0.0"` today).
Rules (`growth/contracts/common.ts`):

- a breaking change (removed/renamed/retyped field, new required field)
  requires a **major** bump
- an additive optional field may ship as a **minor** bump
- a validation-only fix (tightening a regex, fixing a message) may ship as a
  **patch** bump

`schemaVersionSchema` only checks the string's *shape* (`MAJOR.MINOR.PATCH`)
so a forward-compatible minor/patch bump still parses. Each contract's
`validate*()` function separately calls `assertSupportedMajorVersion()`,
which throws `UnsupportedSchemaVersionError` clearly if the major version
doesn't match what this code was built against — no silent misinterpretation
of a breaking-changed document. This is deliberately not a migration
framework; it only gates compatibility.

## AssetBundle → Sanity `appTool` field mapping

`app.*` is a 1:1 mapping to the real `appTool` document
(`studio/schemaTypes/appTool.ts`) and the real frontend `AppData` type
(`src/data/apps.ts`). Nothing in this table was invented — it was read
directly from those two files before this contract was written.

| AssetBundle field       | Sanity `appTool` field         | Notes |
|--------------------------|----------------------------------|-------|
| `app.name`               | `name` (required)                |       |
| `app.slug`                | `slug` (required)                | Sanity stores `{ _type: "slug", current }`; `CMSWriteRequest.payload.slug` matches that exact shape. `AssetBundle.app.slug` stays a plain kebab-case string. |
| `app.tagline`             | `tagline` (required)             |       |
| `app.category`            | `category` (required)            |       |
| `app.shortDescription`    | `shortDescription` (required)    |       |
| `app.image`               | `image` (required)               | Plain conventional path string (e.g. `/images/{slug}/cover.svg`), same convention every existing app fixture uses — not an uploaded Sanity image asset. |
| `app.screenshots`         | `screenshots` (optional)         | `{image, caption}[]`; `CMSWriteRequest` adds a deterministic `_key` per item (see below). |
| `app.problem`             | `problem` (required)             |       |
| `app.solution`            | `solution` (required)            |       |
| `app.whoItsFor`           | `whoItsFor` (optional)           |       |
| `app.appPrompt`           | `prompt` (required, "Whacka Prompt") | Renamed only to avoid colliding with the unrelated LLM-prompt vocabulary used elsewhere in `growth/`. |
| `app.ctaLabel`            | `ctaLabel` (required)            |       |
| `app.ctaHref`             | `ctaHref` (required)             |       |
| `app.relatedSlugs`        | `relatedSlugs` (optional)        |       |
| `app.faq`                 | `faq` (optional)                 | `{question, answer}[]`; `CMSWriteRequest` adds a deterministic `_key` per item. |
| `app.status`              | `status`                         | Pinned to `"draft"` — `AssetBundle`/`CMSWriteRequest` never produce `"published"`. |
| `cta.demoUrl`             | `demoUrl` (optional)             |       |
| `cta.remixUrl`            | `remixUrl` (optional)            |       |
| `cta.buildUrl`            | `buildUrl` (optional)            |       |
| `cta.utmContent`          | `utmContent` (optional)          | The only per-app UTM field Sanity has — `utm_source`/`utm_campaign` are code constants (`src/lib/utm.ts`) and `utm_medium` is derived per CTA type (`src/lib/tracking.ts`), not CMS-configurable. `AssetBundle.cta` deliberately does not model a full `{source,medium,campaign,content}` object for this reason. |
| `seo.title`               | `seo.title` (optional object, required within `CMSWriteRequest.payload`) | |
| `seo.metaDescription`     | `seo.metaDescription`            | |
| `seo.primaryKeyword`      | `seo.primaryKeyword`             | |
| `seo.secondaryKeywords`   | `seo.secondaryKeywords`          | |
| —                          | `notes` (optional, internal)     | Not populated by `AssetBundle`/`CMSWriteRequest` — `payload.notes` is always `null`. Editorial-only field, out of scope for generated content. |

**Resolved gap (previously documented here as unresolved):** the Sanity
`appTool` schema now has a `seo` object field (`title`, `metaDescription`,
`primaryKeyword`, `secondaryKeywords` — see `studio/schemaTypes/appTool.ts`),
added specifically so CMS Writer (step 4) can persist
`AssetBundle.seo.*`. The Sanity field stays optional for backward
compatibility with documents seeded before this change; `CMSWriteRequest.payload.seo`
is a required field because every `CMSWriteRequest` built by
`buildCmsWriteRequest` always has a validated `AssetBundle.seo` to map
from. This is why `CMS_WRITE_REQUEST_SUPPORTED_MAJOR_VERSION` was bumped
from `1` to `2` — a new required payload field is a breaking change per the
versioning rules below. See `growth/cms/README.md` for the full CMS Writer
mapping.

`CMSWriteRequest.payload` mirrors the exact document shape
`scripts/seed.ts` sends to `client.createOrReplace()`: same `_id` convention
(`appTool-{slug}`, from `toDocId()`), same Sanity `slug` object shape, same
`_key`-bearing array items for `screenshots`/`faq` (deterministically
derived here via `deterministicId`, instead of `scripts/seed.ts`'s
`randomUUID()`, so rebuilding a request from an unchanged `AssetBundle`
produces byte-identical output).

## How future Agents should use this directory

A future Signal Mining Agent, Topic Scoring Agent, Asset Generation Agent,
or CMS Writer should:

1. Import the relevant schema/type/`validate*` function from
   `growth/contracts` (or the specific file) — never redefine these shapes
   locally.
2. Build its own domain logic (search integrations, LLM calls, prompt
   templates) entirely outside this directory.
3. Call the matching `validate*()` function on its own output before writing
   it to disk, and call `assertSupportedMajorVersion` (already done inside
   `validate*()`) before trusting anything it reads back in.
4. Use the compatibility helpers already provided here
   (`validateSignalsForTopic`, `validateTopicForScoring`,
   `validateScoredTopicForAssetGeneration`, `buildCmsWriteRequest`,
   `buildGrowthLoopFeedback`) for the input-validation/ID/provenance
   plumbing between stages, rather than re-deriving deterministic IDs or
   provenance shapes independently.

None of the helpers in this directory contain topic-selection, scoring, or
content-generation *logic* — they validate inputs, map already-known fields,
derive deterministic IDs, and reject invalid stage transitions. The actual
intelligence of each Agent is still entirely unimplemented and out of scope
for this directory.
