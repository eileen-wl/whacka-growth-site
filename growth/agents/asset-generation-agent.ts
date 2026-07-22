import { deterministicId } from "../lib/ids";
import { buildAssetGenerationLLMRequest } from "../prompts/asset-generation-prompt";
import { assetGenerationAnalysisSchema } from "../types/asset-generation";
import { validateAssetBundle } from "../contracts/asset-bundle";
import { buildExistingContentCatalog } from "../signal-sources/existing-content-catalog";
import { HOMEPAGE_DASHBOARD_URL } from "../../src/lib/utm";
import type { AssetGenerationProvider } from "../llm/asset-generation-provider";
import type { AssetApp, AssetBundle, AssetCreativeBrief, AssetCta, AssetGenerationMeta, AssetSeo, AssetSocial, AssetSocialStrategy, AssetValidation } from "../contracts/asset-bundle";
import type { ScoredTopic } from "../contracts/scored-topic";
import type { TopicCandidate } from "../contracts/topic-candidate";
import type { SupportedLanguage } from "../types/llm";
import type {
  AssetGenerationAnalysis,
  AssetGenerationContext,
  AssetGenerationExistingAppCatalogEntry,
  AssetGenerationIntegrationTestReview,
  CtaInput,
  FinalAssetGenerationRun,
} from "../types/asset-generation";
import type { FinalTopicScoringRun } from "../types/topic-scoring";

export class AssetGenerationInputError extends Error {}
export class AssetGenerationValidationError extends Error {}
export class AssetGenerationSlugError extends Error {}

/** The full set of CTA types the current AssetBundle contract and Astro site support — always the complete list, never filtered by observed evidence (unlike Topic Scoring's decisionScope). */
export const ASSET_GENERATION_ALLOWED_CTA_TYPES = ["view_demo", "remix", "build", "copy_prompt"] as const;

/** Informational only — never parsed back out of the model's response, just gives it a concrete sense of what "complete" content looks like. */
export const CMS_FIELD_REQUIREMENTS: string[] = [
  "app.name, app.tagline, app.shortDescription, app.category are required non-empty strings.",
  "app.problem and app.solution are required non-empty paragraphs (max 2000 characters each).",
  "app.appPrompt is a required non-empty 'Whacka Prompt' a user would submit to build this app (max 4000 characters).",
  "app.faq entries each need both a non-empty question and a non-empty answer.",
  "app.whoItsFor is an optional list of short audience descriptions.",
];

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

// ---------------------------------------------------------------------------
// Existing app catalog (reused from Signal Mining's own reader of the real
// src/data/apps.ts — never a second, independent read of that file).
// ---------------------------------------------------------------------------

export function buildExistingAppCatalog(): AssetGenerationExistingAppCatalogEntry[] {
  return buildExistingContentCatalog().map((entry) => ({
    name: entry.appName,
    slug: entry.appSlug,
    hook: entry.hook,
    status: entry.status,
  }));
}

// ---------------------------------------------------------------------------
// Selected-topic resolution
// ---------------------------------------------------------------------------

export function resolveSelectedTopic(run: FinalTopicScoringRun, topicId: string): { topic: TopicCandidate; scoredTopic: ScoredTopic } {
  const topic = run.topicCatalog.find((candidate) => candidate.id === topicId);
  if (!topic) {
    throw new AssetGenerationInputError(`Selected topic ID "${topicId}" was not found in this Topic Scoring run's topicCatalog.`);
  }
  const scoredTopic = run.scoredTopics.find((candidate) => candidate.topicId === topicId);
  if (!scoredTopic) {
    throw new AssetGenerationInputError(`No ScoredTopic found for topic ID "${topicId}" in this Topic Scoring run.`);
  }
  return { topic, scoredTopic };
}

// ---------------------------------------------------------------------------
// Deterministic generation context
// ---------------------------------------------------------------------------

export interface BuildAssetGenerationContextParams {
  run: FinalTopicScoringRun;
  topic: TopicCandidate;
  scoredTopic: ScoredTopic;
  language: SupportedLanguage;
  requestedSocialChannels: string[];
  existingAppCatalog: AssetGenerationExistingAppCatalogEntry[];
}

