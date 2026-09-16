/**
 * DreamGraph MCP Server — scan_project tool.
 *
 * Convenience orchestrator that automates the initial project scan
 * and knowledge graph enrichment.  Replaces the manual multi-step
 * prompt: read_source_code → enrich_seed_data(features) →
 * enrich_seed_data(workflows) → enrich_seed_data(data_model) →
 * register_ui_element → schedule_dream.
 *
 * Design principles:
 *   - **Opt-in convenience** — all individual tools remain available.
 *     Users can still manually enrich the graph with richer data.
 *   - **Non-destructive** — always uses merge mode, never replaces
 *     existing enrichment.  Safe to re-run after manual enrichment.
 *   - **LLM-powered** — uses the configured dreamer LLM to generate
 *     rich, semantic entries rather than only heuristic classification.
 *     Falls back to structural-only if LLM is unavailable.
 *   - **Transparent** — returns detailed counts so the user knows
 *     exactly what was created.
 *
 * Usage:  scan_project()                — full scan, all targets
 *         scan_project({ depth: "shallow" }) — top-level only
 *         scan_project({ targets: ["features"] }) — features only
 *         scan_project({ schedule_dreams: true }) — scan + schedule
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import ignore, { type Ignore } from "ignore";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config/config.js";
import { dataPath } from "../utils/paths.js";
import { loadJsonArray, invalidateCache } from "../utils/cache.js";
import { loadIndexableUIElements } from "../utils/ui-index.js";
import { success, error, safeExecute } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { getLlmProvider, getDreamerLlmConfig, isLlmAvailable } from "../cognitive/llm.js";
import type { LlmMessage } from "../cognitive/llm.js";
import { dream } from "../cognitive/dreamer.js";
import { writeGraphManifest } from "../cognitive/cycle-input-gate.js";
import { normalize } from "../cognitive/normalizer.js";
import { engine } from "../cognitive/engine.js";
import { discoverAndRecordADRs } from "../instance/bootstrap.js";
import { scheduleTargetedDreamStabilization } from "../cognitive/targeted-dreams.js";
import type { ProjectScan, ScannedFile } from "./scan-types.js";
import {
  buildScanState,
  commitScanState,
  loadScanState,
  previewIncrementalScan,
  type ScanDeltaPreview,
  type ScanTarget,
  type StructuralEvidenceLedger,
} from "./scan-state.js";
import { makeScannedFile, reconcileAddedModifiedEntities, updateDerivedHubStates, withdrawStructuralEvidence } from "./incremental-reconciliation.js";
import { withReconciliationTransaction } from "./reconciliation-transaction.js";
import {
  stripTemplateStubs,
  mergeById,
  extractJsonArray,
  ensureStringArray,
  sanitizeEntry,
} from "./sanitize-entity.js";
import {
  generateStructuralFeatures,
  generateStructuralWorkflows,
  generateStructuralDataModel,
} from "./structural-generators.js";
import { shouldSkipScanDirectory } from "./scanner-artifact-policy.js";
import { classifyAuxiliaryFile } from "./auxiliary-classifier.js";
import { generateAuxiliaryEntities } from "./auxiliary-generators.js";
import { mergeAuxiliaryEntities, loadAuxiliaryEntities } from "./auxiliary-store.js";
import { extractNativeDataModel, hasNativeCodeFiles } from "./native-data-model.js";
import { extractNativeUiElements, hasScannableUiFiles } from "./native-ui-scanner.js";
import { applyScannerUiElements } from "./ui-registry.js";
import { enrichParserNodesProgrammatic, type EnrichResult } from "./enrich-parser-nodes.js";
import { buildCoverageLedger, validateCoverageLedger } from "./coverage-ledger.js";
import { runDatastoreScan } from "./db-senses.js";
import { autoSeedPrimaryDatastore } from "../instance/datastore-bootstrap.js";
import {
  captureRepositoryGitHeads,
  datastoreConnectionFingerprint,
  updateGraphMaintenanceState,
} from "../cognitive/graph-maintenance-state.js";
import type {
  Feature,
  Workflow,
  DataModelEntity,
  Datastore,
  IndexEntry,
  ResourceIndex,
  GraphLink,
  WorkflowStep,
  EntityField,
  ToolResponse,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max files to include in a single LLM prompt batch */
const LLM_BATCH_SIZE = 40;

/** Max bytes to read from a file for content analysis */
const MAX_FILE_BYTES = 3072;

/** File extensions we scan */
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".cs",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
  ".swift",
  ".vue", ".svelte", ".xaml", ".razor",
  ".gradle",
]);

/** Config / manifest files that reveal project structure */
const MANIFEST_FILES = new Set([
  "package.json", "tsconfig.json", "cargo.toml", "go.mod",
  "pyproject.toml", "requirements.txt", "setup.py",
  "pom.xml", "build.gradle", "build.gradle.kts",
  "*.csproj", "*.sln", "*.fsproj",
  "docker-compose.yml", "dockerfile",
  "makefile", "justfile",
]);

/** UI file extensions / patterns */
const UI_FILE_PATTERNS = [
  /\.xaml$/i, /\.razor$/i, /\.vue$/i, /\.svelte$/i,
  /\.tsx$/i, /\.jsx$/i,
  /Page\.cs$/i, /View\.cs$/i, /Dialog\.cs$/i,
  /Component\.(ts|js)$/i,
];

// ---------------------------------------------------------------------------
// Source file scanning
// ---------------------------------------------------------------------------

// `ScannedFile` and `ProjectScan` are re-exported from `./scan-types.js`
// (see imports above) so helper modules can consume them without circling
// back to this orchestrator file.
export type { ScannedFile, ProjectScan };

async function detectTechnology(
  repoRoot: string,
  isGitignored: (relativePath: string, directory?: boolean) => boolean = () => false,
): Promise<string> {
  const techs: string[] = [];
  try {
    const entries = (await fs.readdir(repoRoot)).filter((entry) => !isGitignored(entry));
    const names = new Set(entries.map(e => e.toLowerCase()));

    // .NET / C#
    const hasCsproj = entries.some(e => e.endsWith(".csproj") || e.endsWith(".sln"));
    if (hasCsproj) techs.push("C#/.NET");

    // Node.js ecosystem
    if (names.has("package.json")) {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf-8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (names.has("tsconfig.json") || deps?.typescript) techs.push("TypeScript");
        else techs.push("JavaScript");
        if (deps?.next) techs.push("Next.js");
        else if (deps?.nuxt) techs.push("Nuxt");
        else if (deps?.react) techs.push("React");
        else if (deps?.vue) techs.push("Vue");
        else if (deps?.svelte) techs.push("Svelte");
        if (deps?.express) techs.push("Express");
        else if (deps?.fastify) techs.push("Fastify");
        techs.push("Node.js");
      } catch { /* ignore */ }
    }

    if (names.has("requirements.txt") || names.has("pyproject.toml")) techs.push("Python");
    if (names.has("cargo.toml")) techs.push("Rust");
    if (names.has("go.mod")) techs.push("Go");
    if (names.has("pom.xml") || names.has("build.gradle")) techs.push("Java");

  } catch { /* ignore */ }
  return techs.length > 0 ? techs.join(", ") : "Unknown";
}

/**
 * Build the repository-root .gitignore matcher used by every scan phase.
 * Git paths are always relative POSIX paths; directories include a trailing
 * slash so directory-only patterns (for example `generated/`) behave exactly
 * as they do in Git.
 */
