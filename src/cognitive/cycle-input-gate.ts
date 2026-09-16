import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { config } from "../config/config.js";
import { dataPath, getDataDir } from "../utils/paths.js";
import { atomicWriteFile } from "../utils/atomic-write.js";

const GRAPH_MANIFEST_FILE = "graph_manifest.json";
const GRAPH_FILES = ["features.json", "workflows.json", "data_model.json", "index.json"] as const;
const DEFAULT_MAX_GRAPH_AGE_MS = 24 * 60 * 60 * 1000;

export interface GraphManifest {
  schema: "dreamgraph.graph_manifest.v1";
  schema_version: "1.0.0";
  graph_version: string;
  generated_at: string;
  source_repos: Record<string, string>;
  entity_count: number;
}

export interface CycleInputUnknown {
  status: "UNKNOWN";
  reason_code: string;
  message: string;
  graph_version?: string;
}

export interface CycleInputReady {
  status: "READY";
  graph_version: string;
  generated_at: string;
  entity_count: number;
  repo_count: number;
  graph_files: readonly string[];
}

export type CycleInputPreflight = CycleInputReady | CycleInputUnknown;

export class CycleInputGateError extends Error {
  readonly input: CycleInputUnknown;

  constructor(input: CycleInputUnknown) {
    super(input.message);
    this.name = "CycleInputGateError";
    this.input = input;
  }
}

export interface CycleInputPreflightOptions {
  dataDir?: string;
  repos?: Record<string, string>;
  now?: Date;
  maxAgeMs?: number;
}

export interface GraphManifestWriteOptions {
  dataDir?: string;
  repos: Record<string, string>;
  now?: Date;
}

function unknown(reason_code: string, message: string, graph_version?: string): CycleInputUnknown {
  return { status: "UNKNOWN", reason_code, message, ...(graph_version ? { graph_version } : {}) };
}

