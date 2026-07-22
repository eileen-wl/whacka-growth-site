import { z } from "zod/v4";
import type { AssetBundle } from "../contracts/asset-bundle";
import type { ScoredTopic } from "../contracts/scored-topic";
import type { TopicCandidate } from "../contracts/topic-candidate";
import type { CampaignInfo, DateRange } from "./growth-summary";
import type { SupportedLanguage } from "./llm";

/**
 * Internal Asset Generation Agent input/output types. `AssetGenerationAnalysis`
 * is the model-generated portion only — the model never produces IDs, URLs,
 * UTM values, status fields, or provenance. The Agent's only public output
 * is one `AssetBundle` (growth/contracts/asset-bundle.ts), validated against
 * that contract before being written anywhere.
 */

const NAME = 200;
const TAGLINE = 200;
const CATEGORY = 120;
const SHORT_DESC = 500;
const LONG_DESC = 2000;
const PROMPT = 4000;
const WHO_ITS_FOR_ITEM = 300;
const HOOK = 300;
const PERSONA = 300;
const SCENARIO = 1000;
const STEP_TITLE = 100;
const STEP_DESCRIPTION = 380;
const FAQ_QUESTION = 300;
const FAQ_ANSWER = 1000;
const SEO_TITLE = 200;
const META_DESCRIPTION = 300;
const KEYWORD = 160;
const CTA_LABEL = 200;
const SOCIAL_CHANNEL = 80;
const SOCIAL_COPY = 2000;
/** Assumptions/limitations/notes eventually fold into AssetBundle.validation.warnings (max 500 chars each, including a short prefix like "Assumption: ") — kept well under that ceiling. */
const NOTE = 440;

const nameText = z.string().min(1).max(NAME);
const taglineText = z.string().min(1).max(TAGLINE);
const categoryText = z.string().min(1).max(CATEGORY);
const shortDescText = z.string().min(1).max(SHORT_DESC);
const longDescText = z.string().min(1).max(LONG_DESC);
const promptText = z.string().min(1).max(PROMPT);
const whoItsForItemText = z.string().min(1).max(WHO_ITS_FOR_ITEM);
const hookText = z.string().min(1).max(HOOK);
const personaText = z.string().min(1).max(PERSONA);
const scenarioText = z.string().min(1).max(SCENARIO);
const stepTitleText = z.string().min(1).max(STEP_TITLE);
const stepDescriptionText = z.string().min(1).max(STEP_DESCRIPTION);
const faqQuestionText = z.string().min(1).max(FAQ_QUESTION);
const faqAnswerText = z.string().min(1).max(FAQ_ANSWER);
const seoTitleText = z.string().min(1).max(SEO_TITLE);
const metaDescriptionText = z.string().min(1).max(META_DESCRIPTION);
const keywordText = z.string().min(1).max(KEYWORD);
const ctaLabelText = z.string().min(1).max(CTA_LABEL);
const socialChannelText = z.string().min(1).max(SOCIAL_CHANNEL);
const socialCopyText = z.string().min(1).max(SOCIAL_COPY);
const noteText = z.string().min(1).max(NOTE);

// ---------------------------------------------------------------------------
// AssetGenerationAnalysis — the model-generated portion of a run
// ---------------------------------------------------------------------------

export const assetGenerationCtaTypeSchema = z.enum(["view_demo", "remix", "build", "copy_prompt"]);

const stepInputSchema = z.strictObject({ title: stepTitleText, description: stepDescriptionText });

const creativeBriefInputSchema = z.strictObject({
  hook: hookText,
  persona: z.union([personaText, z.null()]),
  scenario: z.union([scenarioText, z.null()]),
  assumptions: z.array(noteText).max(10),
  limitations: z.array(noteText).max(10),
});

