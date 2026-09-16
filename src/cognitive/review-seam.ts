import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { atomicWriteFile } from "../utils/atomic-write.js";
import { dataPath, getDataDir } from "../utils/paths.js";
import { withFileLock } from "../utils/mutex.js";
import { config } from "../config/config.js";
import { buildFactSnapshot, type FactSnapshot } from "./strategies/_shared.js";
import {
  securityEntitiesFromFactSnapshot,
  runAdversarialStrategies,
  type SecurityEntity,
} from "./adversarial.js";
import { gapDetection } from "./strategies/gap-detection.js";
import { weakReinforcement } from "./strategies/weak-reinforcement.js";
import { crossDomainBridging } from "./strategies/cross-domain-bridging.js";
import { missingAbstraction } from "./strategies/missing-abstraction.js";
import { symmetryCompletion } from "./strategies/symmetry-completion.js";
import { pgoWaveDream } from "./strategies/pgo-wave.js";
import { orphanBridging } from "./strategies/orphan-bridging.js";
import { llmDream } from "./strategies/llm-dream.js";
import { cycleOutcomeForFindingCount } from "./cycle-outcome.js";
import { requireCycleInputs, CycleInputGateError } from "./cycle-input-gate.js";
import {
  findingsFromDreamCycle,
  findingsFromNightmare,
  type UnifiedFinding,
} from "./finding-model.js";
import type {
  AdversarialStrategy,
  CycleOutcome,
  DreamEdge,
  DreamNode,
  DreamStrategy,
} from "./types.js";

export const REVIEW_OUTPUT_SCHEMA = {
  id: "dreamgraph.unified_finding",
  version: "1.0.0",
} as const;

export const FLEET_REVIEW_EMIT_ENV = "DREAMGRAPH_FLEET_REVIEW_EMIT_ENABLED";

type ConcreteDreamStrategy = Exclude<DreamStrategy, "all">;
export type ReviewStrategySelection =
  | `dream:${ConcreteDreamStrategy | "all"}`
  | `nightmare:${AdversarialStrategy}`;

export interface ReviewProfile {
  id: string;
  version: string;
  role: string;
  prompt: string;
  strategies: readonly ReviewStrategySelection[];
  output_schema: typeof REVIEW_OUTPUT_SCHEMA;
}

export interface ReviewCycleContext {
  run_id: string;
  captured_at: string;
  /** The manifest version pinned for every selected strategy in this run. */
  graph_version: string | null;
  repository_names: string[];
  entity_count: number;
}

export interface ReviewSnapshot {
  context: ReviewCycleContext;
  /** Read-only by convention: all selected strategies receive this same object. */
  fact: FactSnapshot;
  /** Derived once from `fact`; no strategy re-reads graph files. */
  security: Map<string, SecurityEntity>;
}

export interface ReviewRunResult {
  context: ReviewCycleContext;
  selected_strategies: ReviewStrategySelection[];
  outcome: CycleOutcome;
  findings: UnifiedFinding[];
}

export interface FleetEmission {
  enabled: boolean;
  emitted: false;
  sink: null;
  reason: "disabled_by_default" | "no_sink_configured";
}

export interface ReviewReport {
  schema: "dreamgraph.review_report.v1";
  report_id: string;
  created_at: string;
  profile: {
    id: string;
    version: string;
    role: string;
    prompt: string;
    output_schema: typeof REVIEW_OUTPUT_SCHEMA;
  };
  context: ReviewCycleContext;
  selected_strategies: ReviewStrategySelection[];
  outcome: CycleOutcome;
  findings: UnifiedFinding[];
  fleet_emission: FleetEmission;
  error?: { code: string; message: string };
}

interface ReviewReportFile {
  schema: "dreamgraph.review_reports.v1";
  reports: ReviewReport[];
}