/** Builds one deterministic AssetGenerationContext for the explicitly selected topic — never another topic's content, never raw analytics. */
export function buildAssetGenerationContext(params: BuildAssetGenerationContextParams): AssetGenerationContext {
  const { run, topic, scoredTopic } = params;

  return {
    period: run.period,
    campaign: run.campaign,
    topicId: topic.id,
    scoredTopicId: scoredTopic.id,
    canonicalName: topic.canonicalName,
    slug: topic.slug,
    problemStatement: topic.problemStatement,
    targetAudience: topic.targetAudience,
    useCases: topic.useCases,
    desiredOutcome: topic.desiredOutcome,
    rank: scoredTopic.ranking?.rank ?? null,
    candidateCount: scoredTopic.ranking?.candidateCount ?? null,
    totalScore: scoredTopic.totalScore,
    recommendation: scoredTopic.recommendation,
    confidence: scoredTopic.confidence,
    dimensions: scoredTopic.dimensions.map((dimension) => ({
      key: dimension.key,
      label: dimension.label,
      score: dimension.score,
      weight: dimension.weight,
      weightedScore: dimension.weightedScore,
      rationale: dimension.rationale,
      scoreBasis: dimension.scoreBasis ?? null,
      signalRefs: dimension.signalRefs,
      evidenceRefs: dimension.evidenceRefs,
      limitations: dimension.limitations,
    })),
    blockers: scoredTopic.blockers,
    relationshipToExistingContent: {
      status: topic.relationshipToExistingContent.status,
      relatedAppSlugs: topic.relationshipToExistingContent.relatedAppSlugs,
      relatedTopicIds: topic.relationshipToExistingContent.relatedTopicIds,
    },
    sourceScoringIsMock: run.generation.isMock,
    sourceTopicsHumanReviewed: run.humanReview.approved,
    dataQualityWarnings: run.dataQuality.warnings,
    dataQualityLimitations: run.dataQuality.limitations,
    language: params.language,
    allowedCtaTypes: [...ASSET_GENERATION_ALLOWED_CTA_TYPES],
    requestedSocialChannels: params.requestedSocialChannels,
    existingAppCatalog: params.existingAppCatalog,
    cmsFieldRequirements: CMS_FIELD_REQUIREMENTS,
  };
}

// ---------------------------------------------------------------------------
// Structured-output validation
// ---------------------------------------------------------------------------

/**
 * Overclaim phrases banned specifically from social copy (distinct from,
 * and in addition to, the narrower integration-test-only phrase list in
 * growth/prompts/asset-generation-prompt.ts) — a mentor decision that social
 * content must never claim demand is proven/validated or that the concept
 * is market-leading.
 */