async function readJson(dataDir: string, filename: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(dataDir, filename), "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameRepoMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).map(([name, path]) => [name, resolve(path)] as const).sort();
  const rightEntries = Object.entries(right).map(([name, path]) => [name, resolve(path)] as const).sort();
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function validManifest(value: unknown): value is GraphManifest {
  if (!isRecord(value)) return false;
  return value.schema === "dreamgraph.graph_manifest.v1"
    && value.schema_version === "1.0.0"
    && typeof value.graph_version === "string"
    && value.graph_version.trim().length > 0
    && typeof value.generated_at === "string"
    && typeof value.entity_count === "number"
    && Number.isInteger(value.entity_count)
    && value.entity_count >= 0
    && isRecord(value.source_repos)
    && Object.entries(value.source_repos).every(([name, path]) => name.length > 0 && typeof path === "string");
}

/**
 * Prove that a cognitive cycle has usable, stamped graph inputs before it
 * changes engine state. The normal graph readers intentionally tolerate broken
 * files for UI continuity; this gate must not use those tolerant readers.
 */
export async function preflightGraphInputs(
  options: CycleInputPreflightOptions = {},
): Promise<CycleInputPreflight> {
  const dataDir = options.dataDir ?? getDataDir();
  const repos = options.repos ?? config.repos;
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? (Number(process.env.DREAMGRAPH_GRAPH_MAX_AGE_MS) || DEFAULT_MAX_GRAPH_AGE_MS);

  const repoEntries = Object.entries(repos);
  if (repoEntries.length === 0) {
    return unknown("NO_CONFIGURED_REPOSITORIES", "Cycle inputs are UNKNOWN: DREAMGRAPH_REPOS has no configured repositories; scan not run.");
  }

  for (const [name, repoPath] of repoEntries) {
    if (typeof repoPath !== "string" || repoPath.trim().length === 0) {
      return unknown("REPOSITORY_UNRESOLVABLE", `Cycle inputs are UNKNOWN: configured repository '${name}' has no usable path; scan not run.`);
    }
    try {
      if (!(await stat(resolve(repoPath))).isDirectory()) {
        return unknown("REPOSITORY_UNRESOLVABLE", `Cycle inputs are UNKNOWN: configured repository '${name}' is not a directory; scan not run.`);
      }
    } catch {
      return unknown("REPOSITORY_UNRESOLVABLE", `Cycle inputs are UNKNOWN: configured repository '${name}' cannot be resolved on disk; scan not run.`);
    }
  }

  let manifest: unknown;
  const graphData: Record<string, unknown> = {};
  try {
    manifest = await readJson(dataDir, GRAPH_MANIFEST_FILE);
    for (const filename of GRAPH_FILES) graphData[filename] = await readJson(dataDir, filename);
  } catch {
    return unknown("GRAPH_STORE_UNREADABLE", "Cycle inputs are UNKNOWN: the stamped graph store is missing or unreadable; scan not run.");
  }

  if (!validManifest(manifest)) {
    return unknown("GRAPH_STAMP_INVALID", "Cycle inputs are UNKNOWN: the graph freshness/version stamp is missing or invalid; scan not run.");
  }

  const generatedAtMs = Date.parse(manifest.generated_at);
  if (!Number.isFinite(generatedAtMs)) {
    return unknown("GRAPH_STAMP_INVALID", "Cycle inputs are UNKNOWN: the graph freshness/version stamp has no valid timestamp; scan not run.", manifest.graph_version);
  }
  const ageMs = now.getTime() - generatedAtMs;
  if (ageMs > maxAgeMs || ageMs < -60_000) {
    return unknown("GRAPH_STAMP_STALE", "Cycle inputs are UNKNOWN: the graph freshness/version stamp is stale or from the future; scan not run.", manifest.graph_version);
  }

  if (!sameRepoMap(manifest.source_repos, repos)) {
    return unknown("GRAPH_STAMP_REPOSITORIES_MISMATCH", "Cycle inputs are UNKNOWN: the graph stamp does not cover the configured repositories; scan not run.", manifest.graph_version);
  }

  if (!Array.isArray(graphData["features.json"]) || !Array.isArray(graphData["workflows.json"]) || !Array.isArray(graphData["data_model.json"])) {
    return unknown("GRAPH_STORE_INVALID", "Cycle inputs are UNKNOWN: one or more graph entity stores are not arrays; scan not run.", manifest.graph_version);
  }
  const index = graphData["index.json"];
  if (!isRecord(index) || !isRecord(index.entities)) {
    return unknown("GRAPH_STORE_INVALID", "Cycle inputs are UNKNOWN: the graph index is not parseable; scan not run.", manifest.graph_version);
  }

  const entityIds = new Set<string>();
  for (const value of [graphData["features.json"], graphData["workflows.json"], graphData["data_model.json"]]) {
    for (const entity of value as unknown[]) {
      if (isRecord(entity) && typeof entity.id === "string" && entity.id.trim()) entityIds.add(entity.id);
    }
  }
  const entityCount = entityIds.size;
  if (entityCount === 0 || Object.keys(index.entities).length === 0) {
    return unknown("GRAPH_EMPTY", "Cycle inputs are UNKNOWN: the graph has no entities; no cognitive scan ran.", manifest.graph_version);
  }
  if (manifest.entity_count !== entityCount) {
    return unknown("GRAPH_STAMP_ENTITY_COUNT_MISMATCH", "Cycle inputs are UNKNOWN: the graph entity count does not match its freshness/version stamp; scan not run.", manifest.graph_version);
  }

  return {
    status: "READY",
    graph_version: manifest.graph_version,
    generated_at: manifest.generated_at,
    entity_count: entityCount,
    repo_count: repoEntries.length,
    graph_files: GRAPH_FILES,
  };
}

export async function requireCycleInputs(
  options: CycleInputPreflightOptions = {},
): Promise<CycleInputReady> {
  const result = await preflightGraphInputs(options);
  if (result.status === "UNKNOWN") throw new CycleInputGateError(result);
  return result;
}

/** Persist a content-versioned graph stamp after a scan has written seed data. */
export async function writeGraphManifest(options: GraphManifestWriteOptions): Promise<GraphManifest> {
  const dataDir = options.dataDir ?? getDataDir();
  const graphData: Record<string, unknown> = {};
  for (const filename of GRAPH_FILES) graphData[filename] = await readJson(dataDir, filename);
  if (!Array.isArray(graphData["features.json"]) || !Array.isArray(graphData["workflows.json"]) || !Array.isArray(graphData["data_model.json"])) {
    throw new Error("Cannot stamp graph: entity stores are not arrays");
  }
  const entityIds = new Set<string>();
  for (const value of [graphData["features.json"], graphData["workflows.json"], graphData["data_model.json"]]) {
    for (const entity of value as unknown[]) {
      if (isRecord(entity) && typeof entity.id === "string" && entity.id.trim()) entityIds.add(entity.id);
    }
  }
  const generatedAt = (options.now ?? new Date()).toISOString();
  const graphVersion = `sha256:${createHash("sha256").update(JSON.stringify(graphData)).digest("hex")}`;
  const manifest: GraphManifest = {
    schema: "dreamgraph.graph_manifest.v1",
    schema_version: "1.0.0",
    graph_version: graphVersion,
    generated_at: generatedAt,
    source_repos: { ...options.repos },
    entity_count: entityIds.size,
  };
  await atomicWriteFile(dataDir === getDataDir() ? dataPath(GRAPH_MANIFEST_FILE) : resolve(dataDir, GRAPH_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  return manifest;
}
