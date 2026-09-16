/**
 * DreamGraph MCP Server — init_graph tool.
 *
 * Bootstraps the fact graph (seed data files) by scanning the configured
 * project repositories.  Without this, new instances start with empty
 * `features.json`, `workflows.json`, `data_model.json`, `index.json`,
 * and `system_overview.json` — leaving the dreamer with nothing to
 * dream about and the normalizer unable to ground any edges.
 *
 * The tool:
 *   1. Walks each repo in config.repos to discover source files.
 *   2. Classifies files into features, workflows, data-model entities.
 *   3. Generates seed data conforming to the TypeScript interfaces.
 *   4. Writes all seed files + builds the resource index.
 *   5. Invalidates the cache so subsequent reads see fresh data.
 *
 * Protection bypass: This tool writes directly to seed_data tier files.
 * It is the ONLY tool allowed to do so — it is the bootstrap mechanism.
 *
 * See ADR-012: Fact Graph Bootstrap via init_graph.
 */

import fs from "node:fs/promises";
import { atomicWriteFile } from "../utils/atomic-write.js";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config/config.js";
import { dataPath } from "../utils/paths.js";
import { invalidateCache } from "../utils/cache.js";
import { success, error, safeExecute } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { getLlmConfig } from "../cognitive/llm.js";
import { writeGraphManifest } from "../cognitive/cycle-input-gate.js";
import { shouldSkipScanDirectory } from "./scanner-artifact-policy.js";
import type {
  Feature,
  Workflow,
  DataModelEntity,
  SystemOverview,
  Repository,
  ResourceIndex,
  IndexEntry,
  GraphLink,
  WorkflowStep,
  EntityField,
  ToolResponse,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Heuristic classification patterns
// ---------------------------------------------------------------------------

/** File extensions we scan for structural analysis */
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".cs",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
  ".vue", ".svelte",
]);

/** Directories to skip during scan */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next",
  "__pycache__", ".venv", "venv", "target", "coverage",
  ".turbo", ".cache", ".parcel-cache",
]);

/**
 * Path evidence patterns used only as conservative fallback signals.
 * These are intentionally narrow: broad framework terms such as route,
 * controller, hook, command, prisma, sql, etc. are not enough to create graph
 * nodes because DreamGraph must be language, platform, datastore, and structure
 * agnostic. Prefer content evidence below whenever available.
 */
const WORKFLOW_PATTERNS = [
  /(^|[/\\_-])(workflow|workflows|flow|flows|process|processes)([/\\_-]|$)/i,
];

/** Conservative path evidence for data structures; never implies storage. */
const DATA_MODEL_PATTERNS = [
  /(^|[/\\_-])(model|models|schema|schemas|entity|entities|type|types|interface|interfaces|contract|contracts|dto|dtos)([/\\_-]|$)/i,
];

/**
 * Content patterns for deeper classification.
 * Workflow hints are behavioral: ordered/causal actions, events, decisions, or
 * state transitions. They intentionally do not treat web routes, controllers,
 * background jobs, queues, CI/CD, or other technologies as workflows by
 * themselves.
 */
