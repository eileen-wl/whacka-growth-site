import type { AssetGenerationContext, AssetGenerationLLMRequest } from "../types/asset-generation";
import type { CampaignInfo, DateRange } from "../types/growth-summary";
import type { SupportedLanguage } from "../types/llm";

export const ASSET_GENERATION_PURPOSE =
  "Turn one explicitly selected, already-scored TopicCandidate into one complete, coherent mini-app concept and its " +
  "supporting content (app copy, SEO copy, CTA labels, optional social copy). This Agent designs content for a single " +
  "approved topic; it does not select a topic, does not score or rank topics, does not write to Sanity, and does not " +
  "publish or deploy anything.";

/** Each entry is a self-contained "must"/"must not" rule — used verbatim in both the system prompt and request.reportingRules. */
export const REPORTING_RULES: string[] = [
  "You are an evidence-grounded growth asset designer. You may only use the selected TopicCandidate, the selected ScoredTopic assessment, the supplied existing-app catalog, and the supplied campaign/content/CTA/social-channel constraints.",
  "You must create exactly one coherent mini-app concept for the selected topic — not a menu of alternatives.",
  "You must preserve the selected topic's actual problem statement and intended outcome rather than inventing a different one.",
  "You must produce every required content field for the AssetBundle contract (app copy, creative brief, steps, appPrompt, SEO copy, CTA labels).",
  "You must keep the app concept narrow and testable — one clear mini-app, not a broad platform.",
  "You must keep language and tone appropriate for the topic's supplied target audience.",
  "You must avoid duplicating an existing app from the supplied existing-app catalog — check name and concept overlap explicitly.",
  "You must identify assumptions and limitations in generationNotes and creativeBrief.assumptions/limitations rather than presenting a guess as a fact.",
  "You must choose primaryType only from the supplied allowed CTA types.",
  "You must generate social posts only for the explicitly supplied requested social channels — never invent a channel, and produce zero social posts when zero channels were requested.",
  "You must not put any URL in generated prose or in any content field — URLs are constructed deterministically after your response, never by you.",
  "You must keep the app concept's status as draft in your own understanding — you never set a status field yourself.",
  "You must produce only the structured response — no prose outside the schema.",
  "You must not browse the web, use external knowledge, or cite external benchmarks.",
  "You must not invent measured search volume, market size, user quotations, customer numbers, competitor facts, or product-conversion results.",
  "You must not claim a keyword is highly searched unless the selected topic/scored-topic evidence actually supports that.",
  "You must not claim the topic has been validated, that the app already exists, or that a live demo is available.",
  "You must not claim Whacka supports a capability that isn't represented in the supplied context.",
  "You must not copy existing app text with only superficial substitutions — write original copy for this specific concept.",
  "You must not treat a mock-generated score as a real market conclusion, if the supplied context indicates the source scoring run was mock-generated.",
  "You must not generate an id, a URL, a UTM value, a status field, provider metadata, a topic score, a CMS operation field, or a publication field — none of these exist in the response schema.",
  "You must not choose a different topic, change any score, rank topics, or execute an experiment.",
];

export const RESPONSE_SCHEMA_DESCRIPTION = `A single JSON object with these top-level keys:
- appConcept: { name, slugSuggestion (a plain suggestion only — the final slug is resolved deterministically afterward and may differ), category, tagline, shortDescription, problem, solution, whoItsFor (list of audience descriptions), steps (1-10 items, each {title, description}), appPrompt (the actual "Whacka Prompt" a user would submit to build this app), creativeBrief: {hook, persona (string or null), scenario (string or null), assumptions, limitations} }
- seo: { title, metaDescription, primaryKeyword, secondaryKeywords, faq (items {question, answer}) }
- cta: { primaryType (must be one of the supplied allowed CTA types), labels: {primary, viewDemo, remix, build, copyPrompt} (each a label string or null — "primary" is always required), rationale }
- socialPosts: 0 or more items {channel (must be one of the supplied requested social channels — empty array required when zero channels were requested), variant, copy}
- generationNotes: { topicAlignment, differentiationFromExistingApps, assumptions, limitations, requiresHumanReview: true }
No URLs, UTM values, IDs, status fields, provider metadata, topic scores, CMS operation fields, or publication fields are allowed anywhere in the response. No unknown top-level or nested keys are allowed.`;

function languageInstruction(language: SupportedLanguage): string {
  return language === "zh-CN"
    ? "Write every string value in the response (copy, labels, FAQ, social posts, etc.) in Simplified Chinese (zh-CN)."
    : "Write every string value in the response in English (en).";
}

/** Combines the fixed reporting rules with the language instruction for this specific request. */
export function buildReportingRules(language: SupportedLanguage): string[] {
  return [...REPORTING_RULES, languageInstruction(language)];
}