const appConceptSchema = z.strictObject({
  name: nameText,
  slugSuggestion: z.string().min(1).max(160),
  category: categoryText,
  tagline: taglineText,
  shortDescription: shortDescText,
  problem: longDescText,
  solution: longDescText,
  whoItsFor: z.array(whoItsForItemText).max(10),
  steps: z.array(stepInputSchema).min(1).max(10),
  appPrompt: promptText,
  creativeBrief: creativeBriefInputSchema,
});

export type AppConceptInput = z.infer<typeof appConceptSchema>;

const faqItemInputSchema = z.strictObject({ question: faqQuestionText, answer: faqAnswerText });

const seoInputSchema = z.strictObject({
  title: seoTitleText,
  metaDescription: metaDescriptionText,
  primaryKeyword: keywordText,
  secondaryKeywords: z.array(keywordText).max(20),
  faq: z.array(faqItemInputSchema).max(20),
});

export type SeoInput = z.infer<typeof seoInputSchema>;

const ctaLabelsInputSchema = z.strictObject({
  primary: ctaLabelText,
  viewDemo: z.union([ctaLabelText, z.null()]),
  remix: z.union([ctaLabelText, z.null()]),
  build: z.union([ctaLabelText, z.null()]),
  copyPrompt: z.union([ctaLabelText, z.null()]),
});

const ctaInputSchema = z.strictObject({
  primaryType: assetGenerationCtaTypeSchema,
  labels: ctaLabelsInputSchema,
  rationale: noteText,
});

export type CtaInput = z.infer<typeof ctaInputSchema>;

const socialPostInputSchema = z.strictObject({
  channel: socialChannelText,
  variant: z.string().min(1).max(80),
  copy: socialCopyText,
});

export type SocialPostInput = z.infer<typeof socialPostInputSchema>;

const generationNotesSchema = z.strictObject({
  topicAlignment: noteText,
  differentiationFromExistingApps: noteText,
  assumptions: z.array(noteText).max(10),
  limitations: z.array(noteText).max(10),
  requiresHumanReview: z.literal(true),
});

export type GenerationNotes = z.infer<typeof generationNotesSchema>;

/** The model-generated portion of a run. See growth/agents/asset-generation-agent.ts for the cross-referential rules (requested social channels, allowed CTA types) layered on top. */
export const assetGenerationAnalysisSchema = z.strictObject({
  appConcept: appConceptSchema,
  seo: seoInputSchema,
  cta: ctaInputSchema,
  socialPosts: z.array(socialPostInputSchema).max(20),
  generationNotes: generationNotesSchema,
});

export type AssetGenerationAnalysis = z.infer<typeof assetGenerationAnalysisSchema>;

// ---------------------------------------------------------------------------
// Deterministic generation context supplied to the provider
// ---------------------------------------------------------------------------

export interface AssetGenerationExistingAppCatalogEntry {
  name: string;
  slug: string;
  hook: string;
  status: string;
}

export interface AssetGenerationDimensionContext {
  key: string;
  label: string;
  score: number;
  weight: number;
  weightedScore: number;
  rationale: string;
  scoreBasis: "evidence" | "policy_default" | null;
  signalRefs: string[];
  evidenceRefs: string[];
  limitations: string[];
}

export interface AssetGenerationContext {
  period: DateRange;
  campaign: CampaignInfo;
  topicId: string;
  scoredTopicId: string;
  canonicalName: string;
  slug: string;
  problemStatement: string;
  targetAudience: string;
  useCases: string[];
  desiredOutcome: string;
  rank: number | null;
  candidateCount: number | null;
  totalScore: number;
  recommendation: string;
  confidence: string;
  dimensions: AssetGenerationDimensionContext[];
  blockers: string[];
  relationshipToExistingContent: {
    status: string;
    relatedAppSlugs: string[];
    relatedTopicIds: string[];
  };
  sourceScoringIsMock: boolean;
  sourceTopicsHumanReviewed: boolean;
  dataQualityWarnings: string[];
  dataQualityLimitations: string[];
  language: SupportedLanguage;
  allowedCtaTypes: string[];
  requestedSocialChannels: string[];
  existingAppCatalog: AssetGenerationExistingAppCatalogEntry[];
  cmsFieldRequirements: string[];
}

