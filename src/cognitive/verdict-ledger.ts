import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { config } from "../config/config.js";
import { getDataDir } from "../utils/paths.js";
import { withFileLock } from "../utils/mutex.js";
import type { DreamEdge, DreamNode, NightmareResult } from "./types.js";
import type { UnifiedFinding } from "./finding-model.js";
import {
  findingsFromDreamCycle,
  findingsFromNightmare,
  loadEntityRepositories,
} from "./finding-model.js";
import type { CycleOutcome } from "./cycle-outcome.js";

export const VERDICT_LEDGER_FILE = "verdict_ledger.jsonl";

export interface VerdictLedgerEntry {
  schema: "dreamgraph.verdict_ledger.v1";
  run_id: string;
  previous_run_id: string | null;
  recorded_at: string;
  outcome: CycleOutcome;
  status: "scanned" | "scan_not_run";
  graph_version?: string;
  /** Null for UNKNOWN: it is not a zero-finding scan. */
  finding_count: number | null;
  /** All finding IDs present in this run's record. */
  finding_ids: string[];
  /** IDs absent from all earlier ledger records. */
  new_finding_ids: string[];
  findings: UnifiedFinding[];
  reason?: string;
}

export interface AppendVerdictLedgerInput {
  data_dir?: string;
  enabled?: boolean;
  run_id?: string;
  recorded_at?: string | Date;
  outcome: CycleOutcome;
  graph_version?: string;
  reason?: string;
  findings: readonly UnifiedFinding[];
}

export interface AppendVerdictLedgerResult {
  enabled: boolean;
  path?: string;
  run_id?: string;
  previous_run_id?: string | null;
  new_finding_ids: string[];
  entry?: VerdictLedgerEntry;
}

export function isVerdictLedgerEnabled(): boolean {
  return config.env.verdictLedgerEnabled;
}

function isoTime(value: string | Date | undefined): string {
  return value instanceof Date ? value.toISOString() : value ?? new Date().toISOString();
}

function uniqueFindings(findings: readonly UnifiedFinding[]): UnifiedFinding[] {
  return [...new Map(findings.map((finding) => [finding.finding_id, finding])).values()];
}

export async function readVerdictLedger(dataDir = getDataDir()): Promise<VerdictLedgerEntry[]> {
  const ledgerPath = resolve(dataDir, VERDICT_LEDGER_FILE);
  let raw: string;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as VerdictLedgerEntry;
    } catch {
      throw new Error(`Verdict ledger record ${index + 1} is not valid JSON`);
    }
  });
}

export async function appendVerdictLedger(
  input: AppendVerdictLedgerInput,
): Promise<AppendVerdictLedgerResult> {
  const enabled = input.enabled ?? isVerdictLedgerEnabled();
  if (!enabled) return { enabled: false, new_finding_ids: [] };

  const findings = uniqueFindings(input.findings);
  if (input.outcome === "UNKNOWN" && findings.length > 0) {
    throw new Error("UNKNOWN verdicts cannot carry findings");
  }
  if (input.outcome === "DRY" && findings.length > 0) {
    throw new Error("DRY verdicts cannot carry findings");
  }
  if (input.outcome === "FOUND" && findings.length === 0) {
    throw new Error("FOUND verdicts must carry at least one finding");
  }

  const dataDir = input.data_dir ?? getDataDir();
  await mkdir(dataDir, { recursive: true });
  const ledgerPath = resolve(dataDir, VERDICT_LEDGER_FILE);

  return withFileLock(ledgerPath, async () => {
    const prior = await readVerdictLedger(dataDir);
    const previous = prior.at(-1);
    const seen = new Set(prior.flatMap((entry) => entry.finding_ids));
    const findingIds = findings.map((finding) => finding.finding_id);
    const newFindingIds = findingIds.filter((id) => !seen.has(id));
    const entry: VerdictLedgerEntry = {
      schema: "dreamgraph.verdict_ledger.v1",
      run_id: input.run_id ?? `run_${randomUUID()}`,
      previous_run_id: previous?.run_id ?? null,
      recorded_at: isoTime(input.recorded_at),
      outcome: input.outcome,
      status: input.outcome === "UNKNOWN" ? "scan_not_run" : "scanned",
      ...(input.graph_version ? { graph_version: input.graph_version } : {}),
      finding_count: input.outcome === "UNKNOWN" ? null : findings.length,
      finding_ids: findingIds,
      new_finding_ids: newFindingIds,
      findings,
      ...(input.reason ? { reason: input.reason } : {}),
    };

    const handle = await open(ledgerPath, "a");
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
      await handle.datasync();
    } finally {
      await handle.close();
    }

    return {
      enabled: true,
      path: ledgerPath,
      run_id: entry.run_id,
      previous_run_id: entry.previous_run_id,
      new_finding_ids: entry.new_finding_ids,
      entry,
    };
  });
}

export async function emitDreamCycleVerdict(input: {
  nodes: readonly DreamNode[];
  edges: readonly DreamEdge[];
  outcome: CycleOutcome;
  graph_version: string;
}): Promise<AppendVerdictLedgerResult> {
  if (!isVerdictLedgerEnabled()) return { enabled: false, new_finding_ids: [] };
  const entityRepositories = await loadEntityRepositories();
  return appendVerdictLedger({
    outcome: input.outcome,
    graph_version: input.graph_version,
    findings: findingsFromDreamCycle(input.nodes, input.edges, {
      outcome: input.outcome,
      entity_repositories: entityRepositories,
    }),
    enabled: true,
  });
}

export async function emitNightmareVerdict(input: NightmareResult): Promise<AppendVerdictLedgerResult> {
  if (!isVerdictLedgerEnabled()) return { enabled: false, new_finding_ids: [] };
  const entityRepositories = await loadEntityRepositories();
  return appendVerdictLedger({
    outcome: input.outcome,
    graph_version: input.graph_version,
    findings: findingsFromNightmare(input.threats_found, {
      outcome: input.outcome,
      entity_repositories: entityRepositories,
    }),
    enabled: true,
  });
}