export const DEFAULT_REVIEW_PROFILE: ReviewProfile = {
  id: "dreams-and-nightmares",
  version: "1.0.0",
  role: "architectural opportunity and threat reviewer",
  prompt: "Find grounded opportunities and threats in one pinned graph snapshot. Cite the graph evidence and leave UNKNOWN explicit.",
  strategies: [
    "dream:gap_detection",
    "dream:cross_domain",
    "dream:missing_abstraction",
    "nightmare:all_threats",
  ],
  output_schema: REVIEW_OUTPUT_SCHEMA,
};

const profileRegistry = new Map<string, ReviewProfile>([
  [DEFAULT_REVIEW_PROFILE.id, DEFAULT_REVIEW_PROFILE],
]);

export function registerReviewProfile(profile: ReviewProfile): void {
  if (!profile.id.trim() || !profile.version.trim() || !profile.role.trim() || !profile.prompt.trim()) {
    throw new Error("Review profile requires id, version, role, and prompt");
  }
  if (profile.output_schema.id !== REVIEW_OUTPUT_SCHEMA.id || profile.output_schema.version !== REVIEW_OUTPUT_SCHEMA.version) {
    throw new Error(`Unsupported review output schema: ${profile.output_schema.id}@${profile.output_schema.version}`);
  }
  profileRegistry.set(profile.id, { ...profile, strategies: [...profile.strategies] });
}

export function getReviewProfile(profileId: string): ReviewProfile | undefined {
  return profileRegistry.get(profileId);
}

export function fleetReviewEmission(
  env: Record<string, string | undefined> = process.env,
): FleetEmission {
  const enabled = env[FLEET_REVIEW_EMIT_ENV] === "true";
  return {
    enabled,
    emitted: false,
    sink: null,
    reason: enabled ? "no_sink_configured" : "disabled_by_default",
  };
}

function graphRepositories(snapshot: FactSnapshot): Record<string, string> {
  const repositories: Record<string, string> = {};
  for (const entity of snapshot.entities.values()) {
    if (entity.source_repo.trim()) repositories[entity.id] = entity.source_repo;
  }
  return repositories;
}

/**
 * Capture graph inputs once after the strict cycle gate and pin the manifest
 * version. A second gate read detects a graph rewrite during the capture and
 * fails closed instead of allowing a mixed-version review.
 */
export async function captureReviewSnapshot(options: {
  expected_graph_version?: string;
  repos?: Record<string, string>;
} = {}): Promise<ReviewSnapshot> {
  const before = await requireCycleInputs({ repos: options.repos });
  if (options.expected_graph_version && before.graph_version !== options.expected_graph_version) {
    throw new CycleInputGateError({
      status: "UNKNOWN",
      reason_code: "GRAPH_VERSION_MISMATCH",
      message: `Cycle inputs are UNKNOWN: requested graph version '${options.expected_graph_version}' is not the persisted version; scan not run.`,
      graph_version: before.graph_version,
    });
  }

  const fact = await buildFactSnapshot();
  const after = await requireCycleInputs({ repos: options.repos });
  if (before.graph_version !== after.graph_version) {
    throw new CycleInputGateError({
      status: "UNKNOWN",
      reason_code: "GRAPH_CHANGED_DURING_CAPTURE",
      message: "Cycle inputs are UNKNOWN: the graph version changed during review capture; scan not run.",
      graph_version: after.graph_version,
    });
  }

  const repositoryNames = [...new Set(Object.values(graphRepositories(fact)))];
  return {
    context: {
      run_id: `review_${randomUUID()}`,
      captured_at: new Date().toISOString(),
      graph_version: after.graph_version,
      repository_names: repositoryNames,
      entity_count: fact.entities.size,
    },
    fact,
    security: securityEntitiesFromFactSnapshot(fact),
  };
}

function expandReviewStrategies(
  selection: ReviewStrategySelection,
): ReviewStrategySelection[] {
  if (selection === "dream:all") {
    return [
      "dream:gap_detection",
      "dream:weak_reinforcement",
      "dream:cross_domain",
      "dream:missing_abstraction",
      "dream:symmetry_completion",
      "dream:pgo_wave",
      "dream:orphan_bridging",
      "dream:llm_dream",
    ];
  }
  if (selection === "nightmare:all" || selection === "nightmare:all_threats") {
    return ["nightmare:all_threats"];
  }
  return [selection];
}

