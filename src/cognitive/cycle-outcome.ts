import type { CycleInputUnknown } from "./cycle-input-gate.js";
import type { CycleOutcome } from "./types.js";

export type { CycleOutcome };

export interface ScheduleActionResult {
  summary: string;
  outcome?: CycleOutcome;
  finding_count?: number;
  graph_version?: string;
}

export function cycleOutcomeForFindingCount(count: number): Exclude<CycleOutcome, "UNKNOWN"> {
  return count > 0 ? "FOUND" : "DRY";
}

export function formatCycleSummary(
  action: string,
  strategy: string,
  outcome: CycleOutcome,
  findingCount?: number,
  reason?: string,
): string {
  if (outcome === "UNKNOWN") {
    return `${action}(${strategy}): UNKNOWN, scan not run: ${reason ?? "cycle inputs were not usable"}`;
  }
  const noun = action === "nightmare_cycle" ? "threats" : "findings";
  return `${action}(${strategy}): ${outcome}, ${findingCount ?? 0} ${noun} found`;
}

export function unknownCycleResponse(input: CycleInputUnknown): {
  success: false;
    error: {
      code: "UNKNOWN_INPUTS";
      message: string;
      outcome: "UNKNOWN";
      reason_code: string;
      graph_version?: string;
  };
} {
  return {
    success: false,
    error: {
      code: "UNKNOWN_INPUTS",
      message: input.message,
      outcome: "UNKNOWN",
      reason_code: input.reason_code,
      ...(input.graph_version ? { graph_version: input.graph_version } : {}),
    },
  };
}