export async function createRootGitignoreFilter(
  repoRoot: string,
): Promise<(relativePath: string, directory?: boolean) => boolean> {
  let matcher: Ignore | null = null;
  try {
    const rules = await fs.readFile(path.join(repoRoot, ".gitignore"), "utf-8");
    matcher = ignore().add(rules);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`scan_project: could not read ${path.join(repoRoot, ".gitignore")}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (relativePath: string, directory = false): boolean => {
    if (!matcher) return false;
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    if (!normalized || normalized === ".") return false;
    return matcher.ignores(directory && !normalized.endsWith("/") ? `${normalized}/` : normalized);
  };
}

async function scanProject(
  repoName: string,
  repoRoot: string,
  maxDepth: number,
): Promise<ProjectScan> {
  const files: ScannedFile[] = [];
  const uiFiles: ScannedFile[] = [];
  const auxiliaryFiles: ProjectScan["auxiliaryFiles"] = {
    test_suite: [],
    configuration: [],
    automation_script: [],
    mcp_tool: [],
  };
  const manifestContent: Record<string, string> = {};
  const topLevelDirs: string[] = [];
  const isGitignored = await createRootGitignoreFilter(repoRoot);
  const technology = await detectTechnology(repoRoot, isGitignored);

  // Collect top-level directories
  try {
    const topEntries = await fs.readdir(repoRoot, { withFileTypes: true });
    for (const e of topEntries) {
      const entryPath = path.join(repoRoot, e.name);
      if (
        e.isDirectory() &&
        !isGitignored(e.name, true) &&
        !shouldSkipScanDirectory({ repoRoot, absDir: entryPath, entryName: e.name })
      ) {
        topLevelDirs.push(e.name);
      }
    }
  } catch { /* ignore */ }

  // Read key manifest files
  for (const manifestName of MANIFEST_FILES) {
    if (manifestName.startsWith("*")) continue; // glob patterns handled below
    if (isGitignored(manifestName)) continue;
    try {
      const content = await fs.readFile(path.join(repoRoot, manifestName), "utf-8");
      manifestContent[manifestName] = content.slice(0, 4096); // cap size
    } catch { /* doesn't exist */ }
  }

  // Handle *.csproj / *.sln / *.fsproj
  try {
    const rootEntries = await fs.readdir(repoRoot);
    for (const entry of rootEntries) {
      if (/\.(csproj|sln|fsproj)$/i.test(entry)) {
        if (isGitignored(entry)) continue;
        try {
          const content = await fs.readFile(path.join(repoRoot, entry), "utf-8");
          manifestContent[entry] = content.slice(0, 4096);
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // Recursive file scan
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      const relEntry = path.relative(repoRoot, entryPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (
          !isGitignored(relEntry, true) &&
          !shouldSkipScanDirectory({ repoRoot, absDir: entryPath, entryName: entry.name })
        ) {
          await walk(entryPath, depth + 1);
        }
      } else if (entry.isFile()) {
        if (isGitignored(relEntry)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        const abs = entryPath;
        const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
        let size = 0;
        try { size = (await fs.stat(abs)).size; } catch { /* ignore */ }

        const scanned: ScannedFile = {
          abs,
          rel,
          name: entry.name,
          ext,
          dirParts: path.dirname(rel).split("/").filter(Boolean),
          size,
        };

        if (CODE_EXTENSIONS.has(ext)) {
          files.push(scanned);

          // Check if it's a UI file
          if (UI_FILE_PATTERNS.some(p => p.test(rel))) {
            uiFiles.push(scanned);
          }
        }

        // Auxiliary classification (Phase 5 #9). Independent of CODE_EXTENSIONS
        // so we also surface .json/.yaml/.toml/.sh/.ps1 etc.
        const auxKind = classifyAuxiliaryFile(rel, entry.name);
        if (auxKind) {
          auxiliaryFiles[auxKind].push(scanned);
        }
      }
    }
  }

  await walk(repoRoot, 0);

  return { repoName, repoRoot, technology, files, manifestContent, uiFiles, topLevelDirs, auxiliaryFiles };
}

// ---------------------------------------------------------------------------
// File tree summary for LLM prompt
// ---------------------------------------------------------------------------

function buildTreeSummary(scan: ProjectScan): string {
  // Group files by top-level directory
  const dirCounts = new Map<string, number>();
  for (const f of scan.files) {
    const topDir = f.dirParts[0] ?? "(root)";
    dirCounts.set(topDir, (dirCounts.get(topDir) ?? 0) + 1);
  }

  const lines: string[] = [
    `Project: ${scan.repoName}`,
    `Technology: ${scan.technology}`,
    `Total source files: ${scan.files.length}`,
    `Top-level directories: ${scan.topLevelDirs.join(", ")}`,
    "",
    "Directory file counts:",
  ];

  for (const [dir, count] of [...dirCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${dir}/  — ${count} files`);
  }

  return lines.join("\n");
}

function buildFileListing(files: ScannedFile[], maxFiles: number): string {
  // Take a representative sample: sort by directory depth and take the most interesting
  const sorted = [...files].sort((a, b) => {
    // Prefer files in diverse directories
    const depthDiff = a.dirParts.length - b.dirParts.length;
    if (depthDiff !== 0) return depthDiff;
    return a.rel.localeCompare(b.rel);
  });

  const sample = sorted.slice(0, maxFiles);
  return sample.map(f => f.rel).join("\n");
}

// ---------------------------------------------------------------------------
// Read key files for LLM context
// ---------------------------------------------------------------------------

async function readKeyFiles(scan: ProjectScan, maxFiles: number): Promise<string> {
  // Prioritize: manifests, main entry points, README, then top-level files
  const keyPatterns = [
    /readme/i, /^src\/(index|main|app)\./i,
    /^(index|main|app)\./i, /^src\/.*\/index\./i,
    /program\.cs$/i, /startup\.cs$/i, /app\.xaml/i,
  ];

  const prioritized: ScannedFile[] = [];
  const rest: ScannedFile[] = [];

  for (const f of scan.files) {
    if (keyPatterns.some(p => p.test(f.rel))) {
      prioritized.push(f);
    } else {
      rest.push(f);
    }
  }

  // Take prioritized files + fill up with representative files from different directories
  const selectedDirs = new Set<string>();
  const selected: ScannedFile[] = [...prioritized.slice(0, Math.ceil(maxFiles / 2))];

  for (const f of rest) {
    if (selected.length >= maxFiles) break;
    const topDir = f.dirParts[0] ?? "(root)";
    if (!selectedDirs.has(topDir)) {
      selected.push(f);
      selectedDirs.add(topDir);
    }
  }

  const fragments: string[] = [];
  for (const f of selected) {
    try {
      const fd = await fs.open(f.abs, "r");
      const buf = Buffer.alloc(MAX_FILE_BYTES);
      const { bytesRead } = await fd.read(buf, 0, MAX_FILE_BYTES, 0);
      await fd.close();
      const content = buf.toString("utf-8", 0, bytesRead);
      fragments.push(`--- ${f.rel} ---\n${content}\n`);
    } catch { /* skip unreadable files */ }
  }

  return fragments.join("\n");
}

// ---------------------------------------------------------------------------
// LLM enrichment prompts
// ---------------------------------------------------------------------------