async function runDreamStrategy(
  strategy: ConcreteDreamStrategy,
  snapshot: FactSnapshot,
  profile: ReviewProfile,
): Promise<{ nodes: DreamNode[]; edges: DreamEdge[] }> {
  const cycle = 0;
  const max = 100;
  switch (strategy) {
    case "gap_detection":
      return { nodes: [], edges: gapDetection(snapshot, cycle, max) };
    case "weak_reinforcement":
      return { nodes: [], edges: weakReinforcement(snapshot, cycle, max) };
    case "cross_domain":
      return { nodes: [], edges: crossDomainBridging(snapshot, cycle, max) };
    case "missing_abstraction": {
      const result = missingAbstraction(snapshot, cycle, max);
      return { nodes: result.nodes, edges: result.edges };
    }
    case "symmetry_completion":
      return { nodes: [], edges: symmetryCompletion(snapshot, cycle, max) };
    case "pgo_wave":
      return { nodes: [], edges: pgoWaveDream(snapshot, cycle, max) };
    case "orphan_bridging":
      return { nodes: [], edges: orphanBridging(snapshot, cycle, max) };
    case "llm_dream":
      return {
        ...(await llmDream(snapshot, cycle, max, { role: profile.role, prompt: profile.prompt })),
      };
    default:
      throw new Error(`Review strategy '${strategy}' is not snapshot-safe; use a profile adapter for it first.`);
  }
}

export async function runReviewProfile(
  profile: ReviewProfile,
  snapshot: ReviewSnapshot,
): Promise<ReviewRunResult> {
  if (profile.output_schema.id !== REVIEW_OUTPUT_SCHEMA.id || profile.output_schema.version !== REVIEW_OUTPUT_SCHEMA.version) {
    throw new Error(`Unsupported review output schema: ${profile.output_schema.id}@${profile.output_schema.version}`);
  }

  let nodes: DreamNode[] = [];
  let edges: DreamEdge[] = [];
  let threats: Awaited<ReturnType<typeof runAdversarialStrategies>> = [];
  const selected: ReviewStrategySelection[] = [];

  for (const requested of profile.strategies) {
    for (const strategy of expandReviewStrategies(requested)) {
      selected.push(strategy);
      if (strategy.startsWith("dream:")) {
        const result = await runDreamStrategy(
          strategy.slice("dream:".length) as ConcreteDreamStrategy,
          snapshot.fact,
          profile,
        );
        nodes.push(...result.nodes);
        edges.push(...result.edges);
      } else {
        threats.push(
          ...runAdversarialStrategies(
            snapshot.security,
            strategy.slice("nightmare:".length) as AdversarialStrategy,
            0,
          ),
        );
      }
    }
  }

  const outcome = cycleOutcomeForFindingCount(nodes.length + edges.length + threats.length);
  const context: { outcome: CycleOutcome; entity_repositories: Record<string, string> } = {
    outcome,
    entity_repositories: graphRepositories(snapshot.fact),
  };
  return {
    context: snapshot.context,
    selected_strategies: selected,
    outcome,
    findings: [
      ...findingsFromDreamCycle(nodes, edges, context),
      ...findingsFromNightmare(threats, context),
    ],
  };
}

export function createReviewReport(input: {
  profile: ReviewProfile;
  context: ReviewCycleContext;
  selected_strategies?: ReviewStrategySelection[];
  findings: UnifiedFinding[];
  outcome: CycleOutcome;
  fleet_emission: FleetEmission;
  error?: { code: string; message: string };
}): ReviewReport {
  return {
    schema: "dreamgraph.review_report.v1",
    report_id: `report_${randomUUID()}`,
    created_at: new Date().toISOString(),
    profile: {
      id: input.profile.id,
      version: input.profile.version,
      role: input.profile.role,
      prompt: input.profile.prompt,
      output_schema: input.profile.output_schema,
    },
    context: input.context,
    selected_strategies: input.selected_strategies ?? [...input.profile.strategies],
    outcome: input.outcome,
    findings: input.findings,
    fleet_emission: input.fleet_emission,
    ...(input.error ? { error: input.error } : {}),
  };
}

