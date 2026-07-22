import { ExperimentDecisionValidationError } from "../agents/experiment-decision-agent";
import type {
  DecisionGate,
  DeferDetails,
  ExperimentDecisionAnalysis,
  ProceedDetails,
  ProceedOption,
  RankedExperimentOption,
  RecommendedExperiment,
  RejectedOrDeferredOption,
} from "../types/experiment-decision";

/**
 * Deterministically assembles a full ExperimentDecisionAnalysis-shaped
 * object from the two-stage Anthropic responses (growth/llm/
 * anthropic-experiment-decision-provider.ts). Every function here is pure —
 * no network calls, no randomness. The result is passed to the EXACT SAME
 * `validateDecisionAnalysis` (growth/agents/experiment-decision-agent.ts)
 * used for every other provider, so evidence/finding/limitation/topic/CTA/
 * channel reference validation, rank sequencing, and proceed/defer field
 * pairing are all still enforced exactly as before — nothing here silently
 * accepts an invalid reference.
 */

function emptyToNull(value: string): string | null {
  return value.length === 0 ? null : value;
}

function toRankedOption(option: ProceedOption): RankedExperimentOption {
  return {
    id: option.id,
    rank: option.rank,
    lever: option.lever,
    title: option.title,
    target: {
      topicOrApp: emptyToNull(option.targetTopicOrApp),
      ctaType: option.targetCtaType === "" ? null : option.targetCtaType,
      channel: emptyToNull(option.targetChannel),
    },
    hypothesis: option.hypothesis,
    proposedChange: option.proposedChange,
    controlDescription: option.controlDescription,
    variantDescription: option.variantDescription,
    measurementPlan: {
      primaryMetricRef: option.primaryMetricRef,
      expectedDirection: option.expectedDirection,
      successCriterion: option.successCriterion,
      guardrailMetricRefs: option.guardrailMetricRefs,
      measurementCaveats: option.measurementCaveats,
    },
    evidenceRefs: option.evidenceRefs,
    findingRefs: option.findingRefs,
    limitationRefs: option.limitationRefs,
    confidence: option.confidence,
    dependencies: option.dependencies,
    risks: option.risks,
    whyNotHigherRanked: emptyToNull(option.whyNotHigherRanked),
  };
}

/** Generic, deterministic boilerplate — never metric-specific, never a fabricated number — for the two RecommendedExperiment fields that have no natural analogue on RankedExperimentOption. */
const GENERIC_FAILURE_CRITERION = "No improvement is observed against the success criterion above, or a decline occurs in a guardrail metric.";
const GENERIC_MINIMUM_OBSERVATION_REQUIREMENT =
  "Both control and variant must receive measurable traffic using the same tracking events before any comparison is made.";

/** Derives the full RecommendedExperiment entirely from the selected RankedExperimentOption — the model never generates this content twice. */
function deriveRecommendedExperiment(selected: RankedExperimentOption): RecommendedExperiment {
  return {
    experimentId: selected.id,
    objective: selected.hypothesis,
    hypothesis: selected.hypothesis,
    implementationBrief: {
      change: selected.proposedChange,
      unchangedElements: [selected.controlDescription],
      targetPagesOrApps: selected.target.topicOrApp !== null ? [selected.target.topicOrApp] : [],
      targetCta: selected.target.ctaType,
      targetChannel: selected.target.channel,
    },
    measurementPlan: {
      primaryMetricRef: selected.measurementPlan.primaryMetricRef,
      secondaryMetricRefs: [],
      guardrailMetricRefs: selected.measurementPlan.guardrailMetricRefs,
      successCriterion: selected.measurementPlan.successCriterion,
      failureCriterion: GENERIC_FAILURE_CRITERION,
      minimumObservationRequirement: GENERIC_MINIMUM_OBSERVATION_REQUIREMENT,
      knownMeasurementLimitations: selected.measurementPlan.measurementCaveats,
    },
    evidenceRefs: selected.evidenceRefs,
    findingRefs: selected.findingRefs,
    confidence: selected.confidence,
  };
}

/** Derives rejectedOrDeferredOptions from every ranked option other than the recommended one. */
function deriveRejectedOrDeferredOptions(options: RankedExperimentOption[], recommendedId: string): RejectedOrDeferredOption[] {
  return options
    .filter((option) => option.id !== recommendedId)
    .map((option) => ({
      title: option.title,
      reason: option.whyNotHigherRanked ?? "Ranked below the recommended option.",
      evidenceRefs: option.evidenceRefs,
      limitationRefs: option.limitationRefs,
    }));
}

/** Assembles a full ExperimentDecisionAnalysis from a "proceed" stage 1 gate + stage 2A details. Throws ExperimentDecisionValidationError if recommendedExperimentId doesn't match any produced option — the same error type/behavior the single-call path already used for this exact condition. */
export function assembleProceedAnalysis(gate: DecisionGate, details: ProceedDetails): ExperimentDecisionAnalysis {
  const rankedExperimentOptions = details.rankedExperimentOptions.map(toRankedOption);
  const selected = rankedExperimentOptions.find((option) => option.id === details.recommendedExperimentId);
  if (!selected) {
    throw new ExperimentDecisionValidationError(
      `Stage 2 (proceed details) returned recommendedExperimentId "${details.recommendedExperimentId}" that does not match any rankedExperimentOptions id.`
    );
  }

  return {
    decisionSummary: {
      decisionStatus: "proceed",
      headline: gate.headline,
      rationale: gate.rationale,
      confidence: gate.confidence,
      recommendedExperimentId: details.recommendedExperimentId,
    },
    rankedExperimentOptions,
    recommendedExperiment: deriveRecommendedExperiment(selected),
    deferDecision: null,
    rejectedOrDeferredOptions: deriveRejectedOrDeferredOptions(rankedExperimentOptions, details.recommendedExperimentId),
    handoff: { forNextLoop: details.handoffItems, humanReviewRequired: true },
  };
}

/** Assembles a full ExperimentDecisionAnalysis from a "defer" stage 1 gate + stage 2B details. */
export function assembleDeferAnalysis(gate: DecisionGate, details: DeferDetails): ExperimentDecisionAnalysis {
  return {
    decisionSummary: {
      decisionStatus: "defer",
      headline: gate.headline,
      rationale: gate.rationale,
      confidence: gate.confidence,
      recommendedExperimentId: null,
    },
    rankedExperimentOptions: [],
    recommendedExperiment: null,
    deferDecision: {
      reason: details.reason,
      missingEvidence: details.missingEvidence,
      requiredNextObservations: details.requiredNextObservations,
      earliestDecisionCondition: details.earliestDecisionCondition,
    },
    rejectedOrDeferredOptions: [],
    handoff: { forNextLoop: details.handoffItems, humanReviewRequired: true },
  };
}