const CONTENT_HINTS = {
  workflow: [
    /\b(workflow|flow|sequence|step|transition|state\s*machine|lifecycle)\b/i,
    /\b(cause|causal|trigger|event|action|decision|effect|advance|enable|then|next)\b/i,
  ],
  dataModel: [
    /CREATE\s+TABLE/i,
    /interface\s+\w+(Row|Record|Entity|Model|Schema)\b/i,
    /export\s+(type|interface)\s+\w+\s*(=\s*{|{)/i,
    /pgTable|sqliteTable|mysqlTable/i,
    /Schema\.define|sequelize\.define/i,
    /class\s+\w+\s+extends\s+Model/i,
    /@Entity|@Table|@Column/i,
    /prisma\s+model\b/i,
    /class\s+\w+\(models\.Model\)/i,
  ],
  feature: [
    /export\s+(class|function|const)\s+\w+/i,
    /module\.exports/i,
    /export\s+default/i,
  ],
};

// ---------------------------------------------------------------------------
// Source file representation
// ---------------------------------------------------------------------------

interface SourceFile {
  /** Absolute path */
  abs: string;
  /** Relative path within repo */
  rel: string;
  /** Just the filename */
  name: string;
  /** File extension with dot */
  ext: string;
  /** Repo name */
  repo: string;
  /** Directory components */
  dirParts: string[];
}

interface ScanResult {
  files: SourceFile[];
  repoRoot: string;
  repoName: string;
  technology: string;
}

// ---------------------------------------------------------------------------
// Technology detection
// ---------------------------------------------------------------------------

async function detectTechnology(repoRoot: string): Promise<string> {
  const techs: string[] = [];

  try {
    const entries = await fs.readdir(repoRoot);
    const names = new Set(entries);

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
        else if (deps?.hono) techs.push("Hono");
        techs.push("Node.js");
      } catch { /* ignore */ }
    }
    if (names.has("requirements.txt") || names.has("pyproject.toml") || names.has("setup.py")) {
      techs.push("Python");
    }
    if (names.has("Cargo.toml")) techs.push("Rust");
    if (names.has("go.mod")) techs.push("Go");
    if (names.has("Gemfile")) techs.push("Ruby");
    if (names.has("pom.xml") || names.has("build.gradle")) techs.push("Java");
    if (names.has("*.csproj") || entries.some(e => e.endsWith(".csproj"))) techs.push("C#/.NET");

  } catch { /* ignore */ }

  return techs.length > 0 ? techs.join("/") : "Unknown";
}

// ---------------------------------------------------------------------------
// Recursive file scanner
// ---------------------------------------------------------------------------

async function scanRepo(repoName: string, repoRoot: string): Promise<ScanResult> {
  const files: SourceFile[] = [];
  const technology = await detectTechnology(repoRoot);

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name.startsWith(".") ||
          shouldSkipScanDirectory({
            repoRoot,
            absDir: entryPath,
            entryName: entry.name,
          })
        ) {
          continue;
        }
        await walk(entryPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          const abs = entryPath;
          const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
          files.push({
            abs,
            rel,
            name: entry.name,
            ext,
            repo: repoName,
            dirParts: path.dirname(rel).split("/").filter(Boolean),
          });
        }
      }
    }
  }

  await walk(repoRoot);
  return { files, repoRoot, repoName: repoName, technology };
}

// ---------------------------------------------------------------------------
// Classify files into groups
// ---------------------------------------------------------------------------

interface FileGroup {
  id: string;
  name: string;
  type: "feature" | "workflow" | "data_model";
  files: SourceFile[];
  domain: string;
  keywords: string[];
  description: string;
}

function toSnakeCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

