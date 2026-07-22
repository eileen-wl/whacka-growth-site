import { ExperimentDecisionValidationError } from "../agents/experiment-decision-agent";
import type { DeferDetails, ExperimentDecisionContext, ProceedDetails, ReferenceAliasMaps, ReferenceAliasSet } from "../types/experiment-decision";

/**
 * Deterministic reference-alias layer for the live Anthropic Experiment
 * Decision provider (growth/llm/anthropic-experiment-decision-provider.ts).
 *
 * Live Stage 2 runs invented human-readable shorthand finding IDs (e.g.
 * "finding.finding-app-perf") instead of selecting an exact ID from the
 * deterministic catalog — a structurally valid string that
 * growth/agents/experiment-decision-agent.ts's `validateDecisionAnalysis`
 * correctly rejects as unknown. Rather than fuzzy-match invented IDs, this
 * module builds a compact deterministic alias (E001, F001, L001, ...) for
 * every evidence/finding/limitation catalog entry, sorted ascending by the
 * original ID so the same context always produces the same aliases. Stage
 * 2's structured-output schema (growth/types/experiment-decision.ts's
 * `buildProceedDetailsSchema`/`buildDeferDetailsSchema`) is built from
 * these aliases, so the model can only select an alias that exists —
 * anything else is a structured-output failure at the API level. After
 * Stage 2 responds, `resolveProceedDetailsAliases`/`resolveDeferDetailsAliases`
 * map every alias back to its exact original ID, throwing
 * `ExperimentDecisionValidationError` (never fuzzy-matching) if an alias
 * can't be resolved. Everything downstream — growth/llm/experiment-
 * decision-assembly.ts and `validateDecisionAnalysis` — only ever sees
 * resolved original IDs, exactly as before this layer existed. The final
 * on-disk decision and Markdown never contain aliases.
 */

function buildAliasSet(prefix: string, ids: string[]): ReferenceAliasSet {
  const sortedIds = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const width = Math.max(3, String(sortedIds.length).length);

  const aliases: string[] = [];
  const toId = new Map<string, string>();
  const toAlias = new Map<string, string>();

  sortedIds.forEach((id, index) => {
    const alias = `${prefix}${String(index + 1).padStart(width, "0")}`;
    aliases.push(alias);
    toId.set(alias, id);
    toAlias.set(id, alias);
  });

  return { aliases, toId, toAlias };
}

/**
 * Builds deterministic E/F/L aliases from the already-validated catalogs on
 * an ExperimentDecisionContext. Sorted ascending by original id, so
 * re-running against an unchanged context always produces the same
 * aliases — never randomized, never order-of-insertion dependent.
 */
export function buildReferenceAliasMaps(context: ExperimentDecisionContext): ReferenceAliasMaps {
  return {
    evidence: buildAliasSet("E", context.evidenceCatalog.map((entry) => entry.id)),
    finding: buildAliasSet("F", context.findingCatalog.map((entry) => entry.id)),
    limitation: buildAliasSet("L", context.limitationCatalog.map((entry) => entry.id)),
  };
}

function resolveAlias(alias: string, set: ReferenceAliasSet, fieldLabel: string, stageLabel: string): string {
  const resolved = set.toId.get(alias);
  if (resolved === undefined) {
    throw new ExperimentDecisionValidationError(
      `${stageLabel} referenced an unknown ${fieldLabel} alias "${alias}" — it is not present in the supplied ${fieldLabel} catalog for this request. No fuzzy or partial matching is attempted.`
    );
  }
  return resolved;
}

function resolveAliasArray(aliases: string[], set: ReferenceAliasSet, fieldLabel: string, stageLabel: string): string[] {
  return aliases.map((alias) => resolveAlias(alias, set, fieldLabel, stageLabel));
}

/** Routes a defer-branch reference to the evidence or limitation alias map by its prefix. A finding (F###) alias is rejected outright — findings may be described in prose but are never valid in this field. */
function resolveEvidenceOrLimitationAlias(alias: string, maps: ReferenceAliasMaps, stageLabel: string): string {
  if (alias.startsWith("E")) return resolveAlias(alias, maps.evidence, "evidence", stageLabel);
  if (alias.startsWith("L")) return resolveAlias(alias, maps.limitation, "limitation", stageLabel);
  throw new ExperimentDecisionValidationError(
    `${stageLabel} referenced alias "${alias}" in relatedEvidenceOrLimitationRefs, which only accepts evidence (E###) or limitation (L###) aliases — finding (F###) aliases are not valid in this field.`
  );
}

export const STAGE2_PROCEED_LABEL = "Stage 2 (proceed details)";
export const STAGE2_DEFER_LABEL = "Stage 2 (defer details)";

/**
 * Replaces every E/F/L alias in a parsed ProceedDetails response with its
 * exact original catalog ID. Throws ExperimentDecisionValidationError
 * (never fuzzy-matches) if any alias is unresolvable. The returned object
 * has the same shape as the input — only reference-field values change,
 * from aliases to original IDs — so growth/llm/experiment-decision-
 * assembly.ts's `assembleProceedAnalysis` needs no changes at all.
 */
export function resolveProceedDetailsAliases(details: ProceedDetails, maps: ReferenceAliasMaps): ProceedDetails {
  return {
    ...details,
    rankedExperimentOptions: details.rankedExperimentOptions.map((option) => ({
      ...option,
      primaryMetricRef: resolveAlias(option.primaryMetricRef, maps.evidence, "evidence", STAGE2_PROCEED_LABEL),
      guardrailMetricRefs: resolveAliasArray(option.guardrailMetricRefs, maps.evidence, "evidence", STAGE2_PROCEED_LABEL),
      evidenceRefs: resolveAliasArray(option.evidenceRefs, maps.evidence, "evidence", STAGE2_PROCEED_LABEL),
      findingRefs: resolveAliasArray(option.findingRefs, maps.finding, "finding", STAGE2_PROCEED_LABEL),
      limitationRefs: resolveAliasArray(option.limitationRefs, maps.limitation, "limitation", STAGE2_PROCEED_LABEL),
    })),
  };
}

/**
 * Replaces every E/L alias in a parsed DeferDetails response's
 * `relatedEvidenceOrLimitationRefs` with its exact original catalog ID.
 * Rejects an F alias outright. Never fuzzy-matches. The returned object has
 * the same shape as the input, so growth/llm/experiment-decision-
 * assembly.ts's `assembleDeferAnalysis` needs no changes at all.
 */
export function resolveDeferDetailsAliases(details: DeferDetails, maps: ReferenceAliasMaps): DeferDetails {
  return {
    ...details,
    requiredNextObservations: details.requiredNextObservations.map((observation) => ({
      ...observation,
      relatedEvidenceOrLimitationRefs: observation.relatedEvidenceOrLimitationRefs.map((alias) =>
        resolveEvidenceOrLimitationAlias(alias, maps, STAGE2_DEFER_LABEL)
      ),
    })),
  };
}