function buildEnrichmentPrompt(
  treeSummary: string,
  fileListing: string,
  keyFileContents: string,
  manifestSummary: string,
  target: "features" | "workflows" | "data_model",
  repoName: string,
): LlmMessage[] {
  const targetInstructions: Record<string, string> = {
    features: `Identify major features and modules that are directly evidenced by this project.
Each feature should have:
- id: snake_case unique identifier
- name: Human-readable feature name
- description: 2-3 sentences explaining what the cited source files prove it does
- source_repo: "${repoName}" 
- source_files: array of key source file paths (relative to repo root) that prove this feature exists
- status: "active"
- category: logical category inferred only from discovered names/content in this project
- tags: array of relevant tags inferred only from discovered names/content in this project
- domain: domain grouping inferred only from discovered names/content in this project
- keywords: array of keywords from cited file paths, manifests, or source content

Discovery rules:
- Do not assume any programming language, framework, platform, datastore, architecture, or directory convention beyond the provided evidence.
- Do not carry over DreamGraph concepts or any other product architecture unless the cited project files explicitly contain them.
- Prefer fewer, well-evidenced features over many speculative ones.
- Every feature must cite source_files that justify the name and description.`,

    workflows: `Identify workflows that are directly evidenced by this project.

Semantic definition:
A workflow is a connected, ordered, or causal progression of actions, events, decisions, or state transitions where one step meaningfully influences or enables another and the chain advances a system outcome. It is behavioral progression, not a specific technology.

Each workflow should have:
- id: snake_case unique identifier
- name: Human-readable workflow name that reflects the project's own vocabulary
- description: 2-3 rich sentences explaining the cause/effect chain proven by the cited source files, including the outcome it advances
- workflow_kind: optional evidence-derived semantic category such as ui_interaction, state_transition_chain, event_flow, command_flow, traversal_flow, parser_flow, game_loop, approval_flow, orchestration_flow, or another project-specific kind; omit if not evidenced
- trigger: What initiates this workflow, only if evidenced; otherwise use "unknown from discovered source"
- source_repo: "${repoName}"
- source_files: array of source file paths that prove this workflow exists
- domain: domain grouping inferred only from discovered names/content in this project
- keywords: array of keywords from cited file paths, manifests, or source content
- status: "active"
- steps: array of { order: number, name: string, description: string } using only observed code/file evidence; each step should describe the action/event/decision/state transition and its causal role

Discovery rules:
- Preserve semantic richness: do not suppress valid workflows just because they are not pipelines, jobs, web routes, queues, BPMN, or automation.
- Do not invent workflows to satisfy a quota.
- Do not include generic examples such as plugin discovery, navigation, settings, build, error handling, or startup unless this specific project's files prove them.
- Do not assume UI, backend, CLI, plugin, datastore, routing, queue, microservice, deployment, or framework behavior from directory names alone.
- Architecture is structural organization; workflow is behavioral progression. Do not confuse the two.
- Prefer fewer, well-evidenced workflows over many speculative ones, but keep descriptions and steps rich when evidence exists.`,


    data_model: `Identify data models that are directly evidenced by this project.

Semantic definition:
A data model is the structure and relationships of information inside the system. It can be a C struct, linked list, in-memory graph, JSON/XML/protobuf shape, flat-file record, message payload, ECS component layout, binary format, TypeScript interface, Rust enum, serialization schema, parser AST, GPU buffer, or any other explicit information structure. It does not require a datastore.

Each entity should have:
- id: snake_case unique identifier
- name: Human-readable entity name
- description: 2-3 rich sentences explaining what information structure the cited source files prove, what fields/parts matter, and how it participates in the system
- model_kind: optional evidence-derived semantic category such as struct_layout, linked_structure, in_memory_graph, json_shape, protobuf_schema, xml_shape, flat_file_record, message_contract, ecs_component, binary_layout, type_interface, enum_shape, serialization_schema, parser_ast, gpu_buffer, state_shape, domain_entity, api_contract, validation_schema, config_schema, persistence_model, or another project-specific kind; omit if not evidenced
- source_repo: "${repoName}"
- source_files: array of source file paths where this is defined
- domain: domain grouping inferred only from discovered names/content in this project
- keywords: array of keywords from cited file paths, manifests, or source content
- status: "active"
- key_fields: array of { name: string, type: string, description: string } using only fields visible in source evidence
- relationships: array of { type: string, target: string, via: string } using only explicit code references or strongly evidenced relations between information structures

Discovery rules:
- Preserve semantic richness: a proven information structure is a valid data model even without a database, table, repository, ORM, or persistence layer.
- Do not assume a datastore exists. Only include table_name, storage, persistence, registry, or database claims when the cited files explicitly prove them.
- Do not include generic examples such as configuration, plugin manifests, settings schemas, DTOs, API contracts, or state models unless this specific project's files prove them.
- Persistence is state retention strategy; data model is information structure. Do not confuse the two.
- Prefer fewer, well-evidenced data entities over many speculative ones, but keep descriptions, fields, and relationships rich when evidence exists.`,

  };

  return [
    {
      role: "system" as const,
      content:
        `You are a software architecture analyst. Analyze the given project and extract structured data.\n` +
        `Respond with a JSON array of objects. No markdown, no explanation.\n` +
        `If you must wrap it in an object, use a key matching the target type (e.g. {"features": [...]}).\n` +
        `${targetInstructions[target]}`,
    },
    {
      role: "user" as const,
      content:
        `## Project Structure\n${treeSummary}\n\n` +
        `## File Listing\n${fileListing}\n\n` +
        `## Manifest Files\n${manifestSummary}\n\n` +
        `## Key Source Files\n${keyFileContents}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Seed data persistence (reused from enrich-seed-data patterns)
//
// Pure helpers (`stripTemplateStubs`, `mergeById`, `extractJsonArray`,
// `ensureStringArray`, `sanitizeEntry`) live in `./sanitize-entity.js`.
// ---------------------------------------------------------------------------

async function buildIndex(overrides: Partial<Record<"features.json" | "workflows.json" | "data_model.json", Record<string, unknown>[]>> = {}): Promise<ResourceIndex> {
  const features = (overrides["features.json"] ?? await loadJsonArray<Feature>("features.json")) as Feature[];
  const workflows = (overrides["workflows.json"] ?? await loadJsonArray<Workflow>("workflows.json")) as Workflow[];
  const dataModel = (overrides["data_model.json"] ?? await loadJsonArray<DataModelEntity>("data_model.json")) as DataModelEntity[];
  const datastores = await loadJsonArray<Datastore>("datastores.json");

  const entities: Record<string, IndexEntry> = {};
  for (const f of stripTemplateStubs(features)) {
    entities[f.id] = { type: "feature", uri: `dreamgraph://resource/feature/${f.id}`, name: f.name, source_repo: f.source_repo };
  }
  for (const w of stripTemplateStubs(workflows)) {
    entities[w.id] = { type: "workflow", uri: `dreamgraph://resource/workflow/${w.id}`, name: w.name, source_repo: w.source_repo };
  }
  for (const d of stripTemplateStubs(dataModel)) {
    entities[d.id] = { type: "data_model", uri: `dreamgraph://resource/data_model/${d.id}`, name: d.name, source_repo: d.source_repo };
  }
  for (const d of stripTemplateStubs(datastores)) {
    entities[d.id] = { type: "datastore", uri: `dreamgraph://resource/datastore/${d.id}`, name: d.name, source_repo: d.source_repo };
  }

  // Slice 1 — first-class UI graph citizens. Only source-bound entries.
  try {
    for (const u of await loadIndexableUIElements()) {
      entities[u.id] = {
        type: "ui_element",
        uri: `dreamgraph://resource/ui_element/${u.id}`,
        name: u.name,
        source_repo: u.source_repo,
      };
    }
  } catch (err) {
    logger.warn(`scan_project: failed to fold UI elements into index: ${err instanceof Error ? err.message : err}`);
  }

  // Phase 5 #9 — surface auxiliary entities in the index so downstream
  // tools (`query_resource`, `system://index`) can find them.
  try {
    const aux = await loadAuxiliaryEntities();
    for (const e of aux.entries) {
      entities[e.id] = {
        type: e.kind,
        uri: e.uri,
        name: e.name,
        source_repo: e.source_repo,
      };
    }
  } catch (err) {
    logger.warn(`scan_project: failed to fold auxiliary entities into index: ${err instanceof Error ? err.message : err}`);
  }

  return { entities };
}

async function rebuildIndex(): Promise<number> {
  const index = await buildIndex();
  await atomicWriteFile(dataPath("index.json"), JSON.stringify(index, null, 2));
  invalidateCache("index.json");
  return Object.keys(index.entities).length;
}

async function writeSeed(filename: string, data: unknown): Promise<void> {
  await atomicWriteFile(dataPath(filename), JSON.stringify(data, null, 2));
  invalidateCache(filename);
}

// ---------------------------------------------------------------------------
// LLM response parsing helpers — moved to ./sanitize-entity.js
// (`extractJsonArray`, `ensureStringArray`, `sanitizeEntry`).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ScanProjectResult {
  repos_scanned: number;
  files_discovered: number;
  ui_files_detected: number;
  technology: string;
  llm_used: boolean;
  features: { inserted: number; updated: number; total: number };
  workflows: { inserted: number; updated: number; total: number };
  data_model: { inserted: number; updated: number; total: number };
  /**
   * Slice 2 — UI registry counters. Only present when the `ui` target
   * ran. Counts scanner-origin entries only; manual / sdk entries are
   * never touched by the scanner and are not reflected here.
   */
  ui?: {
    inserted: number;
    updated: number;
    skipped_protected: number;
    total_for_repo: number;
  };
  /**
   * Wave-1 #4 — parser-backed (tree-sitter) coverage for native code
   * (C / C++). `parser_backed_files` is the number of C/C++ files the
   * extractor processed without throwing; `total_native_files` is the
   * number of C/C++ files discovered overall. Both are zero when the
   * project has no native source.
   */
  scan_quality?: {
    parser_backed_files: number;
    total_native_files: number;
    parser_backed_pct: number;
    native_diagnostics: number;
    /** Slice 2 — UI files matched by a framework extractor. */
    ui_parsed_files?: number;
    ui_total_files?: number;
    ui_diagnostics?: number;
  };
  /** Phase 5 #9 — auxiliary entities (tests/configs/scripts/MCP tools). */
  auxiliary?: {
    inserted: number;
    updated: number;
    total: number;
    by_kind: { test_suite: number; configuration: number; automation_script: number; mcp_tool: number };
  };
  datastore_scan?: {
    datastore_id: string;
    tables_found: number;
    tables_kept: number;
    data_models_created: number;
    data_models_linked: number;
  };
  semantic_enrichment?: EnrichResult;
  index_entries: number;
  llm_tokens_used: number;
  dream_cycle?: {
    edges_created: number;
    nodes_created: number;
    edges_validated?: number;
    edges_promoted?: number;
  };
  targeted_dream_schedules?: {
    created: number;
    reused: number;
    schedule_ids: string[];
    focus_entities: string[];
  };
  delta_preview?: ScanDeltaPreview;
  incremental_metrics?: {
    parser_invocations: number;
    unchanged_files_parsed: number;
    llm_calls: number;
    semantic_retained: number;
    semantic_invalidated: number;
    semantic_eligible: number;
    semantic_reviewed_manual: number;
    reasons: Record<string, number>;
  };
  errors: string[];
  message: string;
}

type StructuralTarget = "features" | "workflows" | "data_model";
type StructuralExtractor = (scan: ProjectScan) => Record<string, unknown>[];

export interface IncrementalScanTestHooks {
  /** Observes production registry routing without replacing orchestration. */
  onExtractorSelected?: (target: StructuralTarget, scan: ProjectScan) => Promise<void> | void;
  /** Controlled extractor fixture when content-sensitive deterministic evidence is required. */
  extractorOverrides?: Partial<Record<StructuralTarget, StructuralExtractor>>;
  /** Deterministic barrier used to mutate a fixture after extraction and before fingerprint validation. */
  afterExtractionAttempt?: (attempt: number) => Promise<void> | void;
}

export interface RunScanOptions {
  depth?: "shallow" | "deep";
  targets?: string[];
  repos?: string[];
  mode?: "full" | "incremental";
  dry_run?: boolean;
  enrich?: boolean;
  /** Optional progress callback (replaces MCP progress notifications) */
  onProgress?: (message: string, step: number, total: number) => void;
  /** Test-only observation/barrier hooks; omitted by MCP, CLI, and production callers. */
  test_hooks?: IncrementalScanTestHooks;
  /** Internal bounded retry counter; production callers must not set this. */
  _incremental_attempt?: number;
}

// ---------------------------------------------------------------------------
// Core scan logic — callable from MCP tool and bootstrap
// ---------------------------------------------------------------------------

/**
 * Run a full project scan, LLM enrichment, and optional dream cycle.
 * This is the core engine behind the `scan_project` MCP tool.
 * Can also be called programmatically (e.g. during instance bootstrap).
 */
