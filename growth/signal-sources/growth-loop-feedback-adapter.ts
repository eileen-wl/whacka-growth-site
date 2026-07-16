import { deterministicId } from "../lib/ids";
import type { SignalSourceAdapter, SignalSourceContext } from "./provider";
import type { GrowthLoopFeedback } from "../contracts/loop-feedback";
import type { SignalSourceRecord } from "../types/signal-mining";

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

/**
 * Turns a validated GrowthLoopFeedback's instructions into
 * `SignalSourceRecord`s so they flow through the same catalog/citation
 * mechanism as every other source — but always at `confidence: "low"` and
 * always carrying an explicit limitation disclosing that this is a prior
 * Experiment Decision's instruction, not directly observed evidence (see
 * growth/signal-sources/README.md). No LLM call, no network call. Returns
 * `[]` when `feedback` is null or has zero instructions (e.g. a `no_action`
 * feedback record) — that is valid, not an error.
 */
export class GrowthLoopFeedbackAdapter implements SignalSourceAdapter {
  readonly name = "growth_loop_feedback";

  constructor(private readonly feedback: GrowthLoopFeedback | null) {}

  async collect(context: SignalSourceContext): Promise<SignalSourceRecord[]> {
    const { feedback } = this;
    if (!feedback) return [];

    return feedback.instructions.map((instruction, index) => {
      const limitations = ["Derived from a prior Experiment Decision instruction, not directly observed evidence."];
      if (feedback.sourceDecision.isMock) {
        limitations.push("Source decision was mock-generated — this instruction is not a real strategic directive.");
      }

      return {
        id: deterministicId("sourcerecord", "growth_loop_feedback", feedback.id, String(index), instruction.destination, instruction.instruction),
        source: {
          type: "growth_loop_feedback",
          name: "Growth Loop Feedback",
          recordId: feedback.id,
          url: null,
          publishedAt: feedback.sourceDecision.generatedAt,
          retrievedAt: context.now,
          isInternal: true,
        },
        title: `Feedback instruction (${instruction.destination}): ${truncate(instruction.instruction, 80)}`,
        content:
          `${instruction.instruction} — This is a decision instruction/constraint carried over from Experiment Decision ` +
          `"${feedback.sourceDecision.filename}" (status: ${feedback.sourceDecision.decisionStatus}` +
          `${feedback.sourceDecision.isMock ? ", MOCK-GENERATED" : ""}), not a directly observed market signal.`,
        entities: {
          keywords: [],
          topics: [],
          audiences: [],
          productsOrApps: instruction.topicOrApp ? [instruction.topicOrApp] : [],
          channels: instruction.channel ? [instruction.channel] : [],
        },
        metrics: [],
        references: {
          evidenceRefs: instruction.evidenceRefs,
          findingRefs: instruction.findingRefs,
          limitationRefs: instruction.limitationRefs,
        },
        quality: { confidence: "low", limitations },
      };
    });
  }
}