export function serializeReviewReport(report: ReviewReport): string {
  if (report.outcome === "UNKNOWN" && !report.error) {
    throw new Error("UNKNOWN report requires an error and cannot be serialized as a clean result");
  }
  if (report.outcome !== "UNKNOWN" && report.error) {
    throw new Error("DRY/FOUND report cannot carry an UNKNOWN error");
  }
  if (report.outcome === "UNKNOWN" && report.findings.length > 0) {
    throw new Error("UNKNOWN report cannot contain findings");
  }
  return JSON.stringify(report, null, 2);
}

function emptyReportFile(): ReviewReportFile {
  return { schema: "dreamgraph.review_reports.v1", reports: [] };
}

export async function persistReviewReport(
  report: ReviewReport,
  dataDir = getDataDir(),
): Promise<void> {
  const path = dataPath("review_reports.json");
  const target = dataDir === getDataDir() ? path : resolve(dataDir, "review_reports.json");
  await mkdir(dataDir, { recursive: true });
  await withFileLock(`review_reports:${target}`, async () => {
    let file = emptyReportFile();
    try {
      const parsed = JSON.parse(await readFile(target, "utf8")) as Partial<ReviewReportFile>;
      if (parsed.schema === "dreamgraph.review_reports.v1" && Array.isArray(parsed.reports)) {
        file = { schema: parsed.schema, reports: parsed.reports as ReviewReport[] };
      }
    } catch {
      // A missing report store starts empty; malformed existing data is not
      // silently treated as a successful review history.
      if (await readFile(target, "utf8").then(() => true, () => false)) {
        throw new Error("Review report store is unreadable");
      }
    }
    file.reports.push(report);
    await atomicWriteFile(target, serializeReviewReports(file));
  });
}

function serializeReviewReports(file: ReviewReportFile): string {
  for (const report of file.reports) serializeReviewReport(report);
  return JSON.stringify(file, null, 2);
}

export async function loadReviewReports(dataDir = getDataDir()): Promise<ReviewReport[]> {
  const path = dataDir === getDataDir() ? dataPath("review_reports.json") : resolve(dataDir, "review_reports.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ReviewReportFile>;
    if (parsed.schema !== "dreamgraph.review_reports.v1" || !Array.isArray(parsed.reports)) {
      throw new Error("Review report store is invalid");
    }
    return parsed.reports as ReviewReport[];
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Review report store")) throw error;
    return [];
  }
}

export async function runReviewCycle(
  profileOrId: ReviewProfile | string = DEFAULT_REVIEW_PROFILE,
  options: { expected_graph_version?: string; repos?: Record<string, string>; dataDir?: string } = {},
): Promise<ReviewReport> {
  const profile = typeof profileOrId === "string" ? getReviewProfile(profileOrId) : profileOrId;
  if (!profile) throw new Error(`Review profile not found: ${profileOrId}`);

  try {
    const snapshot = await captureReviewSnapshot({
      expected_graph_version: options.expected_graph_version,
      repos: options.repos,
    });
    const result = await runReviewProfile(profile, snapshot);
    const report = createReviewReport({
      profile,
      context: result.context,
      selected_strategies: result.selected_strategies,
      findings: result.findings,
      outcome: result.outcome,
      fleet_emission: fleetReviewEmission(),
    });
    await persistReviewReport(report, options.dataDir);
    return report;
  } catch (error) {
    if (!(error instanceof CycleInputGateError)) throw error;
    const report = createReviewReport({
      profile,
      context: {
        run_id: `review_${randomUUID()}`,
        captured_at: new Date().toISOString(),
        graph_version: error.input.graph_version ?? null,
        repository_names: Object.keys(options.repos ?? config.repos),
        entity_count: 0,
      },
      findings: [],
      outcome: "UNKNOWN",
      fleet_emission: fleetReviewEmission(),
      error: { code: error.input.reason_code, message: error.input.message },
    });
    await persistReviewReport(report, options.dataDir);
    return report;
  }
}