const SOCIAL_OVERCLAIM_PHRASES = ["proven demand", "validated opportunity", "confirmed user need", "market-leading", "top-performing product"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic, general (never hardcoded to one specific app name)
 * detection of standalone-app-launch phrasing in social copy — the exact
 * pattern the mentor called out: promoting one isolated mini-app on social
 * media is not meaningful. Built from the actual generated app's own name
 * every time, so this generalizes across any topic or campaign, never a
 * single hardcoded app.
 */
function containsStandaloneLaunchLanguage(text: string, appName: string): boolean {
  const trimmedName = appName.trim();
  if (trimmedName.length === 0) return false;
  const escapedName = escapeRegExp(trimmedName);
  const patterns = [
    new RegExp(`\\bintroducing\\s+${escapedName}\\b`, "i"),
    new RegExp(`\\blaunching\\s+${escapedName}\\b`, "i"),
    new RegExp(`\\btry\\s+our\\s+new\\s+${escapedName}\\b`, "i"),
    new RegExp(`\\b${escapedName}\\s+is\\s+the\\s+solution\\b`, "i"),
    /\bbuild\s+this\s+one\s+app\s+now\b/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function containsSocialOverclaim(text: string): boolean {
  const lower = text.toLowerCase();
  return SOCIAL_OVERCLAIM_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Validates a provider's raw response before it's trusted downstream: (1)
 * the static Zod schema (re-checked for every provider, since the Mock
 * Provider skips the Anthropic SDK's own client-side parsing); (2) every
 * generated social post's channel must be one of the explicitly requested
 * channels — a request for zero channels means zero posts are valid, since
 * an empty allowed-set rejects any post outright; (3) social copy must
 * never read as a standalone single-app launch or make an unsupported
 * demand/market claim; (4) every featured existing-app slug must be real;
 * (5) when social channels were requested and the existing catalog has
 * entries, at least `min(2, catalog size)` distinct existing apps must be
 * featured — the selected app is never the sole featured subject when
 * other collection apps are available. A violation always throws a clear
 * validation error for regeneration — this function never silently rewrites
 * the model's copy.
 */
export function validateAssetGenerationAnalysis(
  rawData: unknown,
  requestedSocialChannels: string[],
  existingAppCatalog: AssetGenerationExistingAppCatalogEntry[] = []
): AssetGenerationAnalysis {
  const parsed = assetGenerationAnalysisSchema.safeParse(rawData);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new AssetGenerationValidationError(`Model response did not match the required schema: ${issues.join("; ")}`);
  }
  const analysis = parsed.data;

  const allowedChannels = new Set(requestedSocialChannels);
  for (const post of analysis.socialPosts) {
    if (!allowedChannels.has(post.channel)) {
      throw new AssetGenerationValidationError(
        `Model generated a social post for channel "${post.channel}", which was not requested. Requested channels: ${
          requestedSocialChannels.join(", ") || "(none)"
        }.`
      );
    }
    if (containsStandaloneLaunchLanguage(post.copy, analysis.appConcept.name)) {
      throw new AssetGenerationValidationError(
        `Social post for channel "${post.channel}" uses standalone-app-launch language (e.g. "Introducing ${analysis.appConcept.name}", ` +
          `"Launching ${analysis.appConcept.name}") — social content must promote the collection/campaign, never present one isolated app as a launch.`
      );
    }
    if (containsSocialOverclaim(post.copy)) {
      throw new AssetGenerationValidationError(
        `Social post for channel "${post.channel}" makes an unsupported claim (proven/validated demand, market-leading, or similar) — not allowed in generated content.`
      );
    }
  }

  const existingSlugSet = new Set(existingAppCatalog.map((entry) => entry.slug));
  for (const slug of analysis.socialFeaturedExistingAppSlugs) {
    if (!existingSlugSet.has(slug)) {
      throw new AssetGenerationValidationError(
        `Model's socialFeaturedExistingAppSlugs references "${slug}", which is not in the supplied existing-app catalog.`
      );
    }
  }
  if (requestedSocialChannels.length > 0) {
    const requiredExistingCount = Math.min(2, existingAppCatalog.length);
    const distinctFeatured = new Set(analysis.socialFeaturedExistingAppSlugs);
    if (distinctFeatured.size < requiredExistingCount) {
      throw new AssetGenerationValidationError(
        `Social content must feature at least ${requiredExistingCount} existing app(s) from the catalog alongside the new concept — the ` +
          `selected app must never be the sole featured subject when other collection apps are available (got ${distinctFeatured.size}).`
      );
    }
  }

  return analysis;
}

// ---------------------------------------------------------------------------
// Slug resolution
// ---------------------------------------------------------------------------

function toKebabSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface SlugResolution {
  slug: string;
  conflicted: boolean;
  originalSuggestion: string;
}

/**
 * Normalizes the provider's slug suggestion to the current frontend routing
 * convention (lowercase, URL-safe, no spaces, no leading/trailing hyphen)
 * and resolves any conflict with an existing app slug deterministically —
 * never by silently overwriting the existing app. Existing apps are never
 * mutated by this function.
 */
export function resolveFinalSlug(suggestion: string, topicId: string, existingSlugs: Set<string>): SlugResolution {
  const base = toKebabSlug(suggestion);
  if (base.length === 0) {
    throw new AssetGenerationSlugError(`Could not resolve a valid slug from the suggested name "${suggestion}".`);
  }
  if (!existingSlugs.has(base)) {
    return { slug: base, conflicted: false, originalSuggestion: suggestion };
  }

  const suffix = deterministicId("slugsuffix", topicId).split("_")[1]?.slice(0, 6) ?? "alt";
  const withSuffix = truncate(`${base}-${suffix}`, 200);
  if (existingSlugs.has(withSuffix)) {
    throw new AssetGenerationSlugError(`Could not resolve a unique slug for topic "${topicId}" — both "${base}" and "${withSuffix}" are already in use.`);
  }
  return { slug: withSuffix, conflicted: true, originalSuggestion: suggestion };
}

// ---------------------------------------------------------------------------
// Deterministic AssetBundle ID
// ---------------------------------------------------------------------------

/**
 * Deliberately NOT `growth/contracts/asset-bundle.ts`'s own `buildAssetBundleId`
 * (which hashes only `scoredTopicId` + `promptVersion`, and is left
 * untouched for full backward compatibility with the front-half contracts
 * work). This Agent's actual requirement is stricter: the same
 * ScoredTopic + promptVersion regenerated in a *different language* must
 * not collide on the same id, so `campaignId`, `topicId`, `finalSlug`, and
 * `language` are all part of the hash basis too.
 */
export function buildFinalAssetBundleId(args: { campaignId: string; topicId: string; finalSlug: string; language: string; promptVersion: string }): string {
  return deterministicId("assetbundle", args.campaignId, args.topicId, args.finalSlug, args.language, args.promptVersion);
}

// ---------------------------------------------------------------------------
// CTA / URL / UTM assembly
// ---------------------------------------------------------------------------

/**
 * `demoUrl`/`remixUrl` are always null in v1 — no real per-app demo or
 * remix target exists yet for a not-yet-built concept, and this Agent never
 * invents one. Since a "primary" CTA is the one prominently rendered, a
 * primary CTA must never point at a URL that doesn't exist: `"view_demo"`
 * and `"remix"` always lack a real URL in v1, so choosing either as the
 * primary type is deterministically replaced with `"build"` (whose URL —
 * `src/lib/utm.ts`'s real, platform-wide `HOMEPAGE_DASHBOARD_URL` — always
 * exists). `"copy_prompt"` is not a navigation CTA at all (it copies text,
 * it doesn't link anywhere), so it is never considered to have a "missing"
 * URL and is left as-is. `app.ctaHref` mirrors the existing project
 * convention of `"#"` as the safe no-real-target placeholder (see
 * growth/contracts/README.md) for `"copy_prompt"`.
 */
const CTA_TYPES_REQUIRING_AN_UNAVAILABLE_URL = new Set<CtaInput["primaryType"]>(["view_demo", "remix"]);

export interface CtaResolution {
  ctaLabel: string;
  ctaHref: string;
  cta: AssetCta;
  /** True when the model's requested primaryType had no available URL in v1 and was deterministically replaced with "build" instead. */
  fallbackApplied: boolean;
  requestedPrimaryType: CtaInput["primaryType"];
}

export function resolveCtaAndUrls(cta: CtaInput, finalSlug: string): CtaResolution {
  const fallbackApplied = CTA_TYPES_REQUIRING_AN_UNAVAILABLE_URL.has(cta.primaryType);
  const effectiveType = fallbackApplied ? "build" : cta.primaryType;

  const ctaHref = effectiveType === "build" ? HOMEPAGE_DASHBOARD_URL : "#";
  const ctaLabel = (effectiveType === "build" ? cta.labels.build : null) ?? cta.labels.primary;

  return {
    ctaLabel,
    ctaHref,
    fallbackApplied,
    requestedPrimaryType: cta.primaryType,
    cta: {
      primaryType: effectiveType,
      demoUrl: null,
      remixUrl: null,
      buildUrl: HOMEPAGE_DASHBOARD_URL,
      labels: { viewDemo: cta.labels.viewDemo, remix: cta.labels.remix, build: cta.labels.build, copyPrompt: cta.labels.copyPrompt },
      utmContent: finalSlug,
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic validation status (agent-level concept: "valid"/"needs_review";
// distinct from the contract's own `validation.status: "draft"|"needs_review"`
// field, which "valid" maps onto "draft" for)
// ---------------------------------------------------------------------------

export interface ValidationStatusContext {
  sourceIsMock: boolean;
  topicHumanReviewed: boolean;
  allowUnapprovedTopicUsed: boolean;
  allowHoldTopicUsed: boolean;
  recommendation: string;
  hasAssumptionsOrLimitations: boolean;
  primaryCtaUrlAvailable: boolean;
  generationIsMock: boolean;
  /** True only for a run produced under the explicit `--integration-test` engineering override. Optional/defaults to false so existing callers are unaffected. */
  integrationTestActive?: boolean;
}

export function computeValidationStatus(ctx: ValidationStatusContext): { status: "valid" | "needs_review"; reasons: string[] } {
  const reasons: string[] = [];

  if (ctx.sourceIsMock) reasons.push("Source Topic Scoring run was mock-generated.");
  if (!ctx.topicHumanReviewed) reasons.push("Source topics have not been human-approved.");
  if (ctx.allowUnapprovedTopicUsed) reasons.push("--allow-unapproved-topic was used to override the human-approval requirement.");
  if (ctx.allowHoldTopicUsed) reasons.push("--allow-hold-topic was used to override the default rejection of a 'hold' topic.");
  if (ctx.recommendation === "needs_human_review" || ctx.recommendation === "hold") {
    reasons.push(`Selected topic's recommendation is "${ctx.recommendation}".`);
  }
  if (ctx.hasAssumptionsOrLimitations) reasons.push("Generated content includes assumptions or limitations requiring review.");
  if (!ctx.primaryCtaUrlAvailable) reasons.push("No real URL is available for the selected primary CTA type.");
  if (ctx.generationIsMock) reasons.push("Content was generated by the Mock Provider.");
  if (ctx.integrationTestActive) {
    reasons.push("Generated under an explicit engineering integration-test override — never a business-approved experiment.");
  }

  return { status: reasons.length > 0 ? "needs_review" : "valid", reasons };
}

// ---------------------------------------------------------------------------
// AssetBundle assembly
// ---------------------------------------------------------------------------

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function prefixedList(prefix: string, items: string[]): string[] {
  return items.map((item) => truncate(`${prefix}: ${item}`, 500));
}

const NEAR_DUPLICATE_TOKEN_MIN_LENGTH = 3;
const NEAR_DUPLICATE_OVERLAP_THRESHOLD = 0.6;

function tokenizeForNearDuplicateCheck(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= NEAR_DUPLICATE_TOKEN_MIN_LENGTH)
  );
}

/** Overlap (Szymkiewicz–Simpson) coefficient — |A∩B| / min(|A|,|B|). Chosen over Jaccard because a short paraphrase of a longer sentence should still count as near-identical even though the two token sets are very different sizes. */
function tokenOverlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / Math.min(a.size, b.size);
}

/**
 * Deterministically drops near-identical entries from a single list (e.g.
 * assumptions, or limitations — never called across the two, since an
 * assumption and a limitation are never interchangeable regardless of
 * wording overlap), keeping the first (earliest) occurrence of each
 * near-duplicate group. Pure token-overlap text similarity only — no
 * semantic/AI comparison, no topic-specific keywords, so this stays general
 * across any topic or content. A genuinely distinct entry (low token
 * overlap with everything already kept) is always preserved.
 */
export function dedupeNearIdenticalText(items: string[], threshold: number = NEAR_DUPLICATE_OVERLAP_THRESHOLD): string[] {
  const kept: string[] = [];
  const keptTokenSets: Set<string>[] = [];

  for (const item of items) {
    const tokens = tokenizeForNearDuplicateCheck(item);
    const isNearDuplicate = keptTokenSets.some((keptTokens) => tokenOverlapCoefficient(tokens, keptTokens) >= threshold);
    if (!isNearDuplicate) {
      kept.push(item);
      keptTokenSets.push(tokens);
    }
  }

  return kept;
}

export interface AssembleAssetBundleProvenance {
  sourceFileNames: string[];
  sourceHashes: string[];
  provider: string;
  model: string | null;
  isMock: boolean;
}

export interface AssembleAssetBundleParams {
  analysis: AssetGenerationAnalysis;
  context: AssetGenerationContext;
  finalSlug: string;
  slugConflicted: boolean;
  slugOriginalSuggestion: string;
  campaignId: string;
  generatedAt: string;
  promptVersion: string;
  provenance: AssembleAssetBundleProvenance;
  allowUnapprovedTopicUsed: boolean;
  allowHoldTopicUsed: boolean;
  /** True only for a run produced under the explicit `--integration-test` engineering override. Optional/defaults to false so existing callers are unaffected. */
  integrationTestActive?: boolean;
  /**
   * The public collection/campaign landing page URL (see `PUBLIC_SITE_URL`
   * in .env.example) — never an app-specific URL, never the Whacka
   * dashboard. `null`/omitted when not configured; never fabricated. Only
   * consulted when at least one social post exists.
   */
  collectionDestinationUrl?: string | null;
}

const COLLECTION_URL_NOT_CONFIGURED_WARNING =
  "No public collection landing page URL is configured (PUBLIC_SITE_URL) — social destinationUrl is null. Do not fabricate a link when sharing this content.";

export interface BuildSocialStrategyParams {
  analysis: AssetGenerationAnalysis;
  context: AssetGenerationContext;
  finalSlug: string;
  campaignId: string;
  destinationUrl: string | null;
  cta: AssetCta;
}

/**
 * Deterministically assembles the collection-level social strategy — never
 * trusted from the model, the same precedent already established for CTA
 * URLs/UTM. `featuredAppSlugs` always includes the new app's own final slug
 * (never omitted) plus whichever existing-app slugs the model chose and
 * validation already confirmed are real — so the new app is present but
 * never the sole subject. Throws (never silently corrects) if the supplied
 * `destinationUrl` would collide with the Whacka dashboard or the app's own
 * demo/remix/build URL — this should never happen given `destinationUrl`
 * only ever comes from the public site configuration, but a collision would
 * silently defeat the entire "promote the collection, not one app" goal, so
 * it is asserted defensively rather than assumed.
 */
export function buildSocialStrategy(params: BuildSocialStrategyParams): AssetSocialStrategy {
  if (params.destinationUrl !== null) {
    if (params.destinationUrl === HOMEPAGE_DASHBOARD_URL) {
      throw new AssetGenerationValidationError("Internal error: the collection social destinationUrl must never be the Whacka dashboard URL.");
    }
    const appUrls = [params.cta.demoUrl, params.cta.remixUrl, params.cta.buildUrl].filter((url): url is string => url !== null);
    if (appUrls.includes(params.destinationUrl)) {
      throw new AssetGenerationValidationError(
        "Internal error: the collection social destinationUrl must never equal the selected app's own demo/remix/build URL."
      );
    }
  }

  const featuredAppSlugs = dedupe([params.finalSlug, ...params.analysis.socialFeaturedExistingAppSlugs]);

  return {
    scope: "collection",
    campaignId: params.campaignId,
    campaignName: params.context.campaign.name,
    featuredAppSlugs,
    destinationUrl: params.destinationUrl,
    utmContent: truncate(`collection_${params.campaignId}`, 160),
  };
}

/**
 * Deterministically assembles the final AssetBundle contract from validated
 * provider output. The provider never controls IDs, campaign/topic/
 * scoredTopic identity, slug-conflict resolution, status, URLs, UTM values,
 * human-review state, provenance, or the final validation status — all of
 * that is computed here, never trusted from the model.
 */
export function assembleAssetBundle(params: AssembleAssetBundleParams): AssetBundle {
  const { analysis, context } = params;
  const { ctaLabel, ctaHref, cta, fallbackApplied: ctaFallbackApplied, requestedPrimaryType: requestedCtaPrimaryType } = resolveCtaAndUrls(
    analysis.cta,
    params.finalSlug
  );

  const app: AssetApp = {
    name: analysis.appConcept.name,
    slug: params.finalSlug,
    tagline: analysis.appConcept.tagline,
    category: analysis.appConcept.category,
    shortDescription: analysis.appConcept.shortDescription,
    image: `/images/${params.finalSlug}/cover.svg`,
    screenshots: [],
    problem: analysis.appConcept.problem,
    solution: analysis.appConcept.solution,
    whoItsFor: analysis.appConcept.whoItsFor,
    appPrompt: analysis.appConcept.appPrompt,
    ctaLabel,
    ctaHref,
    relatedSlugs: context.relationshipToExistingContent.relatedAppSlugs,
    faq: analysis.seo.faq,
    status: "draft",
  };

  const creativeBrief: AssetCreativeBrief = {
    hook: analysis.appConcept.creativeBrief.hook,
    persona: analysis.appConcept.creativeBrief.persona,
    scenario: analysis.appConcept.creativeBrief.scenario,
    steps: analysis.appConcept.steps.map((step) => truncate(`${step.title} — ${step.description}`, 500)),
  };

  const seo: AssetSeo = {
    title: analysis.seo.title,
    metaDescription: analysis.seo.metaDescription,
    primaryKeyword: analysis.seo.primaryKeyword,
    secondaryKeywords: analysis.seo.secondaryKeywords,
  };

  const socialPosts = analysis.socialPosts.map((post) => ({ channel: post.channel, text: post.copy }));
  const socialStrategy: AssetSocialStrategy | undefined =
    socialPosts.length > 0
      ? buildSocialStrategy({
          analysis,
          context,
          finalSlug: params.finalSlug,
          campaignId: params.campaignId,
          destinationUrl: params.collectionDestinationUrl ?? null,
          cta,
        })
      : undefined;
  const social: AssetSocial = socialStrategy ? { posts: socialPosts, strategy: socialStrategy } : { posts: socialPosts };

  const hasAssumptionsOrLimitations =
    analysis.appConcept.creativeBrief.assumptions.length +
      analysis.appConcept.creativeBrief.limitations.length +
      analysis.generationNotes.assumptions.length +
      analysis.generationNotes.limitations.length >
    0;

  const integrationTestActive = params.integrationTestActive ?? false;

  const { status: agentStatus } = computeValidationStatus({
    sourceIsMock: context.sourceScoringIsMock,
    topicHumanReviewed: context.sourceTopicsHumanReviewed,
    allowUnapprovedTopicUsed: params.allowUnapprovedTopicUsed,
    allowHoldTopicUsed: params.allowHoldTopicUsed,
    recommendation: context.recommendation,
    hasAssumptionsOrLimitations,
    primaryCtaUrlAvailable: cta.primaryType === "build",
    generationIsMock: params.provenance.isMock,
    integrationTestActive,
  });

  const dedupedAssumptions = dedupeNearIdenticalText([...analysis.appConcept.creativeBrief.assumptions, ...analysis.generationNotes.assumptions]);
  const dedupedLimitations = dedupeNearIdenticalText([...analysis.appConcept.creativeBrief.limitations, ...analysis.generationNotes.limitations]);

  const warnings = dedupe([
    ...(integrationTestActive
      ? [
          "Generated under explicit engineering integration-test override.",
          `Source topic recommendation is "${context.recommendation}".`,
          "This output is not approved as a business experiment.",
          "Human content review is required before any CMS draft write.",
        ]
      : []),
    ...(params.slugConflicted
      ? [truncate(`Suggested slug "${params.slugOriginalSuggestion}" conflicts with an existing app; using "${params.finalSlug}" instead.`, 500)]
      : []),
    ...(context.sourceScoringIsMock ? ["Source Topic Scoring run was mock-generated (generation.isMock = true)."] : []),
    ...(!context.sourceTopicsHumanReviewed ? ["Source topics have not been human-approved (humanReview.approved = false)."] : []),
    ...(context.recommendation !== "advance"
      ? [truncate(`Selected topic's recommendation is "${context.recommendation}", not "advance".`, 500)]
      : []),
    ...(params.provenance.isMock ? ["Generated by the Mock Provider — content is for engineering validation only, not real market copy."] : []),
    ...(ctaFallbackApplied
      ? [
          truncate(
            `CTA fallback: requested primary CTA type "${requestedCtaPrimaryType}" has no available URL in v1 — used "build" (the real dashboard destination) instead.`,
            500
          ),
        ]
      : []),
    ...(socialStrategy && socialStrategy.destinationUrl === null ? [COLLECTION_URL_NOT_CONFIGURED_WARNING] : []),
    ...prefixedList("Assumption", dedupedAssumptions),
    ...prefixedList("Limitation", dedupedLimitations),
    truncate(`Topic alignment: ${analysis.generationNotes.topicAlignment}`, 500),
    truncate(`Differentiation from existing apps: ${analysis.generationNotes.differentiationFromExistingApps}`, 500),
  ]).slice(0, 50);

  const validation: AssetValidation = {
    status: agentStatus === "valid" ? "draft" : "needs_review",
    warnings,
    humanReviewRequired: true,
  };

  const generation: AssetGenerationMeta = {
    provider: params.provenance.provider,
    model: params.provenance.model,
    isMock: params.provenance.isMock,
    promptVersion: params.promptVersion,
    evidenceRefs: dedupe(context.dimensions.flatMap((dimension) => dimension.evidenceRefs)),
    signalRefs: dedupe(context.dimensions.flatMap((dimension) => dimension.signalRefs)),
    findingRefs: [],
  };

  const bundle: AssetBundle = {
    schemaVersion: "1.0.0",
    id: buildFinalAssetBundleId({
      campaignId: params.campaignId,
      topicId: context.topicId,
      finalSlug: params.finalSlug,
      language: context.language,
      promptVersion: params.promptVersion,
    }),
    scoredTopicId: context.scoredTopicId,
    topicId: context.topicId,
    campaignId: params.campaignId,
    generatedAt: params.generatedAt,
    app,
    creativeBrief,
    seo,
    cta,
    social,
    generation,
    validation,
    provenance: {
      generatedBy: "asset-generation-agent",
      sourceFileNames: params.provenance.sourceFileNames,
      sourceHashes: params.provenance.sourceHashes,
      sourceRecordIds: [context.scoredTopicId],
      sourceDecisionId: null,
      provider: params.provenance.provider,
      model: params.provenance.model,
      isMock: params.provenance.isMock,
      humanReviewed: false,
    },
  };

  return validateAssetBundle(bundle);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunAssetGenerationAgentParams {
  /** Already loaded and validated by the caller (script) — see growth/scripts/generate-assets.ts. */
  run: FinalTopicScoringRun;
  topicId: string;
  sourceFilename: string;
  sourceSha256: string;
  language: SupportedLanguage;
  maxTokens: number;
  promptVersion: string;
  provider: AssetGenerationProvider;
  requestedSocialChannels: string[];
  allowMockInputUsed: boolean;
  allowUnapprovedTopicUsed: boolean;
  allowHoldTopicUsed: boolean;
  /**
   * Present only for an explicit `--integration-test` engineering run (see
   * growth/scripts/generate-assets.ts's integration-test gate) — undefined
   * for every normal run. When present, the resulting
   * FinalAssetGenerationRun.executionPurpose is "integration_test" instead
   * of the default "business_experiment", and `integrationTestReview` is
   * populated. Never inferred from anything else — the caller must have
   * already fully validated the override.
   */
  integrationTest?: { reviewedBy: string; reviewNote: string | null };
  /**
   * The public collection/campaign landing page URL (see `PUBLIC_SITE_URL`
   * in .env.example) — never fabricated when unset. Only consulted when at
   * least one social channel was requested.
   */
  collectionDestinationUrl?: string | null;
  /** Injectable for deterministic tests; defaults to the current time. */
  generatedAt?: string;
}

/**
 * Runs the full Asset Generation Agent pipeline against an already-loaded,
 * already-validated FinalTopicScoringRun and an explicitly selected topic
 * ID: resolve the topic/scored-topic, build the deterministic context,
 * build the LLM request, call the given provider, validate the response,
 * resolve the slug, and assemble the final AssetBundle. Depends only on the
 * provider-neutral AssetGenerationProvider interface — never imports an SDK
 * directly. Never writes to Sanity, never creates a CMSWriteRequest, never
 * touches the Astro site.
 */
export async function runAssetGenerationAgent(params: RunAssetGenerationAgentParams): Promise<FinalAssetGenerationRun> {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const { topic, scoredTopic } = resolveSelectedTopic(params.run, params.topicId);
  const existingAppCatalog = buildExistingAppCatalog();
  const integrationTestActive = params.integrationTest !== undefined;

  const context = buildAssetGenerationContext({
    run: params.run,
    topic,
    scoredTopic,
    language: params.language,
    requestedSocialChannels: params.requestedSocialChannels,
    existingAppCatalog,
  });

  const request = buildAssetGenerationLLMRequest({
    campaign: params.run.campaign,
    period: params.run.period,
    language: params.language,
    context,
    allowedCtaTypes: [...ASSET_GENERATION_ALLOWED_CTA_TYPES],
    requestedSocialChannels: params.requestedSocialChannels,
    maxTokens: params.maxTokens,
    integrationTest: integrationTestActive,
  });

  const result = await params.provider.generateStructuredAssets(request);
  const analysis = validateAssetGenerationAnalysis(result.data, params.requestedSocialChannels, existingAppCatalog);

  const isMock = params.provider.name === "mock";
  const existingSlugs = new Set(existingAppCatalog.map((entry) => entry.slug));
  const slugResolution = resolveFinalSlug(analysis.appConcept.slugSuggestion, context.topicId, existingSlugs);

  const assetBundle = assembleAssetBundle({
    analysis,
    context,
    finalSlug: slugResolution.slug,
    slugConflicted: slugResolution.conflicted,
    slugOriginalSuggestion: slugResolution.originalSuggestion,
    campaignId: params.run.campaign.id,
    generatedAt,
    promptVersion: params.promptVersion,
    provenance: { sourceFileNames: [params.sourceFilename], sourceHashes: [params.sourceSha256], provider: result.provider, model: result.model, isMock },
    allowUnapprovedTopicUsed: params.allowUnapprovedTopicUsed,
    allowHoldTopicUsed: params.allowHoldTopicUsed,
    integrationTestActive,
    collectionDestinationUrl: params.collectionDestinationUrl,
  });

  const integrationTestReview: AssetGenerationIntegrationTestReview | null = params.integrationTest
    ? {
        confirmed: true,
        reviewedBy: params.integrationTest.reviewedBy,
        reviewNote: params.integrationTest.reviewNote,
        sourceRecommendation: scoredTopic.recommendation,
        businessApprovalGranted: false,
      }
    : null;

  return {
    schemaVersion: "1.0.0",
    runType: "asset_generation",
    generatedAt,
    period: params.run.period,
    campaign: params.run.campaign,
    provenance: {
      sourceTopicScoringFilename: params.sourceFilename,
      sourceTopicScoringSha256: params.sourceSha256,
      sourceTopicScoringGeneratedAt: params.run.generatedAt,
      sourceTopicScoringProvider: params.run.generation.provider,
      sourceTopicScoringModel: params.run.generation.model,
      sourceTopicScoringIsMock: params.run.generation.isMock,
      sourceTopicsHumanReviewed: params.run.humanReview.approved,
      selectedTopicId: topic.id,
      selectedScoredTopicId: scoredTopic.id,
      allowMockInputUsed: params.allowMockInputUsed,
      allowUnapprovedTopicUsed: params.allowUnapprovedTopicUsed,
      allowHoldTopicUsed: params.allowHoldTopicUsed,
    },
    generation: {
      provider: result.provider,
      model: result.model,
      language: params.language,
      promptVersion: params.promptVersion,
      isMock,
      requestId: result.requestId,
      stopReason: result.stopReason,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    },
    selectedTopic: topic,
    selectedScoredTopic: scoredTopic,
    assetBundle,
    compatibility: {
      sanityAppToolCompatible: true,
      astroAppDataCompatible: true,
      seoPersistenceAvailable: true,
      cmsWritePerformed: false,
      siteModified: false,
      warnings: [],
    },
    humanReview: {
      required: true,
      approved: false,
      approvedBy: null,
      approvedAt: null,
      note: "AssetBundle must be reviewed before CMS Writer creates a Sanity draft.",
    },
    dataQuality: {
      overallStatus: params.run.dataQuality.overallStatus,
      warnings: params.run.dataQuality.warnings,
      limitations: params.run.dataQuality.limitations,
    },
    executionPurpose: integrationTestActive ? "integration_test" : "business_experiment",
    integrationTestReview,
  };
}