export function buildSystemPrompt(language: SupportedLanguage): string {
  return [
    "You are an evidence-grounded growth asset designer producing one AssetBundle's worth of content for an internal growth loop.",
    "You may only use the selected TopicCandidate, the selected ScoredTopic assessment, the supplied existing-app catalog, and the supplied constraints.",
    "",
    ...buildReportingRules(language).map((rule) => `- ${rule}`),
    "",
    "This Agent designs content only. IDs, URLs, UTM values, status, and validation are computed deterministically afterward, and a human reviews the result before CMS Writer creates a Sanity draft.",
  ].join("\n");
}

export interface BuildUserPromptParams {
  purpose: string;
  period: DateRange;
  campaign: CampaignInfo;
  context: AssetGenerationContext;
  allowedCtaTypes: string[];
  requestedSocialChannels: string[];
  responseSchemaDescription: string;
}

export function buildUserPrompt(params: BuildUserPromptParams): string {
  const warnings = params.context.dataQualityWarnings.length > 0 ? params.context.dataQualityWarnings.map((w) => `- ${w}`).join("\n") : "(none)";
  const channels = params.requestedSocialChannels.length > 0 ? params.requestedSocialChannels.join(", ") : "(none — produce zero social posts)";

  return [
    `Purpose: ${params.purpose}`,
    "",
    `Reporting period: ${params.period.start} to ${params.period.end}`,
    `Campaign: ${params.campaign.name} (id: ${params.campaign.id})`,
    "",
    `Source Topic Scoring run mock-generated: ${params.context.sourceScoringIsMock}`,
    `Source topics human-approved: ${params.context.sourceTopicsHumanReviewed}`,
    `Allowed CTA types: ${params.allowedCtaTypes.join(", ")}`,
    `Requested social channels: ${channels}`,
    "",
    "Selected topic and scored-topic assessment (the ONLY evidence you may cite or build from):",
    JSON.stringify(
      {
        topicId: params.context.topicId,
        canonicalName: params.context.canonicalName,
        problemStatement: params.context.problemStatement,
        targetAudience: params.context.targetAudience,
        useCases: params.context.useCases,
        desiredOutcome: params.context.desiredOutcome,
        rank: params.context.rank,
        candidateCount: params.context.candidateCount,
        totalScore: params.context.totalScore,
        recommendation: params.context.recommendation,
        confidence: params.context.confidence,
        dimensions: params.context.dimensions,
        blockers: params.context.blockers,
        relationshipToExistingContent: params.context.relationshipToExistingContent,
      },
      null,
      2
    ),
    "",
    "Existing app catalog (avoid duplicating any of these; never propose a slug or name matching one exactly):",
    JSON.stringify(params.context.existingAppCatalog, null, 2),
    "",
    "Current CMS/AppData field requirements (informational — you do not set these fields yourself, but your content must be substantial enough to fill them):",
    JSON.stringify(params.context.cmsFieldRequirements, null, 2),
    "",
    "Data-quality warnings carried over from the source pipeline:",
    warnings,
    "",
    "Required response structure:",
    params.responseSchemaDescription,
  ].join("\n");
}

export interface BuildAssetGenerationLLMRequestParams {
  campaign: CampaignInfo;
  period: DateRange;
  language: SupportedLanguage;
  context: AssetGenerationContext;
  allowedCtaTypes: string[];
  requestedSocialChannels: string[];
  maxTokens: number;
}

/** Builds the full, ready-to-send request: rendered system/user prompt strings plus the structured content they came from. */
export function buildAssetGenerationLLMRequest(params: BuildAssetGenerationLLMRequestParams): AssetGenerationLLMRequest {
  const reportingRules = buildReportingRules(params.language);

  const systemPrompt = buildSystemPrompt(params.language);
  const userPrompt = buildUserPrompt({
    purpose: ASSET_GENERATION_PURPOSE,
    period: params.period,
    campaign: params.campaign,
    context: params.context,
    allowedCtaTypes: params.allowedCtaTypes,
    requestedSocialChannels: params.requestedSocialChannels,
    responseSchemaDescription: RESPONSE_SCHEMA_DESCRIPTION,
  });

  return {
    purpose: ASSET_GENERATION_PURPOSE,
    period: params.period,
    campaign: params.campaign,
    language: params.language,
    context: params.context,
    allowedCtaTypes: params.allowedCtaTypes,
    requestedSocialChannels: params.requestedSocialChannels,
    reportingRules,
    responseSchemaDescription: RESPONSE_SCHEMA_DESCRIPTION,
    maxTokens: params.maxTokens,
    systemPrompt,
    userPrompt,
  };
}
