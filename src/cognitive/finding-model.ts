import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { getDataDir } from "../utils/paths.js";
import type {
  CycleOutcome,
  DreamEdge,
  DreamEdgeStatus,
  DreamGraphFile,
  DreamNode,
  ThreatEdge,
  ThreatSeverity,
} from "./types.js";

export interface FindingSourceEvidence {
  /** Graph entity IDs directly supporting or affected by this finding. */
  entity_ids: string[];
  /** Human-readable evidence statements copied from the source edge/node. */
  statements: string[];
  /** Optional source-file, evidence-reference, or CWE references. */
  references: string[];
}

export interface FindingContext {
  outcome: CycleOutcome;
  /** Entity ID → configured repository name, loaded from the graph index. */
  entity_repositories?: Readonly<Record<string, string>>;
}

export interface DreamEdgeFindingProvenance {
  kind: "dream_edge";
  edge: DreamEdge;
}

export interface DreamNodeFindingProvenance {
  kind: "dream_node";
  node: DreamNode;
}

export interface ThreatEdgeFindingProvenance {
  kind: "threat_edge";
  edge: ThreatEdge;
}

export type FindingProvenance =
  | DreamEdgeFindingProvenance
  | DreamNodeFindingProvenance
  | ThreatEdgeFindingProvenance;

/** The stable record exchanged between Dreams, Nightmares, and a sink. */
export interface UnifiedFinding {
  finding_id: string;
  kind: "opportunity" | "threat";
  affected_repositories: string[];
  affected_entities: string[];
  source_evidence: FindingSourceEvidence;
  confidence: number;
  /** Threat severity; opportunities intentionally carry null. */
  severity: ThreatSeverity | null;
  rationale: string;
  lifecycle_state: string;
  next_action: string;
  outcome: CycleOutcome;
  provenance: FindingProvenance;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function affectedRepositories(
  entityIds: readonly string[],
  lookup: Readonly<Record<string, string>> | undefined,
): string[] {
  if (!lookup) return [];
  return unique(entityIds.map((id) => lookup[id] ?? ""));
}

function metaReferences(meta: Record<string, unknown> | undefined): string[] {
  if (!meta) return [];
  const values: unknown[] = [meta.source_file, meta.source_files, meta.evidence_refs];
  return unique(values.flatMap((value) => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    return [];
  }));
}

function nextActionForDreamStatus(status: DreamEdgeStatus): string {
  switch (status) {
    case "latent":
      return "gather more evidence";
    case "validated":
      return "use validated opportunity";
    case "rejected":
      return "discard opportunity";
    case "expired":
      return "discard expired opportunity";
    case "candidate":
      return "validate opportunity";
  }
}

export function reconcileDreamCycleArtifacts(
  generated: {
    nodes: readonly DreamNode[];
    edges: readonly DreamEdge[];
  },
  persisted: Pick<DreamGraphFile, "nodes" | "edges">,
): {
  nodes: DreamNode[];
  edges: DreamEdge[];
} {
  const persistedNodes = new Map(persisted.nodes.map((node) => [node.id, node]));
  const persistedEdges = new Map(persisted.edges.map((edge) => [edge.id, edge]));

  return {
    nodes: generated.nodes.map((node) => persistedNodes.get(node.id) ?? node),
    edges: generated.edges.map((edge) => persistedEdges.get(edge.id) ?? edge),
  };
}

export function findingFromDreamEdge(edge: DreamEdge, context: FindingContext): UnifiedFinding {
  const affectedEntities = unique([edge.from, edge.to]);
  return {
    finding_id: `opportunity:${edge.id}`,
    kind: "opportunity",
    affected_repositories: affectedRepositories(affectedEntities, context.entity_repositories),
    affected_entities: affectedEntities,
    source_evidence: {
      entity_ids: affectedEntities,
      statements: [edge.reason],
      references: metaReferences(edge.meta),
    },
    confidence: edge.confidence,
    severity: null,
    rationale: edge.reason,
    lifecycle_state: edge.status,
    next_action: nextActionForDreamStatus(edge.status),
    outcome: context.outcome,
    provenance: { kind: "dream_edge", edge },
  };
}

export function findingFromDreamNode(node: DreamNode, context: FindingContext): UnifiedFinding {
  const affectedEntities = unique(node.inspiration);
  return {
    finding_id: `opportunity:node:${node.id}`,
    kind: "opportunity",
    affected_repositories: affectedRepositories(affectedEntities, context.entity_repositories),
    affected_entities: affectedEntities,
    source_evidence: {
      entity_ids: affectedEntities,
      statements: [node.description],
      references: [],
    },
    confidence: node.confidence,
    severity: null,
    rationale: node.description,
    lifecycle_state: node.status,
    next_action: nextActionForDreamStatus(node.status),
    outcome: context.outcome,
    provenance: { kind: "dream_node", node },
  };
}

export function findingFromThreatEdge(edge: ThreatEdge, context: FindingContext): UnifiedFinding {
  const affectedEntities = unique([edge.from, edge.to, ...edge.blast_radius]);
  return {
    finding_id: `threat:${edge.id}`,
    kind: "threat",
    affected_repositories: affectedRepositories(affectedEntities, context.entity_repositories),
    affected_entities: affectedEntities,
    source_evidence: {
      entity_ids: affectedEntities,
      statements: [edge.attack_vector, edge.description],
      references: edge.cwe_id ? [edge.cwe_id] : [],
    },
    confidence: edge.confidence,
    severity: edge.severity,
    rationale: edge.description,
    lifecycle_state: edge.lifecycle ?? (edge.acknowledged ? "acknowledged" : "new"),
    next_action: edge.mitigation,
    outcome: context.outcome,
    provenance: { kind: "threat_edge", edge },
  };
}

export function findingsFromDreamCycle(
  nodes: readonly DreamNode[],
  edges: readonly DreamEdge[],
  context: FindingContext,
): UnifiedFinding[] {
  return [
    ...nodes.map((node) => findingFromDreamNode(node, context)),
    ...edges.map((edge) => findingFromDreamEdge(edge, context)),
  ];
}

export function findingsFromNightmare(
  threats: readonly ThreatEdge[],
  context: FindingContext,
): UnifiedFinding[] {
  return threats.map((threat) => findingFromThreatEdge(threat, context));
}

/** Read repository ownership from the graph index after the cycle gate passed. */
export async function loadEntityRepositories(dataDir = getDataDir()): Promise<Record<string, string>> {
  const raw = JSON.parse(await readFile(resolve(dataDir, "index.json"), "utf8")) as {
    entities?: Record<string, { source_repo?: unknown }>;
  };
  if (!raw.entities || typeof raw.entities !== "object" || Array.isArray(raw.entities)) {
    throw new Error("Graph index has no parseable entities for finding provenance");
  }
  const result: Record<string, string> = {};
  for (const [id, entity] of Object.entries(raw.entities)) {
    if (typeof entity?.source_repo === "string" && entity.source_repo.trim()) {
      result[id] = entity.source_repo;
    }
  }
  return result;
}
