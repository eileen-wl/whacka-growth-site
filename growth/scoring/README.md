# Topic Scoring

Deterministic scoring rubric and math for the Topic Scoring Agent
(`growth/agents/topic-scoring-agent.ts`, step 2 of the fixed Growth Loop).
Nothing in this directory calls an LLM — `topic-scoring-profile.ts` is a
fixed constant, and `topic-scoring-engine.ts` is pure arithmetic. The model
only ever supplies **per-dimension raw scores** (see
`growth/types/topic-scoring.ts`'s `TopicScoringAnalysis`); weighting,
totals, ranking, confidence caps, and the final recommendation are computed
here, the same way every time for the same input.

## Profile versioning

`profileId` is `small_business_topic_scoring`, `profileVersion` is
`1.0.0`. "Fixed" means `topic-scoring-profile.ts` exports one constant
profile object — there is no runtime rubric builder or per-run
configuration. A future rubric change (different weights, a renamed
dimension, an added dimension) ships as a **new profile version**
(`1.1.0`/`2.0.0`) and is never a silent edit to what
`small_business_topic_scoring@1.0.0` meant for topics already scored under
it — the same discipline `growth/contracts/scored-topic.ts`'s own
`scoringVersion` field already assumes. `ScoredTopic.scoringVersion` is set
to `${profileId}@${profileVersion}` for exactly this reason.

## Dimensions and weights

| Dimension | Weight | Score direction |
| --- | --- | --- |
| `demand` | 0.20 | Higher = signals indicate a real, repeated need or engagement pattern. Not total market demand; never invented search volume. |
| `audience_relevance` | 0.15 | Higher = topic closely matches the audiences actually present in the supplied signals/TopicCandidate. |
| `product_fit` | 0.20 | Higher = topic maps cleanly onto a Whacka-style mini-app or growth-site use case, using only the supplied context. Never claims an unsupported platform capability. |
| `competition` | 0.10 | Higher = **less** observed overlap/saturation in the supplied evidence and **less** duplication with existing campaign content — an opportunity-favourability score, not a claim about the whole external market. |
| `feasibility` | 0.15 | Higher = topic can be turned into a narrow, testable mini-app concept using the current system. No unsupported engineering-effort claims. |
| `novelty` | 0.10 | Higher = topic is meaningfully distinct from the campaign's existing apps and topic pool. |
| `evidence_strength` | 0.10 | Higher = supporting signals are strong, direct, diverse, and traceable. |

Weights sum to exactly `1.0` (`assertWeightsSumToOne` in
`topic-scoring-profile.ts` throws at module load if they ever don't — a
weight typo in a future edit fails immediately, not silently).

## Fallback-score meaning

When a dimension lacks enough evidence, the model uses
`scoreBasis: "policy_default"` with a score of **50** — "insufficient
evidence to move the score positively or negatively." It is **not** a
measured average, **not** a neutral market signal, and **not** the same as
a real evidence-based score of 50 (which would mean "genuinely mixed
evidence," a different claim). `growth/renderers/topic-scoring-markdown.ts`
always labels which scores are which. This matters most for `competition`,
`demand`, and `feasibility` — dimensions where an LLM might otherwise be
tempted to guess at unavailable external-market or platform-capability
information.

## Deterministic math

For each of a topic's 7 dimensions:

```
weightedScore = round(score × weight, 2 decimal places)   — contracts/scored-topic.ts's computeWeightedScore
totalScore    = round(sum(weightedScore for all 7 dimensions), 2 decimal places)  — computeTotalScore
```

Both helpers are **reused directly from `growth/contracts/scored-topic.ts`**
— not reimplemented here — so the exact same rounding rule governs both a
document's own internal consistency check (`ScoredTopic`'s Zod refine
already rejects a `weightedScore`/`totalScore` that doesn't match) and this
Agent's calculation. The provider's own output never contains a weight, a
weighted score, or a total — `topicScoringAnalysisSchema` has no field for
any of them, so there is nowhere for the model to put one even if it tried.

## Ranking tie-breaks

`assignRanking()` sorts by, in order:

1. `totalScore` descending
2. `evidence_strength` dimension score descending
3. `demand` dimension score descending
4. `topicId` ascending — the final, always-decisive tie-breaker

Ranks are sequential starting at 1; every `ScoredTopic.ranking.candidateCount`
equals the total number of scored topics in the run. A zero-topic input
produces zero scored topics, no top topic, and no error.

## Recommendation thresholds

Never chosen by the provider — `topicScoringAnalysisSchema` has no
recommendation field. `computeRecommendation()` in
`topic-scoring-engine.ts`:

- **`hold`** — `totalScore < 50`, OR one or more blockers exist. Blockers
  force `hold` regardless of score; this check runs first and always wins.
- **`advance`** — `totalScore >= 70` AND `evidence_strength >= 60` AND zero
  blockers AND final confidence is `high` or `medium` AND the source
  Signal Mining run was **not** mock-generated AND its topics **were**
  human-approved. An `advance` recommendation is still not approval and
  does not trigger Asset Generation — `humanReviewRequired` stays `true`
  regardless.
- **`needs_human_review`** — everything else that isn't `hold`, including
  a topic that would otherwise qualify for `advance` except that the
  source run was mock-generated or its topics weren't human-approved yet.

### Why `reject` is never automatic in v1

`reject` exists in the shared `ScoringDimensionKey`/recommendation
vocabulary (`growth/contracts/scored-topic.ts`) because a downstream human
reviewer needs a place to record "we looked at this and it's a no" — but
that's a **human judgment call**, not something this version of the
pipeline has enough signal to assert on its own. Nothing in
`computeRecommendation()` can return `"reject"`; a genuinely weak topic
lands in `hold` instead, which is the correct "not moving forward right
now" outcome without asserting a permanent, evidence-unsupported
conclusion. A future version could add an explicit human "reject" action
(e.g. via a review UI) — not in scope here.

## Confidence caps

`applyConfidenceCaps()` takes the provider's own topic-level confidence and
applies the **minimum** of it and every applicable cap:

- source Signal Mining run mock-generated → cap `low`
- source topics not human-approved → cap `medium`
- more than 3 of the 7 dimensions used `policy_default` → cap `low`
- the topic has 0 or 1 supporting signals → cap `low`

Only caps that actually reduce confidence below the provider's original
value produce a recorded reason (`TopicScoringConfidenceAdjustment` in the
final run's `confidenceAdjustments`) — an unaffected topic's confidence is
never silently changed, and a downgrade is never silently applied without
saying why.