function toTitleCase(str: string): string {
  return str
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function inferDomain(dirParts: string[]): string {
  /**
   * Domain labels are descriptive metadata only. Keep them evidence-derived from
   * explicitly meaningful project vocabulary and avoid mapping generic
   * architecture/framework/storage directory names (api, routes, controller,
   * db, database, middleware, etc.) into project semantics.
   */
  const domainHints: Record<string, string> = {
    auth: "authentication", login: "authentication", session: "authentication",
    billing: "billing", payment: "billing", invoice: "billing",
    user: "user_management", account: "user_management", profile: "user_management",
    admin: "administration", report: "reporting", analytics: "analytics",
    search: "search", notification: "notification", email: "notification",
    import: "import_export", export: "import_export",
  };

  for (const part of dirParts) {
    const normalized = part.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (domainHints[normalized]) return domainHints[normalized];
  }
  return "core";
}

function extractKeywords(files: SourceFile[]): string[] {
  const kw = new Set<string>();
  for (const f of files) {
    // directory names as keywords
    for (const d of f.dirParts) {
      if (d.length > 2) kw.add(d.toLowerCase());
    }
    // filename without extension
    const base = path.basename(f.name, f.ext);
    if (base.length > 2 && base !== "index") {
      kw.add(base.toLowerCase().replace(/[-_]/g, " "));
    }
  }
  return [...kw].slice(0, 15);
}

async function classifyFile(file: SourceFile): Promise<"workflow" | "data_model" | "feature"> {
  const relLower = file.rel.toLowerCase();

  // Content evidence is primary. Path evidence is only a conservative fallback.
  try {
    const fd = await fs.open(file.abs, "r");
    const buf = Buffer.alloc(4096);
    await fd.read(buf, 0, 4096, 0);
    await fd.close();
    const content = buf.toString("utf-8");

    for (const pat of CONTENT_HINTS.dataModel) {
      if (pat.test(content)) return "data_model";
    }
    for (const pat of CONTENT_HINTS.workflow) {
      if (pat.test(content)) return "workflow";
    }
  } catch { /* ignore */ }

  // Fallback: only explicit self-describing names count. Do not infer workflow,
  // datastore, or architectural roles from common framework directory shapes.
  for (const pat of WORKFLOW_PATTERNS) {
    if (pat.test(relLower)) return "workflow";
  }
  for (const pat of DATA_MODEL_PATTERNS) {
    if (pat.test(relLower)) return "data_model";
  }

  return "feature";
}

async function groupFiles(scan: ScanResult): Promise<FileGroup[]> {
  const groups = new Map<string, FileGroup>();

  for (const file of scan.files) {
    const classification = await classifyFile(file);

    // Group by parent directory + classification
    const parentDir = file.dirParts.length > 0
      ? file.dirParts.join("/")
      : path.basename(file.name, file.ext);

    const groupKey = `${classification}:${scan.repoName}:${parentDir}`;

    let group = groups.get(groupKey);
    if (!group) {
      const dirName = file.dirParts.length > 0
        ? file.dirParts[file.dirParts.length - 1]
        : path.basename(file.name, file.ext);

      group = {
        id: toSnakeCase(`${scan.repoName}_${parentDir}`),
        name: toTitleCase(dirName),
        type: classification,
        files: [],
        domain: inferDomain(file.dirParts),
        keywords: [],
        description: "",
      };
      groups.set(groupKey, group);
    }
    group.files.push(file);
  }

  // Finalize groups
  for (const group of groups.values()) {
    group.keywords = extractKeywords(group.files);
    const fileList = group.files.map(f => f.rel).join(", ");
    group.description = `${group.name} — ${group.files.length} source file(s): ${fileList}`;

    // Truncate description if too long
    if (group.description.length > 500) {
      group.description = group.description.slice(0, 497) + "...";
    }
  }

  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Generate typed seed data from groups
// ---------------------------------------------------------------------------

function generateFeatures(groups: FileGroup[], repoName: string): Feature[] {
  return groups
    .filter(g => g.type === "feature")
    .map(g => ({
      id: g.id,
      name: g.name,
      description: g.description,
      source_repo: repoName,
      source_files: g.files.map(f => f.rel),
      status: "active",
      category: g.domain,
      tags: [g.domain, ...g.files.map(f => f.ext.replace(".", ""))].filter((v, i, a) => a.indexOf(v) === i),
      domain: g.domain,
      keywords: g.keywords,
      links: [] as GraphLink[],
    }));
}

function generateWorkflows(groups: FileGroup[], repoName: string): Workflow[] {
  return groups
    .filter(g => g.type === "workflow")
    .map(g => ({
      id: g.id,
      name: `${g.name} Flow`,
      description: g.description,
      trigger: `Source: ${g.files[0]?.rel ?? "unknown"}`,
      source_repo: repoName,
      source_files: g.files.map(f => f.rel),
      domain: g.domain,
      keywords: g.keywords,
      status: "active",
      steps: g.files.map((f, i) => ({
        order: i + 1,
        name: path.basename(f.name, f.ext),
        description: `Implemented in ${f.rel}`,
      })) as WorkflowStep[],
      links: [] as GraphLink[],
    }));
}

function generateDataModel(groups: FileGroup[], repoName: string): DataModelEntity[] {
  return groups
    .filter(g => g.type === "data_model")
    .map(g => ({
      id: g.id,
      name: g.name,
      description: `${g.description} Storage/table information is omitted unless direct source evidence is discovered.`,
      source_repo: repoName,
      source_files: g.files.map(f => f.rel),
      domain: g.domain,
      keywords: g.keywords,
      status: "active",
      key_fields: [] as EntityField[],
      relationships: [],
      links: [] as GraphLink[],
    }));
}

function generateSystemOverview(
  scans: ScanResult[],
  featureCount: number,
  workflowCount: number,
  dataModelCount: number,
): SystemOverview {
  return {
    id: "system_overview",
    name: "System Overview",
    description: `Project with ${scans.length} repositories, ${featureCount} features, ${workflowCount} workflows, ${dataModelCount} data model entities. Auto-generated by init_graph.`,
    source_repo: scans[0]?.repoName ?? "",
    source_files: [],
    repositories: scans.map(s => ({
      id: s.repoName,
      name: toTitleCase(s.repoName),
      description: `${s.technology} project with ${s.files.length} source files`,
      technology: s.technology,
      local_path: s.repoRoot,
      source_repo: s.repoName,
      source_files: s.files.slice(0, 5).map(f => f.rel),
    })) as Repository[],
  };
}

function generateIndex(
  features: Feature[],
  workflows: Workflow[],
  dataModel: DataModelEntity[],
): ResourceIndex {
  const entities: Record<string, IndexEntry> = {};

  for (const f of features) {
    entities[f.id] = {
      type: "feature",
      uri: `dreamgraph://resource/feature/${f.id}`,
      name: f.name,
      source_repo: f.source_repo,
    };
  }
  for (const w of workflows) {
    entities[w.id] = {
      type: "workflow",
      uri: `dreamgraph://resource/workflow/${w.id}`,
      name: w.name,
      source_repo: w.source_repo,
    };
  }
  for (const d of dataModel) {
    entities[d.id] = {
      type: "data_model",
      uri: `dreamgraph://resource/data_model/${d.id}`,
      name: d.name,
      source_repo: d.source_repo,
    };
  }

  return { entities };
}

/**
 * Cross-link features ↔ workflows ↔ data_model by shared domain/keywords.
 */
function crossLink(
  features: Feature[],
  workflows: Workflow[],
  dataModel: DataModelEntity[],
): void {
  // Build a domain → entity map for linking
  type Entity = { id: string; type: "feature" | "workflow" | "data_model"; domain: string; keywords: string[] };
  const all: Entity[] = [
    ...features.map(f => ({ id: f.id, type: "feature" as const, domain: f.domain, keywords: f.keywords })),
    ...workflows.map(w => ({ id: w.id, type: "workflow" as const, domain: w.domain, keywords: w.keywords })),
    ...dataModel.map(d => ({ id: d.id, type: "data_model" as const, domain: d.domain, keywords: d.keywords })),
  ];

  // For each pair sharing a domain, create moderate-strength links
  for (const a of all) {
    for (const b of all) {
      if (a.id === b.id) continue;
      if (a.domain === b.domain && a.domain !== "core") {
        // Check keyword overlap for strength
        const overlap = a.keywords.filter(k => b.keywords.includes(k));
        if (overlap.length === 0) continue;

        const strength = overlap.length >= 3 ? "strong" as const : overlap.length >= 1 ? "moderate" as const : "weak" as const;

        const link: GraphLink = {
          target: b.id,
          type: b.type,
          relationship: "related_to",
          description: `Shared domain '${a.domain}' with ${overlap.length} keyword overlap(s)`,
          strength,
        };

        // Add to the correct entity (max 15 links per entity to avoid bloat)
        const entity = features.find(f => f.id === a.id)
          ?? workflows.find(w => w.id === a.id)
          ?? dataModel.find(d => d.id === a.id);

        if (entity && entity.links.length < 15 && !entity.links.some(l => l.target === b.id)) {
          entity.links.push(link);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

interface InitGraphResult {
  repos_scanned: number;
  files_scanned: number;
  features_generated: number;
  workflows_generated: number;
  data_model_entities_generated: number;
  index_entries: number;
  cross_links_created: number;
  files_written: string[];
  message: string;
}

// ---------------------------------------------------------------------------
// Write seed files (bypasses protection — this IS the bootstrap)
// ---------------------------------------------------------------------------

async function writeSeedFile(filename: string, data: unknown): Promise<void> {
  const filePath = dataPath(filename);
  await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
  invalidateCache(filename);
  logger.info(`init_graph: wrote ${filename} (${JSON.stringify(data).length} bytes)`);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerInitGraphTool(server: McpServer): void {
  server.tool(
    "init_graph",
    "Bootstrap the fact graph by scanning configured project repositories. This discovers features, behavioral workflows, and information-structure data models only from project evidence and populates the seed data files (features.json, workflows.json, data_model.json, system_overview.json, index.json). Run this ONCE for a new project, or when the fact graph is empty and only the project directory/config are known. The tool reads source files, classifies them from cited source evidence rather than assumed language, framework, architecture, or datastore conventions, generates evidence-bound cross-links, and writes all seed files.",
    {
      repos: z.array(z.string()).optional().describe("Specific repo names to scan (from DREAMGRAPH_REPOS config). If omitted, scans ALL configured repos."),
      force: z.boolean().optional().describe("If true, overwrites existing seed data. If false (default), skips if features.json already has real entries."),
    },
    async ({ repos: requestedRepos, force = false }) => {
      logger.debug(`init_graph called repos=${JSON.stringify(requestedRepos ?? null)} force=${String(force)}`);

      const configuredRepos = Object.entries(config.repos).map(([name, local_path]) => ({ name, local_path }));
      const availableRepos = configuredRepos.map((repoConfig) => repoConfig.name);

      const result = await safeExecute<InitGraphResult>(async () => {
        try {
          // Safety: avoid overwriting a live graph unless explicitly forced
          const featuresFile = dataPath("features.json");
          if (!force) {
            try {
              const existing = JSON.parse(await fs.readFile(featuresFile, "utf-8")) as Feature[];
              const hasRealEntries = Array.isArray(existing) && existing.some((feature) => !feature.id.startsWith("feature-template-"));
              if (hasRealEntries) {
                return error(
                  "INVALID_INPUT",
                  "features.json already contains entries. Use force=true to overwrite existing seed data."
                );
              }
            } catch {
              // Missing or unreadable file is fine — we are bootstrapping.
            }
          }

          // Resolve repos
          const repoConfigs = requestedRepos && requestedRepos.length > 0
            ? configuredRepos.filter((repoConfig) => requestedRepos.includes(repoConfig.name))
            : configuredRepos;

          if (requestedRepos && requestedRepos.length > 0 && repoConfigs.length !== requestedRepos.length) {
            const missing = requestedRepos.filter((repoName) => !repoConfigs.some((repoConfig) => repoConfig.name === repoName));
            return error(
              "NOT_FOUND",
              `Unknown repos: ${missing.join(", ")}. Available: ${availableRepos.join(", ")}`
            );
          }

          if (repoConfigs.length === 0) {
            return error(
              "NOT_FOUND",
              `No configured repositories to scan. Available: ${availableRepos.join(", ") || "none"}`
            );
          }

          const scans: Array<{
            repository: Repository;
            fileCount: number;
            features: Feature[];
            workflows: Workflow[];
            dataModel: DataModelEntity[];
          }> = await Promise.all(repoConfigs.map(async (repoConfig: { name: string; local_path: string }) => {
            const repoRoot = path.resolve(repoConfig.local_path);
            const scan = await scanRepo(repoConfig.name, repoRoot);
            logger.info(`init_graph: scanning repo ${repoConfig.name} (${scan.files.length} files)`);

            const groups = await groupFiles(scan);
            const features = generateFeatures(groups, repoConfig.name);
            const workflows = generateWorkflows(groups, repoConfig.name);
            const dataModel = generateDataModel(groups, repoConfig.name);

            const repository: Repository = {
              id: `repository_${toSnakeCase(repoConfig.name)}`,
              name: repoConfig.name,
              description: `Repository ${repoConfig.name} scanned by init_graph.`,
              technology: scan.technology,
              local_path: repoConfig.local_path,
              source_repo: repoConfig.name,
              source_files: scan.files.map((file) => file.rel),
            };

            return {
              repository,
              fileCount: scan.files.length,
              features,
              workflows,
              dataModel,
            };
          }));

          const allFeatures = scans.flatMap((scan) => scan.features);
          const allWorkflows = scans.flatMap((scan) => scan.workflows);
          const allDataModel = scans.flatMap((scan) => scan.dataModel);
          const repositories = scans.map((scan) => scan.repository);
          const totalFiles = scans.reduce((sum, scan) => sum + scan.fileCount, 0);

          const overview: SystemOverview = {
            id: "system-overview",
            name: "System Overview",
            description: "High-level map of configured repositories, generated from discovered project files by init_graph.",
            source_repo: repositories[0]?.source_repo ?? "",
            source_files: repositories.map((repository) => repository.local_path),
            repositories,
          };

          const index: ResourceIndex = { entities: {} };
          const addIndexEntry = (entry: IndexEntry, id: string) => {
            index.entities[id] = entry;
          };

          for (const feature of allFeatures) {
            addIndexEntry({
              type: "feature",
              uri: `feature://${feature.id}`,
              name: feature.name,
              source_repo: feature.source_repo,
            }, feature.id);
          }

          for (const workflow of allWorkflows) {
            addIndexEntry({
              type: "workflow",
              uri: `workflow://${workflow.id}`,
              name: workflow.name,
              source_repo: workflow.source_repo,
            }, workflow.id);
          }

          for (const entity of allDataModel) {
            addIndexEntry({
              type: "data_model",
              uri: `data-model://${entity.id}`,
              name: entity.name,
              source_repo: entity.source_repo,
            }, entity.id);
          }

          addIndexEntry({
            type: "feature",
            uri: "system://overview",
            name: overview.name,
            source_repo: overview.source_repo,
          }, overview.id);

          const linkCount = [allFeatures, allWorkflows, allDataModel]
            .flat()
            .reduce((sum, item) => sum + (item.links?.length ?? 0), 0);

          await writeSeedFile("features.json", allFeatures);
          await writeSeedFile("workflows.json", allWorkflows);
          await writeSeedFile("data_model.json", allDataModel);
          await writeSeedFile("system_overview.json", overview);
          await writeSeedFile("index.json", index);
          await writeGraphManifest({
            repos: Object.fromEntries(repoConfigs.map((repoConfig) => [repoConfig.name, repoConfig.local_path])),
          });
          const writtenFiles = ["features.json", "workflows.json", "data_model.json", "system_overview.json", "index.json", "graph_manifest.json"];

          const summary = `Bootstrapped graph from ${repoConfigs.length} repo(s), ${totalFiles} file(s): ${allFeatures.length} features, ${allWorkflows.length} workflows, ${allDataModel.length} data model entities, ${linkCount} cross-links.`;

          // Check LLM readiness and add guidance if not configured
          let llmAdvice = "";
          try {
            const llmCfg = getLlmConfig();
            if (llmCfg.provider === "none" || !llmCfg.provider) {
              llmAdvice =
                "\n\nNEXT STEP: Configure an LLM model to unlock full dreaming and semantic validation. " +
                "Without LLM, DreamGraph uses structural heuristics only (8 strategies). " +
                "With LLM, the dreamer generates creative connections and the normalizer validates them semantically. " +
                "Configure via: (1) Dashboard /config page > LLM section, or " +
                "(2) Edit engine.env in the instance config directory. " +
                "Recommended: Set DREAMGRAPH_LLM_PROVIDER=ollama with a local model for autonomous dreaming, " +
                "or DREAMGRAPH_LLM_PROVIDER=openai/anthropic with an API key. " +
                "The normalizer uses low temperature (0.1) by default for consistent validation.";
            }
          } catch {
            /* LLM module not loaded yet — skip advice */
          }

          // v8.2.7 — graph-integrity self-healing. init_graph writes seed files
          // directly (bypassing executeEnrichSeedData), so symmetrize links once
          // at the tail. Best-effort, never blocks the result.
          try {
            const { applyBidirectionalBacklinks } = await import("./graph-integrity.js");
            const bl = await applyBidirectionalBacklinks();
            if (bl.entities_needing_backlinks > 0) {
              logger.info(
                `init_graph: post-init backlinks added reciprocals on ${bl.entities_needing_backlinks} entities`,
              );
            }
          } catch (err) {
            logger.warn(`init_graph: backlink hook failed — ${err instanceof Error ? err.message : String(err)}`);
          }

          logger.info(`init_graph: ${summary}`);

          return success<InitGraphResult>({
            repos_scanned: scans.length,
            files_scanned: totalFiles,
            features_generated: allFeatures.length,
            workflows_generated: allWorkflows.length,
            data_model_entities_generated: allDataModel.length,
            index_entries: Object.keys(index.entities).length,
            cross_links_created: linkCount,
            files_written: writtenFiles,
            message: summary + llmAdvice,
          });
        } catch (err) {
          logger.error(
            `init_graph unexpected failure for repos=${JSON.stringify(requestedRepos ?? availableRepos)} force=${String(force)}: ${err instanceof Error ? err.message : String(err)}`
          );
          throw err;
        }
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