export async function runScanProject(opts: RunScanOptions = {}): Promise<ScanProjectResult> {
  const VALID_TARGETS = ["features", "workflows", "data_model", "ui"];
  const depth = opts.depth ?? "deep";
  const targetList = opts.targets ?? [...VALID_TARGETS];
  const repos = opts.repos;

  // Validate targets
  const invalidTargets = targetList.filter(t => !VALID_TARGETS.includes(t));
  if (invalidTargets.length > 0) {
    throw new Error(`Invalid target(s): ${invalidTargets.join(", ")}. Must be one of: ${VALID_TARGETS.join(", ")}`);
  }

  // ---- Progress helper ----
  let _step = 0;
  const _totalSteps = 2 + targetList.length + 1;
  function progress(message: string): void {
    _step++;
    logger.info(`scan_project: ${message}`);
    opts.onProgress?.(message, _step, _totalSteps);
  }

  // Validate repos
  const availableRepos = Object.keys(config.repos);
  if (availableRepos.length === 0) {
    throw new Error("No repositories configured. Set project root or DREAMGRAPH_REPOS.");
  }
  const targetRepos = repos ?? availableRepos;
  const unknown = targetRepos.filter(r => !config.repos[r]);
  if (unknown.length > 0) {
    throw new Error(`Unknown repos: ${unknown.join(", ")}. Available: ${availableRepos.join(", ")}`);
  }

  const mode = opts.mode ?? "full";
  if (mode === "incremental") {
    const selectedRepos = Object.fromEntries(targetRepos.map((name) => [name, config.repos[name]]));
    progress("Previewing incremental repository evidence delta…");
    const baseline = await loadScanState();
    const deltaPreview = await previewIncrementalScan({
      repos: selectedRepos,
      depth,
      targets: targetList as ScanTarget[],
      ...(baseline.state ? { baseline: baseline.state } : {}),
    });
    if (deltaPreview.full_scan_required) {
      throw new Error(`INCREMENTAL_BASELINE_REQUIRED: ${deltaPreview.reason ?? deltaPreview.baseline_status}. Run an explicit full scan.`);
    }
    const changedCount = deltaPreview.metrics.files_added + deltaPreview.metrics.files_modified +
      deltaPreview.metrics.files_deleted + deltaPreview.metrics.files_renamed;
    if (opts.dry_run === true || changedCount === 0) {
      const summary = `Incremental ${opts.dry_run === true ? "preview" : "no-op"}: ${deltaPreview.metrics.files_added} added, ` +
        `${deltaPreview.metrics.files_modified} modified, ${deltaPreview.metrics.files_deleted} deleted, ` +
        `${deltaPreview.metrics.files_renamed} renamed, ${deltaPreview.metrics.files_unchanged} unchanged; zero graph churn.`;
      return {
        repos_scanned: 0, files_discovered: deltaPreview.metrics.files_discovered, ui_files_detected: 0,
        technology: "", llm_used: false,
        features: { inserted: 0, updated: 0, total: 0 },
        workflows: { inserted: 0, updated: 0, total: 0 },
        data_model: { inserted: 0, updated: 0, total: 0 },
        index_entries: 0, llm_tokens_used: 0, delta_preview: deltaPreview, errors: [], message: summary,
      };
    }

    const attempt = opts._incremental_attempt ?? 0;
    const maxAttempts = 3;
    const current = await buildScanState({
      repos: selectedRepos, depth, targets: targetList as ScanTarget[],
      operation: "incremental", previous: baseline.state,
    });
    const scans: ProjectScan[] = [];
    const fileHashes: Record<string, Record<string, string>> = {};
    for (const repoDelta of deltaPreview.repositories) {
      const root = path.resolve(selectedRepos[repoDelta.repo_name]);
      const snapshot = current.repos[repoDelta.repo_name];
      const changed = [...repoDelta.added, ...repoDelta.modified, ...repoDelta.renamed.map((move) => move.to)];
      fileHashes[repoDelta.repo_name] = Object.fromEntries(changed.map((file) => [file, snapshot.files[file].content_hash]));
      const files = await Promise.all(changed.map(async (file) => {
        const evidence = snapshot.files[file];
        const captured = await fs.readFile(path.resolve(root, ...file.split("/")));
        const capturedHash = `sha256:${createHash("sha256").update(captured).digest("hex")}`;
        if (capturedHash !== evidence.content_hash) {
          throw new Error("INCREMENTAL_SOURCE_CHANGED_DURING_CAPTURE");
        }
        return {
          ...makeScannedFile(root, file, evidence.size),
          content: captured.toString("utf8"),
          content_hash: capturedHash,
        };
      }));
      scans.push({
        repoName: repoDelta.repo_name, repoRoot: root, technology: "incremental",
        files, uiFiles: files.filter((file) => UI_FILE_PATTERNS.some((pattern) => pattern.test(file.rel))),
        manifestContent: {}, topLevelDirs: [...new Set(files.map((file) => file.dirParts[0]).filter(Boolean))] as string[],
        auxiliaryFiles: { test_suite: [], configuration: [], automation_script: [], mcp_tool: [] },
      });
    }

    const staged = new Map<string, Record<string, unknown>[]>();
    let ledger: StructuralEvidenceLedger | undefined = baseline.state?.evidence_ledger;
    const counters = {
      features: { inserted: 0, updated: 0, total: 0 },
      workflows: { inserted: 0, updated: 0, total: 0 },
      data_model: { inserted: 0, updated: 0, total: 0 },
    };
    const semanticMetrics = {
      retained: 0, invalidated: 0, eligible: 0, reviewed_manual: 0,
      reasons: {} as Record<string, number>,
    };
    const extractorRegistry: ReadonlyArray<{
      target: StructuralTarget;
      file: "features.json" | "workflows.json" | "data_model.json";
      generate: StructuralExtractor;
    }> = [
      { target: "features", file: "features.json", generate: generateStructuralFeatures },
      { target: "workflows", file: "workflows.json", generate: generateStructuralWorkflows },
      { target: "data_model", file: "data_model.json", generate: generateStructuralDataModel },
    ];
    for (const spec of extractorRegistry) {
      if (!targetList.includes(spec.target)) continue;
      const existing = stripTemplateStubs(await loadJsonArray<Record<string, unknown>>(spec.file));
      const incoming = (await Promise.all(scans.map(async (scan) => {
        await opts.test_hooks?.onExtractorSelected?.(spec.target, scan);
        const extractor = opts.test_hooks?.extractorOverrides?.[spec.target] ?? spec.generate;
        return extractor(scan).map((entity) => ({
          repo: scan.repoName, target: spec.target, kind: spec.target, entity,
          file_hashes: fileHashes[scan.repoName],
        }));
      }))).flat();
      const reconciled = reconcileAddedModifiedEntities({
        existing,
        incoming,
        previous_ledger: ledger,
        reconciliation_target: spec.target,
        replaced_support_paths: deltaPreview.repositories.flatMap((repo) =>
          [...repo.added, ...repo.modified, ...repo.renamed.map((move) => move.to)]
            .map((file) => ({ repo: repo.repo_name, path: file }))
        ),
        revision: current.committed_revision,
      });
      const lifecycle = withdrawStructuralEvidence({
        ledger: reconciled.ledger,
        entities: reconciled.entities,
        changes: deltaPreview.repositories.map((repo) => ({
          repo: repo.repo_name, deleted: repo.deleted, renamed: repo.renamed,
        })),
        revision: current.committed_revision,
      });
      ledger = lifecycle.ledger;
      semanticMetrics.retained += reconciled.semantic_metrics.retained;
      semanticMetrics.invalidated += reconciled.semantic_metrics.invalidated;
      semanticMetrics.eligible += reconciled.semantic_metrics.eligible;
      semanticMetrics.reviewed_manual += reconciled.semantic_metrics.reviewed_manual;
      for (const [reason, count] of Object.entries(reconciled.semantic_metrics.reasons)) {
        semanticMetrics.reasons[reason] = (semanticMetrics.reasons[reason] ?? 0) + count;
      }
      const derived = updateDerivedHubStates(lifecycle.entities, lifecycle.ledger);
      staged.set(spec.file, derived.entities);
      counters[spec.target] = {
        inserted: reconciled.inserted, updated: reconciled.updated + lifecycle.deprecated, total: derived.entities.length,
      };
    }
    current.evidence_ledger = ledger;
    const coverageCanonical: Array<{ target: string; entity: Record<string, unknown> }> = [];
    for (const spec of extractorRegistry) {
      const entities = staged.get(spec.file) ?? stripTemplateStubs(await loadJsonArray<Record<string, unknown>>(spec.file));
      coverageCanonical.push(...entities.map((entity) => ({ target: spec.target, entity })));
    }
    const coverageUi = await loadIndexableUIElements();
    coverageCanonical.push(...coverageUi.map((entity) => ({ target: "ui", entity: entity as unknown as Record<string, unknown> })));
    const coverageAuxiliary = await loadAuxiliaryEntities();
    coverageCanonical.push(...coverageAuxiliary.entries.map((entity) => ({ target: "auxiliary", entity: entity as unknown as Record<string, unknown> })));
    current.coverage_ledger = buildCoverageLedger(current, coverageCanonical);
    const incrementalCoverageErrors = validateCoverageLedger(current.coverage_ledger);
    if (incrementalCoverageErrors.length > 0) {
      throw new Error(`SCAN_COVERAGE_INVALID: ${incrementalCoverageErrors.join("; ")}`);
    }

    await opts.test_hooks?.afterExtractionAttempt?.(attempt + 1);

    // Extraction and the committed fingerprint must describe one stable byte snapshot.
    const revalidated = await buildScanState({
      repos: selectedRepos, depth, targets: targetList as ScanTarget[],
      operation: "incremental", previous: baseline.state,
    });
    if (revalidated.committed_revision !== current.committed_revision) {
      if (attempt + 1 < maxAttempts) {
        return runScanProject({ ...opts, _incremental_attempt: attempt + 1 });
      }
      throw new Error(
        `INCREMENTAL_SOURCE_UNSTABLE: repository evidence changed during all ${maxAttempts} extraction attempts; no graph state committed.`,
      );
    }

    const stagedIndex = await buildIndex(Object.fromEntries(staged) as Partial<Record<"features.json" | "workflows.json" | "data_model.json", Record<string, unknown>[]>>);
    const writes = [...staged].map(([file, entities]) => ({ file, content: JSON.stringify(entities, null, 2) }));
    writes.push({ file: "index.json", content: JSON.stringify(stagedIndex, null, 2) });
    writes.push({ file: "scan_state.json", content: JSON.stringify(current, null, 2) });
    await withReconciliationTransaction({
      expected_revision: baseline.state?.committed_revision ?? null,
      next_revision: current.committed_revision,
      writes,
      read_current_revision: async () => (await loadScanState()).state?.committed_revision ?? null,
    });
    let explicitEnrichment: EnrichResult | undefined;
    if (opts.enrich === true) {
      const enriched = await enrichParserNodesProgrammatic({
        target: "all", maxNodes: Number.MAX_SAFE_INTEGER, batchSize: 12,
        dryRun: false, force: false, contextHops: 3, relationContextSize: 40,
        modelSource: "auto", scheduleStabilization: false,
      });
      if (enriched.success) explicitEnrichment = enriched.data;
    }
    const incrementalIndexEntries = Object.keys(stagedIndex.entities).length;
    return {
      repos_scanned: scans.length, files_discovered: changedCount, ui_files_detected: scans.reduce((n, scan) => n + scan.uiFiles.length, 0),
      technology: "incremental", llm_used: false,
      features: counters.features, workflows: counters.workflows, data_model: counters.data_model,
      semantic_enrichment: explicitEnrichment,
      index_entries: incrementalIndexEntries, llm_tokens_used: explicitEnrichment?.tokens_used ?? 0, delta_preview: deltaPreview,
      incremental_metrics: {
        parser_invocations: scans.reduce((count, scan) => count + scan.files.length, 0),
        unchanged_files_parsed: 0,
        llm_calls: explicitEnrichment?.llm_calls ?? 0,
        semantic_retained: semanticMetrics.retained,
        semantic_invalidated: semanticMetrics.invalidated,
        semantic_eligible: semanticMetrics.eligible,
        semantic_reviewed_manual: semanticMetrics.reviewed_manual,
        reasons: semanticMetrics.reasons,
      },
      errors: [],
      message: `Incremental reconciliation committed ${changedCount} changed file(s) at ${current.committed_revision}; zero LLM calls.`,
    };
  }

  const requestedMaxDepth = depth === "shallow" ? 3 : 10;
  const errors: string[] = [];
  let totalTokens = 0;
  let partialModeUsed = false;

  // Phase 1: Mechanical scan with adaptive fallback
  progress("Phase 1 — scanning file system…");
  const scans: ProjectScan[] = [];
  for (const repoName of targetRepos) {
    const repoRoot = path.resolve(config.repos[repoName]);
    let scan: ProjectScan;
    try {
      scan = await scanProject(repoName, repoRoot, requestedMaxDepth);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Primary scan failed for ${repoName}: ${msg}`);
      progress(`Primary scan failed for ${repoName}; retrying with shallow structural scan…`);
      scan = await scanProject(repoName, repoRoot, 2);
      partialModeUsed = true;
    }

    scans.push(scan);
    logger.info(
      `scan_project: ${repoName} — ${scan.files.length} files, ${scan.uiFiles.length} UI files, ` +
      `tech: ${scan.technology}, dirs: ${scan.topLevelDirs.join(", ")}`,
    );
    progress(`Scanned ${repoName}: ${scan.files.length} files, tech: ${scan.technology}`);
  }

  const totalFiles = scans.reduce((s, sc) => s + sc.files.length, 0);
  const totalUiFiles = scans.reduce((s, sc) => s + sc.uiFiles.length, 0);
  const techSummary = scans.map(s => s.technology).join("; ");

  // Phase 2: LLM enrichment (or structural fallback)
  const llmAvailable = await isLlmAvailable();
  const dreamerConfig = getDreamerLlmConfig();

  const featureResult = { inserted: 0, updated: 0, total: 0 };
  const workflowResult = { inserted: 0, updated: 0, total: 0 };
  const dataModelResult = { inserted: 0, updated: 0, total: 0 };

  const repoRequiresStructuralOnly = (_scan: ProjectScan): boolean => partialModeUsed;

  if (llmAvailable) {
    logger.info(`scan_project: Phase 2 — LLM enrichment (model: ${dreamerConfig.model})`);
    progress(`Phase 2 — LLM enrichment (model: ${dreamerConfig.model})…`);
    const llm = getLlmProvider();

    for (const scan of scans) {
      const forceStructuralForRepo = repoRequiresStructuralOnly(scan);
      if (forceStructuralForRepo) {
        errors.push(`LLM enrichment skipped for ${scan.repoName}: using bounded structural extraction to prevent timeout/user-visible failure.`);
        if (targetList.includes("features")) {
          const featureEntries = generateStructuralFeatures(scan);
          const existing = stripTemplateStubs(await loadJsonArray<Record<string, unknown>>("features.json"));
          const merged = mergeById(existing, featureEntries);
          await writeSeed("features.json", merged.merged);
          featureResult.inserted += merged.inserted;
          featureResult.updated += merged.updated;
          featureResult.total = merged.merged.length;
        }

        if (targetList.includes("workflows")) {
          const workflowEntries = generateStructuralWorkflows(scan);
          const existing = stripTemplateStubs(await loadJsonArray<Record<string, unknown>>("workflows.json"));
          const merged = mergeById(existing, workflowEntries);
          await writeSeed("workflows.json", merged.merged);
          workflowResult.inserted += merged.inserted;
          workflowResult.updated += merged.updated;
          workflowResult.total = merged.merged.length;
        }

        if (targetList.includes("data_model")) {
          const dmEntries = generateStructuralDataModel(scan);
          const existing = stripTemplateStubs(await loadJsonArray<Record<string, unknown>>("data_model.json"));
          const merged = mergeById(existing, dmEntries);
          await writeSeed("data_model.json", merged.merged);
          dataModelResult.inserted += merged.inserted;
          dataModelResult.updated += merged.updated;
          dataModelResult.total = merged.merged.length;
        }
        continue;
      }

      const treeSummary = buildTreeSummary(scan);
      const fileListing = buildFileListing(scan.files, LLM_BATCH_SIZE * 2);
      const keyFileContents = await readKeyFiles(scan, 15);
      const manifestSummary = Object.entries(scan.manifestContent)
        .map(([name, content]) => `--- ${name} ---\n${content}`)
        .join("\n\n");

      // UI nodes are produced by the source-aware UI scanner below and then
      // enriched with every other canonical node in the graph-wide pass.
      for (const target of targetList.filter((candidate) => candidate !== "ui")) {
        try {
          const messages = buildEnrichmentPrompt(
            treeSummary, fileListing, keyFileContents, manifestSummary, target as "features" | "workflows" | "data_model", scan.repoName,
          );

          logger.info(`scan_project: LLM call for ${target} (${scan.repoName})`);
          progress(`LLM extracting ${target} from ${scan.repoName}…`);
          const response = await llm.complete(messages, {
            model: dreamerConfig.model,
            temperature: 0.3,
            maxTokens: Math.min(dreamerConfig.maxTokens, 4000),
            jsonMode: true,
          });

          totalTokens += response.tokensUsed ?? 0;

          const rawEntries = extractJsonArray(response.text);
          if (rawEntries.length === 0) {
            const preview = response.text.slice(0, 500).replace(/\n/g, "\\n");
            errors.push(`LLM returned no parseable ${target} entries for ${scan.repoName}; falling back to structural extraction for this target.`);
            logger.warn(`scan_project: LLM returned no entries for ${target} (${scan.repoName}). Response preview: ${preview}`);

            const structuralEntries = target === "features"
              ? generateStructuralFeatures(scan)
              : target === "workflows"
                ? generateStructuralWorkflows(scan)
                : generateStructuralDataModel(scan);
            const filename = target === "features" ? "features.json"
              : target === "workflows" ? "workflows.json"
              : "data_model.json";
            const existing = stripTemplateStubs(await loadJsonArray<Record<string, unknown>>(filename));
            const merged = mergeById(existing, structuralEntries);
            await writeSeed(filename, merged.merged);
            const resultRef = target === "features" ? featureResult
              : target === "workflows" ? workflowResult
              : dataModelResult;
            resultRef.inserted += merged.inserted;
            resultRef.updated += merged.updated;
            resultRef.total = merged.merged.length;
            partialModeUsed = true;
            continue;
          }

          const sanitized = rawEntries
            .filter(e => typeof e === "object" && e !== null)
            .map(e => sanitizeEntry(e as Record<string, unknown>, scan.repoName))
            .filter(e => e.id && typeof e.id === "string");

          logger.info(`scan_project: LLM produced ${sanitized.length} ${target} entries (${rawEntries.length} raw)`);

          const filename = target === "features" ? "features.json"
            : target === "workflows" ? "workflows.json"
            : "data_model.json";

          const existing = stripTemplateStubs(await loadJsonArray<Record<string, unknown>>(filename));
          const merged = mergeById(existing, sanitized);

          await writeSeed(filename, merged.merged);
          logger.info(`scan_project: ${target} — ${merged.inserted} inserted, ${merged.updated} updated, ${merged.merged.length} total`);
          progress(`${target}: ${merged.inserted} new, ${merged.updated} updated, ${merged.merged.length} total`);

          const resultRef = target === "features" ? featureResult
            : target === "workflows" ? workflowResult
            : dataModelResult;

          resultRef.inserted += merged.inserted;
          resultRef.updated += merged.updated;
          resultRef.total = merged.merged.length;

        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`LLM enrichment failed for ${target} (${scan.repoName}): ${msg}. Structural fallback applied.`);
          logger.warn(`scan_project: LLM error for ${target}: ${msg}`);

          const structuralEntries = target === "features"
            ? generateStructuralFeatures(scan)
            : target === "workflows"
              ? generateStructuralWorkflows(scan)
              : generateStructuralDataModel(scan);
          const filename = target === "features" ? "features.json"
            : target === "workflows" ? "workflows.json"
            : "data_model.json";
          const existing = stripTemplateStubs(await loadJsonArray<Record<string, unknown>>(filename));
          const merged = mergeById(existing, structuralEntries);
          await writeSeed(filename, merged.merged);
          const resultRef = target === "features" ? featureResult
            : target === "workflows" ? workflowResult
            : dataModelResult;
          resultRef.inserted += merged.inserted;
          resultRef.updated += merged.updated;
          resultRef.total = merged.merged.length;
          partialModeUsed = true;
        }
      }
    }
  } else {
    logger.info("scan_project: Phase 2 — LLM unavailable, structural-only mode");
    progress("Phase 2 — LLM unavailable, using structural analysis…");
    errors.push("Standalone LLM unavailable for coarse extraction; generated structural entries before the mandatory standalone/Architect semantic pass.");

    for (const scan of scans) {
      if (targetList.includes("features")) {
        const featureEntries = generateStructuralFeatures(scan);
        const existing = stripTemplateStubs(await loadJsonArray<Record<string, unknown>>("features.json"));
        const merged = mergeById(existing, featureEntries);
        await writeSeed("features.json", merged.merged);
        featureResult.inserted += merged.inserted;
        featureResult.updated += merged.updated;
        featureResult.total = merged.merged.length;
      }

      if (targetList.includes("workflows")) {
        const workflowEntries = generateStructuralWorkflows(scan);
        const existing = stripTemplateStubs(await loadJsonArray<Record<string, unknown>>("workflows.json"));
        const merged = mergeById(existing, workflowEntries);
        await writeSeed("workflows.json", merged.merged);
        workflowResult.inserted += merged.inserted;
        workflowResult.updated += merged.updated;
        workflowResult.total = merged.merged.length;
      }

      if (targetList.includes("data_model")) {
        const dmEntries = generateStructuralDataModel(scan);
        const existing = stripTemplateStubs(await loadJsonArray<Record<string, unknown>>("data_model.json"));
        const merged = mergeById(existing, dmEntries);
        await writeSeed("data_model.json", merged.merged);
        dataModelResult.inserted += merged.inserted;
        dataModelResult.updated += merged.updated;
        dataModelResult.total = merged.merged.length;
      }
    }
  }

  // Phase 2.5 — auxiliary entity merge (Phase 5 #9). Always runs;
  // structural-only, no LLM dependency. Failures are non-fatal.
  let auxiliaryResult: ScanProjectResult["auxiliary"];
  try {
    progress("Merging auxiliary entities (tests/configs/scripts/MCP tools)…");
    const allAux = [];
    const byKind = { test_suite: 0, configuration: 0, automation_script: 0, mcp_tool: 0 };
    for (const scan of scans) {
      byKind.test_suite += scan.auxiliaryFiles.test_suite.length;
      byKind.configuration += scan.auxiliaryFiles.configuration.length;
      byKind.automation_script += scan.auxiliaryFiles.automation_script.length;
      byKind.mcp_tool += scan.auxiliaryFiles.mcp_tool.length;
      const entries = await generateAuxiliaryEntities(scan);
      allAux.push(...entries);
    }
    if (allAux.length > 0) {
      const merged = await mergeAuxiliaryEntities(allAux);
      auxiliaryResult = { ...merged, by_kind: byKind };
      logger.info(
        `scan_project: auxiliary entities — ${merged.inserted} new, ${merged.updated} updated, ` +
        `${merged.total} total (tests=${byKind.test_suite}, config=${byKind.configuration}, ` +
        `scripts=${byKind.automation_script}, mcp_tools=${byKind.mcp_tool})`
      );
      progress(`Auxiliary: ${merged.inserted} new, ${merged.updated} updated, ${merged.total} total`);
    } else {
      auxiliaryResult = { inserted: 0, updated: 0, total: 0, by_kind: byKind };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Auxiliary entity merge failed: ${msg}`);
    logger.warn(`scan_project: auxiliary merge error: ${msg}`);
  }

  // Phase 2.6 — native (parser-backed) data-model bridge. Augments
  // `data_model.json` with structs/classes/enums/etc. extracted by
  // tree-sitter so the seed file reflects evidenced types, not just
  // path-based heuristics. Non-fatal: bridge errors degrade scan_quality
  // but never block the rest of the scan.
  let scanQuality: ScanProjectResult["scan_quality"];
  if (targetList.includes("data_model")) {
    const aggregated: { parser_backed_files: number; total_native_files: number; native_diagnostics: number } = {
      parser_backed_files: 0,
      total_native_files: 0,
      native_diagnostics: 0,
    };
    for (const scan of scans) {
      if (!hasNativeCodeFiles(scan)) continue;
      try {
        progress(`Native scan (C/C++) — ${scan.repoName}…`);
        const { entries, quality } = await extractNativeDataModel(scan);
        aggregated.parser_backed_files += quality.parserBackedFiles;
        aggregated.total_native_files += quality.totalNativeFiles;
        aggregated.native_diagnostics += quality.diagnostics.length;
        if (entries.length > 0) {
          const existing = stripTemplateStubs(
            await loadJsonArray<Record<string, unknown>>("data_model.json"),
          );
          const merged = mergeById(existing, entries);
          await writeSeed("data_model.json", merged.merged);
          dataModelResult.inserted += merged.inserted;
          dataModelResult.updated += merged.updated;
          dataModelResult.total = merged.merged.length;
          logger.info(
            `scan_project: native data model — ${merged.inserted} inserted, ` +
            `${merged.updated} updated, ${entries.length} parser-backed entries ` +
            `(${quality.parserBackedFiles}/${quality.totalNativeFiles} files)`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Native data-model bridge failed for ${scan.repoName}: ${msg}`);
        logger.warn(`scan_project: native bridge error (${scan.repoName}): ${msg}`);
      }
    }
    if (aggregated.total_native_files > 0) {
      scanQuality = {
        parser_backed_files: aggregated.parser_backed_files,
        total_native_files: aggregated.total_native_files,
        parser_backed_pct: Math.round(
          (aggregated.parser_backed_files / aggregated.total_native_files) * 1000,
        ) / 10,
        native_diagnostics: aggregated.native_diagnostics,
      };
    }
  }

  // Phase 2.7 — UI scanner bridge (slice 2). Detects components in
  // .tsx/.jsx/.vue/.svelte/.razor/.xaml files and merges scanner-origin
  // SemanticElement entries into `ui_registry.json`. Manual / SDK
  // entries are preserved; enrichment fields on existing scanner-origin
  // entries are not erased on re-scan.
  let uiResult: ScanProjectResult["ui"] | undefined;
  if (targetList.includes("ui")) {
    const aggregatedUi = {
      inserted: 0,
      updated: 0,
      skipped_protected: 0,
      total_for_repo: 0,
      parsed_files: 0,
      total_ui_files: 0,
      diagnostics: 0,
    };
    for (const scan of scans) {
      if (!hasScannableUiFiles(scan)) continue;
      try {
        progress(`UI scan — ${scan.repoName}…`);
        const { elements, quality } = await extractNativeUiElements(scan);
        aggregatedUi.parsed_files += quality.parsedFiles;
        aggregatedUi.total_ui_files += quality.totalUiFiles;
        aggregatedUi.diagnostics += quality.diagnostics.length;
        const merge = await applyScannerUiElements(scan.repoName, elements);
        aggregatedUi.inserted += merge.inserted;
        aggregatedUi.updated += merge.updated;
        aggregatedUi.skipped_protected += merge.skipped_protected;
        aggregatedUi.total_for_repo += merge.total_for_repo;
        logger.info(
          `scan_project: ui scan — ${merge.inserted} inserted, ${merge.updated} updated, ` +
          `${merge.skipped_protected} protected (manual/sdk preserved) ` +
          `(${quality.parsedFiles}/${quality.totalUiFiles} files)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`UI scanner failed for ${scan.repoName}: ${msg}`);
        logger.warn(`scan_project: ui scanner error (${scan.repoName}): ${msg}`);
      }
    }
    if (aggregatedUi.total_ui_files > 0 || aggregatedUi.inserted + aggregatedUi.updated > 0) {
      uiResult = {
        inserted: aggregatedUi.inserted,
        updated: aggregatedUi.updated,
        skipped_protected: aggregatedUi.skipped_protected,
        total_for_repo: aggregatedUi.total_for_repo,
      };
      // Fold UI counters into scan_quality so the existing surface stays
      // a single source of truth for scanner coverage.
      scanQuality = {
        ...(scanQuality ?? {
          parser_backed_files: 0,
          total_native_files: 0,
          parser_backed_pct: 0,
          native_diagnostics: 0,
        }),
        ui_parsed_files: aggregatedUi.parsed_files,
        ui_total_files: aggregatedUi.total_ui_files,
        ui_diagnostics: aggregatedUi.diagnostics,
      };
    }
  }

  // Datastore sensing runs after code/UI discovery and before semantic
  // enrichment so table nodes participate in the same multi-hop pass.
  let datastoreScanResult: ScanProjectResult["datastore_scan"];
  if (config.database.connectionString || process.env.DATABASE_URL) {
    try {
      progress("Scanning configured PostgreSQL datastore…");
      await autoSeedPrimaryDatastore(config.repos);
      const scanned = await runDatastoreScan({ createMissing: true });
      if (scanned.success) {
        datastoreScanResult = {
          datastore_id: scanned.data.datastore_id,
          tables_found: scanned.data.tables_found,
          tables_kept: scanned.data.tables_kept,
          data_models_created: scanned.data.data_models_created,
          data_models_linked: scanned.data.data_models_linked,
        };
      } else {
        errors.push(`Datastore scan skipped: ${scanned.error.message}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Datastore scan failed: ${msg}`);
    }
  }

  // Mandatory graph-wide pass after every structural scanner. It covers all
  // canonical nodes, always traverses more than one semantic hop, and may use
  // either standalone or Architect LLM configuration.
  let semanticEnrichment: EnrichResult | undefined;
  try {
    progress("Enriching every graph node with multi-hop semantic context…");
    const enriched = await enrichParserNodesProgrammatic({
      target: "all",
      maxNodes: Number.MAX_SAFE_INTEGER,
      batchSize: Math.max(1, Math.min(20, Number(process.env.DREAMGRAPH_ENRICHMENT_BATCH_SIZE) || 12)),
      dryRun: false,
      force: true,
      contextHops: 3,
      relationContextSize: 40,
      modelSource: "auto",
      scheduleStabilization: false,
      onProgress: (message) => {
        // Keep the parent MCP request alive during the longest scan phase and
        // expose durable per-batch checkpoints to CLI/Architect callers.
        opts.onProgress?.(message, _step, _totalSteps);
      },
    });
    if (enriched.success) {
      semanticEnrichment = enriched.data;
      totalTokens += enriched.data.tokens_used;
      if (!enriched.data.semantic_coverage.complete) {
        errors.push(
          `Semantic enrichment incomplete: ${enriched.data.semantic_coverage.llm_enriched}/` +
          `${enriched.data.semantic_coverage.total_nodes} nodes received LLM knowledge; ` +
          `${enriched.data.semantic_coverage.fallback_nodes} used evidence-only fallback.`,
        );
      }
    } else {
      errors.push(`Semantic enrichment failed: ${enriched.error.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Semantic enrichment failed: ${msg}`);
  }
  const semanticComplete = semanticEnrichment?.semantic_coverage.complete === true;

  progress("Rebuilding resource index…");
  const indexEntries = await rebuildIndex();
  logger.info(`scan_project: index rebuilt with ${indexEntries} entries`);

  // Stamp the graph before the optional auto-dream phase. The dreamer also
  // enforces this gate, so a partial scan cannot silently become a cycle.
  try {
    await writeGraphManifest({ repos: config.repos });
  } catch (err) {
    errors.push(`Graph freshness stamp failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const changedNodeCount = featureResult.inserted + featureResult.updated +
    workflowResult.inserted + workflowResult.updated + dataModelResult.inserted + dataModelResult.updated +
    (uiResult?.inserted ?? 0) + (uiResult?.updated ?? 0) +
    (auxiliaryResult?.inserted ?? 0) + (auxiliaryResult?.updated ?? 0) +
    (datastoreScanResult?.data_models_created ?? 0) + (datastoreScanResult?.data_models_linked ?? 0);
  const majorGraphChangeThreshold = Math.max(1, Number(process.env.DREAMGRAPH_MAJOR_GRAPH_CHANGE_NODES) || 20);

  let dreamCycleResult: ScanProjectResult["dream_cycle"] | undefined;
  const totalSeeds = featureResult.total + workflowResult.total + dataModelResult.total;

  if (totalSeeds > 0 && semanticComplete) {
    try {
      progress("Phase 3 — dreaming (building graph from seed data)…");
      logger.info("scan_project: Phase 3 — auto-dream cycle");

      if (engine.getState() !== "awake") {
        await engine.interrupt();
      }

      engine.enterRem();
      await engine.applyCognitiveTuning();
      await engine.applyDecay();
      await engine.applyTensionDecay();

      const dreamResult = await dream("all", 80);

      dreamCycleResult = {
        edges_created: dreamResult.edges.length,
        nodes_created: dreamResult.nodes.length,
      };

      engine.enterNormalizing();
      const normResult = await normalize();
      dreamCycleResult.edges_validated = normResult.validated;
      dreamCycleResult.edges_promoted = normResult.promotedEdges.length;

      engine.wake();

      progress(
        `Dream cycle: ${dreamResult.edges.length} edges, ${dreamResult.nodes.length} nodes, ` +
        `${normResult.promotedEdges.length} promoted`
      );
      logger.info(
        `scan_project: auto-dream complete — ${dreamResult.edges.length} edges, ` +
        `${dreamResult.nodes.length} nodes, ${normResult.promotedEdges.length} promoted`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Auto-dream cycle failed: ${msg}`);
      logger.warn(`scan_project: auto-dream error: ${msg}`);
      try { await engine.interrupt(); } catch { /* best effort */ }
    }
  } else if (totalSeeds > 0 && !semanticComplete) {
    errors.push("Auto-dream skipped because mandatory per-node semantic enrichment is incomplete. Configure an LLM and run re-enrichment.");
  } else if (totalSeeds > 0) {
    errors.push(
      "Graph is empty — no LLM available for dream cycle. " +
      "Run dream_cycle manually after configuring an LLM provider."
    );
  }

  let adrsRecorded = 0;
  const hasRealSeeds = featureResult.total > 0 || workflowResult.total > 0 || dataModelResult.total > 0;

  if (hasRealSeeds && semanticComplete) {
    try {
      const repoName = Object.keys(config.repos)[0] ?? "project";
      progress("Phase 4 — discovering architecture decisions…");
      logger.info("scan_project: Phase 4 — ADR discovery");
      adrsRecorded = await discoverAndRecordADRs(repoName);
      if (adrsRecorded > 0) {
        progress(`ADR discovery: ${adrsRecorded} decisions recorded`);
        logger.info(`scan_project: ADR discovery complete — ${adrsRecorded} ADRs recorded`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`ADR discovery failed: ${msg}`);
      logger.warn(`scan_project: ADR discovery error: ${msg}`);
    }
  }

  let targetedDreamSchedules: ScanProjectResult["targeted_dream_schedules"];
  if (hasRealSeeds && semanticComplete && changedNodeCount >= majorGraphChangeThreshold) {
    try {
      progress("Phase 5 — scheduling targeted graph-stabilization dreams…");
      logger.info("scan_project: Phase 5 — scheduling targeted dreams for major graph changes");
      const scheduled = await scheduleTargetedDreamStabilization({
        entity_ids: semanticEnrichment?.enriched_node_ids ?? [],
        reason: `Major scan changed ${changedNodeCount} canonical nodes` +
          (datastoreScanResult ? ` and refreshed datastore ${datastoreScanResult.datastore_id}` : ""),
        max_runs: 3,
      });
      targetedDreamSchedules = {
        created: scheduled.scheduled.length,
        reused: scheduled.reused.length,
        schedule_ids: [...scheduled.scheduled, ...scheduled.reused].map((schedule) => schedule.id),
        focus_entities: scheduled.focus_entities,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Targeted dream scheduling failed: ${msg}`);
      logger.warn(`scan_project: targeted dream scheduling error: ${msg}`);
    }
  }

  // v8.2.7 — graph-integrity self-healing. Scanner writes go through writeSeed
  // (not executeEnrichSeedData) so the per-write backlink hook does not fire.
  // Run a single symmetrization pass at the end so newly created entities have
  // reciprocal links. Best-effort, fire-and-forget.
  if (hasRealSeeds) {
    try {
      const { applyBidirectionalBacklinks } = await import("./graph-integrity.js");
      const bl = await applyBidirectionalBacklinks();
      if (bl.entities_needing_backlinks > 0) {
        logger.info(
          `scan_project: post-scan backlinks added reciprocals on ${bl.entities_needing_backlinks} entities`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Post-scan backlink pass failed: ${msg}`);
      logger.warn(`scan_project: backlink hook error: ${msg}`);
    }
  }

  // Auto-dreaming may promote entities into the seed graph; refresh the stamp
  // after all scanner and integrity writes have settled.
  try {
    await writeGraphManifest({ repos: config.repos });
  } catch (err) {
    errors.push(`Final graph freshness stamp failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const dreamSummary = dreamCycleResult
    ? ` Dream: ${dreamCycleResult.edges_created} edges, ${dreamCycleResult.nodes_created} nodes, ${dreamCycleResult.edges_promoted ?? 0} promoted.`
    : "";
  const adrSummary = adrsRecorded > 0 ? ` ADRs: ${adrsRecorded} discovered.` : "";
  const partialSummary = partialModeUsed && !semanticComplete ? " Adaptive partial scan mode preserved evidence for later enrichment." : "";
  const auxSummary = auxiliaryResult && auxiliaryResult.total > 0
    ? ` Auxiliary: ${auxiliaryResult.inserted} new / ${auxiliaryResult.total} total ` +
      `(tests=${auxiliaryResult.by_kind.test_suite}, config=${auxiliaryResult.by_kind.configuration}, ` +
      `scripts=${auxiliaryResult.by_kind.automation_script}, mcp_tools=${auxiliaryResult.by_kind.mcp_tool}).`
    : "";
  const qualitySummary = scanQuality
    ? ` Native scan: ${scanQuality.parser_backed_files}/${scanQuality.total_native_files} ` +
      `C/C++ files parsed (${scanQuality.parser_backed_pct}%).`
    : "";
  const targetedDreamSummary = targetedDreamSchedules
    ? ` Targeted stabilization: ${targetedDreamSchedules.created} schedule(s) created, ${targetedDreamSchedules.reused} reused for ${targetedDreamSchedules.focus_entities.length} nodes.`
    : "";

  const scanCompletedAt = new Date().toISOString();
  let committedScanRevision: string | null = null;
  try {
    const prior = await loadScanState();
    const selectedRepos = Object.fromEntries(targetRepos.map((name) => [name, config.repos[name]]));
    const scanState = await buildScanState({
      repos: selectedRepos,
      depth,
      targets: targetList as ScanTarget[],
      operation: "full",
      previous: prior.state,
    });
    let fullLedger: StructuralEvidenceLedger | undefined;
    const fullSpecs = [
      { target: "features" as const, file: "features.json" },
      { target: "workflows" as const, file: "workflows.json" },
      { target: "data_model" as const, file: "data_model.json" },
    ];
    for (const spec of fullSpecs) {
      if (!targetList.includes(spec.target)) continue;
      const entities = stripTemplateStubs(await loadJsonArray<Record<string, unknown>>(spec.file));
      const incoming = entities.flatMap((entity) => {
        const repo = typeof entity.source_repo === "string" ? entity.source_repo : "";
        const snapshot = scanState.repos[repo];
        if (!snapshot) return [];
        return [{
          repo, target: spec.target, kind: spec.target, entity,
          file_hashes: Object.fromEntries(Object.entries(snapshot.files).map(([file, evidence]) => [file, evidence.content_hash])),
        }];
      });
      fullLedger = reconcileAddedModifiedEntities({
        existing: [], incoming, previous_ledger: fullLedger, revision: scanState.committed_revision,
      }).ledger;
    }
    scanState.evidence_ledger = fullLedger;
    const canonical: Array<{ target: string; entity: Record<string, unknown> }> = [];
    for (const spec of fullSpecs) {
      const entities = stripTemplateStubs(await loadJsonArray<Record<string, unknown>>(spec.file));
      canonical.push(...entities.map((entity) => ({ target: spec.target, entity })));
    }
    const uiElements = await loadIndexableUIElements();
    canonical.push(...uiElements.map((entity) => ({ target: "ui", entity: entity as unknown as Record<string, unknown> })));
    const auxiliary = await loadAuxiliaryEntities();
    canonical.push(...auxiliary.entries.map((entity) => ({ target: "auxiliary", entity: entity as unknown as Record<string, unknown> })));
    scanState.coverage_ledger = buildCoverageLedger(scanState, canonical);
    const coverageErrors = validateCoverageLedger(scanState.coverage_ledger);
    if (coverageErrors.length > 0) {
      throw new Error(`SCAN_COVERAGE_INVALID: ${coverageErrors.join("; ")}`);
    }
    await commitScanState(scanState);
    committedScanRevision = scanState.committed_revision;
  } catch (err) {
    errors.push(`Scan-state baseline commit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  await updateGraphMaintenanceState({
    last_scan_at: scanCompletedAt,
    current_scan_state_revision: committedScanRevision,
    last_scan_git_heads: await captureRepositoryGitHeads(config.repos),
    datastore_connection_fingerprint: datastoreConnectionFingerprint(config.database.connectionString || process.env.DATABASE_URL),
    ...(changedNodeCount >= majorGraphChangeThreshold ? { last_major_graph_change_at: scanCompletedAt } : {}),
  }).catch((err) => errors.push(`Graph maintenance state update failed: ${err instanceof Error ? err.message : String(err)}`));

  const summary =
    `Scan complete: ${scans.length} repo(s), ${totalFiles} files. ` +
    `${semanticComplete ? `LLM enrichment complete (${semanticEnrichment?.semantic_coverage.llm_enriched ?? 0} nodes, ${totalTokens} tokens)` : "Semantic enrichment incomplete"}. ` +
    `Features: ${featureResult.inserted} new / ${featureResult.total} total. ` +
    `Workflows: ${workflowResult.inserted} new / ${workflowResult.total} total. ` +
    `Data model: ${dataModelResult.inserted} new / ${dataModelResult.total} total. ` +
    `Index: ${indexEntries} entries.` +
    auxSummary +
    qualitySummary +
    partialSummary +
    dreamSummary +
    targetedDreamSummary +
    adrSummary +
    (errors.length > 0 ? ` ${errors.length} warning(s).` : "");

  logger.info(`scan_project: ${summary}`);

  return {
    repos_scanned: scans.length,
    files_discovered: totalFiles,
    ui_files_detected: totalUiFiles,
    technology: techSummary,
    llm_used: (semanticEnrichment?.semantic_coverage.llm_enriched ?? 0) > 0,
    features: featureResult,
    workflows: workflowResult,
    data_model: dataModelResult,
    ui: uiResult,
    scan_quality: scanQuality,
    auxiliary: auxiliaryResult,
    datastore_scan: datastoreScanResult,
    semantic_enrichment: semanticEnrichment,
    index_entries: indexEntries,
    llm_tokens_used: totalTokens,
    dream_cycle: dreamCycleResult,
    targeted_dream_schedules: targetedDreamSchedules,
    errors,
    message: summary,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerScanProjectTool(server: McpServer): void {
  server.tool(
    "scan_project",
    "Scan the project and populate the knowledge graph with features, workflows, and data model entities. " +
    "Full scans preserve mandatory graph-wide enrichment; incremental scans reconcile evidence with zero LLM calls unless enrich=true. " +
    "using source evidence and at least two semantic graph hops. UI contracts, appearance, " +
    "layout, datastore tables, and cross-node relations are included. " +
    "Use this for quick initial enrichment — you can always refine with " +
    "enrich_seed_data and register_ui_element afterward. " +
    "If no standalone or Architect model is available, incomplete semantic coverage is reported explicitly.",
    {
      depth: z
        .enum(["shallow", "deep"])
        .default("deep")
        .describe(
          "shallow: scan top 3 directory levels only (faster, may miss nested modules). " +
          "deep: scan up to 10 levels (thorough, recommended for first scan).",
        ),
      targets: z
        .array(z.string())
        .optional()
        .describe(
          "Which seed data targets to populate. Default: all four. " +
          "Each must be one of: features, workflows, data_model, ui. " +
          "Use to selectively re-scan only a subset. The 'ui' target runs the " +
          "native UI scanner (slice 2) over .tsx/.jsx/.vue/.svelte/.razor/.xaml " +
          "files and merges scanner-origin entries into ui_registry.json without " +
          "overwriting manual or plugin-authored elements.",
        ),
      repos: z
        .array(z.string())
        .optional()
        .describe(
          "Specific repo names to scan. Default: all configured repos.",
        ),
      mode: z.enum(["full", "incremental"]).default("full").describe("full preserves existing behavior; incremental reconciles a compatible committed evidence baseline."),
      dry_run: z.boolean().default(false).describe("Preview the incremental delta without parser, LLM, or graph writes."),
      enrich: z.boolean().default(false).describe("Incremental only: explicitly run semantic enrichment after structural reconciliation. Default false."),
    },
    async ({ depth, targets, repos, mode, dry_run, enrich }, extra) => {
      const VALID_TARGETS = ["features", "workflows", "data_model", "ui"];
      const targetList = targets ?? [...VALID_TARGETS];

      // Validate targets up-front (before delegating to core)
      const invalidTargets = targetList.filter(t => !VALID_TARGETS.includes(t));
      if (invalidTargets.length > 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              error: `Invalid target(s): ${invalidTargets.join(", ")}. Must be one of: ${VALID_TARGETS.join(", ")}`,
            }),
          }],
        };
      }

      logger.info(`scan_project: starting (depth=${depth}, targets=${targetList.join(",")}, repos=${repos?.join(",") ?? "all"})`);

      // MCP progress callback — sends both progress token and logging notifications
      const onProgress = (message: string, step: number, total: number): void => {
        // Try progress notification (token-routed)
        extra.sendNotification({
          method: "notifications/progress" as const,
          params: {
            progressToken: (extra._meta as Record<string, unknown>)?.progressToken as string | number ?? "scan",
            progress: step,
            total,
            message,
          },
        }).catch(() => {});
        // Also send a logging message (always delivered)
        extra.sendNotification({
          method: "notifications/message" as const,
          params: {
            level: "info",
            logger: "scan_project",
            data: `[${step}/${total}] ${message}`,
          },
        }).catch(() => {});
      };

      const result = await safeExecute<ScanProjectResult>(async (): Promise<ToolResponse<ScanProjectResult>> => {
        try {
          const scanResult = await runScanProject({ depth, targets: targetList, repos, mode, dry_run, enrich, onProgress });
          return success<ScanProjectResult>(scanResult);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return error("SCAN_FAILED", msg);
        }
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}

// Structural fallback generators (toSnakeCase / toTitleCase / inferDomain /
// generateStructuralFeatures / generateStructuralWorkflows / generateStructuralDataModel)
// have moved to ./structural-generators.js