// ---------------------------------------------------------------------------
// LLM request/response contracts
// ---------------------------------------------------------------------------

export interface AssetGenerationLLMRequest {
  purpose: string;
  period: DateRange;
  campaign: CampaignInfo;
  language: SupportedLanguage;
  context: AssetGenerationContext;
  allowedCtaTypes: string[];
  requestedSocialChannels: string[];
  reportingRules: string[];
  responseSchemaDescription: string;
  maxTokens: number;
  systemPrompt: string;
  userPrompt: string;
}

// ---------------------------------------------------------------------------
// Final assembled run
// ---------------------------------------------------------------------------

export interface AssetGenerationProvenance {
  sourceTopicScoringFilename: string;
  sourceTopicScoringSha256: string;
  sourceTopicScoringGeneratedAt: string;
  sourceTopicScoringProvider: string;
  sourceTopicScoringModel: string;
  sourceTopicScoringIsMock: boolean;
  sourceTopicsHumanReviewed: boolean;
  selectedTopicId: string;
  selectedScoredTopicId: string;
  allowMockInputUsed: boolean;
  allowUnapprovedTopicUsed: boolean;
  allowHoldTopicUsed: boolean;
}

export interface AssetGenerationGenerationMetadata {
  provider: string;
  model: string;
  language: SupportedLanguage;
  promptVersion: string;
  isMock: boolean;
  requestId: string | null;
  stopReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

export interface AssetGenerationCompatibility {
  sanityAppToolCompatible: boolean;
  astroAppDataCompatible: boolean;
  seoPersistenceAvailable: boolean;
  cmsWritePerformed: false;
  siteModified: false;
  warnings: string[];
}

export interface AssetGenerationHumanReview {
  required: true;
  approved: false;
  approvedBy: null;
  approvedAt: null;
  note: string;
}

export interface AssetGenerationDataQuality {
  overallStatus: "complete" | "partial" | "invalid";
  warnings: string[];
  limitations: string[];
}

/** The on-disk shape written to growth/assets/asset-generation-{start}_to_{end}-{topic-id}.json. */
export interface FinalAssetGenerationRun {
  schemaVersion: "1.0.0";
  runType: "asset_generation";
  generatedAt: string;
  period: DateRange;
  campaign: CampaignInfo;
  provenance: AssetGenerationProvenance;
  generation: AssetGenerationGenerationMetadata;
  selectedTopic: TopicCandidate;
  selectedScoredTopic: ScoredTopic;
  assetBundle: AssetBundle;
  compatibility: AssetGenerationCompatibility;
  humanReview: AssetGenerationHumanReview;
  dataQuality: AssetGenerationDataQuality;
}

/** The on-disk shape written to growth/data/processed/asset-generation-request-{start}_to_{end}-{topic-id}.json in --dry-run mode. Never includes secrets. */
export interface AssetGenerationDryRunPreview {
  source: "asset_generation_dry_run";
  createdAt: string;
  period: DateRange;
  campaign: CampaignInfo;
  sourceTopicScoringFilename: string;
  sourceTopicScoringSha256: string;
  sourceTopicScoringIsMock: boolean;
  sourceTopicsHumanReviewed: boolean;
  selectedTopicId: string;
  selectedTopicRecommendation: string;
  selectedTopicRank: number | null;
  selectedTopicScore: number;
  overrides: { allowMockInput: boolean; allowUnapprovedTopic: boolean; allowHoldTopic: boolean };
  generationContext: AssetGenerationContext;
  existingAppCatalog: AssetGenerationExistingAppCatalogEntry[];
  requestedSocialChannels: string[];
  language: SupportedLanguage;
  intendedProvider: string;
  intendedModel: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchemaDescription: string;
}
