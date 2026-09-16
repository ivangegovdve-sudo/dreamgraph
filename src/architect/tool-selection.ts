export interface ArchitectToolManifestLike {
  required_tools: string[];
  preferred_tools: string[];
  unavailable_required_tools?: string[];
}

export type ArchitectToolGroupKey =
  | "core_read"
  | "source_write"
  | "verification"
  | "graph_write"
  | "adr"
  | "ui_registry"
  | "cognitive_read"
  | "cognitive_run"
  | "graph_health"
  | "graph_maintenance"
  | "scheduler"
  | "project_scan"
  | "docs_visuals"
  | "ops_debug"
  | "discipline";

export interface ArchitectToolIntent {
  groups: ArchitectToolGroupKey[];
  mutating: boolean;
  verifying: boolean;
  graphWriting: boolean;
  rationale: string[];
}

export interface ArchitectToolSelectionDecision {
  selected: string[];
  required_tools: string[];
  preferred_tools: string[];
  unavailable_required_tools: string[];
  groups: ArchitectToolGroupKey[];
  mutating: boolean;
  verifying: boolean;
  rationale: string;
}

const MAX_REQUIRED_TOOLS = 32;
const MAX_SELECTED_TOOLS_DEFAULT = 18;
const MAX_SELECTED_TOOLS_MUTATION = 40;
const MAX_SELECTED_TOOLS_AUTONOMY = 56;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;
const GRAPH_GROUNDING_REQUIRED_TOOLS = ["query_resource", "query_architecture_decisions"] as const;
const GRAPH_GROUNDING_PREFERRED_TOOLS = ["graph_rag_retrieve", "cognitive_status", "get_cognitive_preamble"] as const;
const GRAPH_RECORDING_REQUIRED_TOOLS = ["enrich_seed_data"] as const;
const GRAPH_HEALTH_REQUIRED_TOOLS = ["graph_health_report"] as const;
const TARGETED_DREAM_REQUIRED_TOOLS = ["schedule_dream"] as const;

export const ARCHITECT_TOOL_GROUPS: Record<ArchitectToolGroupKey, readonly string[]> = {
  core_read: [
    "graph_health_report",
    "cognitive_status",
    "query_resource",
    "graph_rag_retrieve",
    "shortest_path",
    "query_api_surface",
    "search_data_model",
    "read_source_code",
    "search_source_code",
    "list_directory",
    "list_markdown_chapters",
    "read_markdown_chapter",
    "read_local_file",
  ],
  source_write: [
    "patch_file",
    "edit_file",
    "create_file",
    "append_to_file",
    "rename_file",
    "delete_file",
    "edit_markdown_section",
    "patch_markdown_chapter",
    "write_file",
    "modify_entity",
  ],
  verification: [
    "run_command",
  ],
  graph_write: [
    "enrich_seed_data",
    "enrich_parser_nodes",
    "solidify_cognitive_insight",
    "modify_api_surface",
    "edit_entity",
  ],
  adr: [
    "query_architecture_decisions",
    "record_architecture_decision",
    "deprecate_architecture_decision",
  ],
  ui_registry: [
    "query_ui_elements",
    "register_ui_element",
    "generate_ui_migration_plan",
  ],
  cognitive_read: [
    "cognitive_status",
    "get_cognitive_preamble",
    "get_dream_insights",
    "query_dreams",
    "get_causal_insights",
    "get_temporal_insights",
    "get_system_narrative",
    "get_system_story",
    "get_remediation_plan",
    "query_self_metrics",
  ],
  cognitive_run: [
    "dream_cycle",
    "normalize_dreams",
    "nightmare_cycle",
    "run_review_cycle",
    "lucid_dream",
    "lucid_action",
    "wake_from_lucid",
  ],
  graph_health: [
    "graph_health_report",
    "cognitive_status",
    "query_self_metrics",
  ],
  graph_maintenance: [
    "enrich_parser_nodes",
    "scan_project",
    "scan_database",
    "normalize_dreams",
    "get_remediation_plan",
    "resolve_tension",
    "export_living_docs",
    "bootstrap_instance",
  ],
  scheduler: [
    "schedule_dream",
    "list_schedules",
    "update_schedule",
    "run_schedule_now",
    "delete_schedule",
    "get_schedule_history",
  ],
  project_scan: [
    "init_graph",
    "scan_project",
    "scan_database",
    "bootstrap_instance",
    "extract_api_surface",
  ],
  docs_visuals: [
    "generate_visual_flow",
    "export_living_docs",
    "generate_ui_migration_plan",
    "export_dream_archetypes",
  ],
  ops_debug: [
    "query_self_metrics",
    "query_runtime_metrics",
    "query_db_schema",
    "git_log",
    "git_blame",
    "fetch_web_page",
  ],
  discipline: [
    "discipline_start_session",
    "discipline_transition",
    "discipline_check_tool",
    "discipline_get_session",
    "discipline_record_delta",
    "discipline_submit_plan",
    "discipline_approve_plan",
    "discipline_verify",
    "discipline_complete_session",
  ],
};

const TOOL_ALIASES = new Map<string, string>([
  ["dreamgraph:read_source_code", "read_source_code"],
  ["mcp__dreamgraph.read_source_code", "read_source_code"],
  ["readSourceCode", "read_source_code"],
  ["read_source_file", "read_source_code"],
  ["dreamgraph:search_source_code", "search_source_code"],
  ["mcp__dreamgraph.search_source_code", "search_source_code"],
  ["searchSourceCode", "search_source_code"],
  ["dreamgraph:list_directory", "list_directory"],
  ["mcp__dreamgraph.list_directory", "list_directory"],
  ["listDirectory", "list_directory"],
  ["dreamgraph:patch_file", "patch_file"],
  ["mcp__dreamgraph.patch_file", "patch_file"],
  ["patchFile", "patch_file"],
  ["dreamgraph:append_to_file", "append_to_file"],
  ["mcp__dreamgraph.append_to_file", "append_to_file"],
  ["appendToFile", "append_to_file"],
  ["dreamgraph:create_file", "create_file"],
  ["mcp__dreamgraph.create_file", "create_file"],
  ["createFile", "create_file"],
  ["dreamgraph:edit_file", "edit_file"],
  ["mcp__dreamgraph.edit_file", "edit_file"],
  ["editFile", "edit_file"],
  ["dreamgraph:delete_file", "delete_file"],
  ["mcp__dreamgraph.delete_file", "delete_file"],
  ["deleteFile", "delete_file"],
  ["dreamgraph:rename_file", "rename_file"],
  ["mcp__dreamgraph.rename_file", "rename_file"],
  ["renameFile", "rename_file"],
  ["dreamgraph:edit_markdown_section", "edit_markdown_section"],
  ["mcp__dreamgraph.edit_markdown_section", "edit_markdown_section"],
  ["editMarkdownSection", "edit_markdown_section"],
  ["dreamgraph:run_command", "run_command"],
  ["mcp__dreamgraph.run_command", "run_command"],
  ["runCommand", "run_command"],
  ["dreamgraph:query_ui_elements", "query_ui_elements"],
  ["mcp__dreamgraph.query_ui_elements", "query_ui_elements"],
  ["queryUiElements", "query_ui_elements"],
  ["dreamgraph:register_ui_element", "register_ui_element"],
  ["mcp__dreamgraph.register_ui_element", "register_ui_element"],
  ["registerUiElement", "register_ui_element"],
  ["dreamgraph:query_architecture_decisions", "query_architecture_decisions"],
  ["mcp__dreamgraph.query_architecture_decisions", "query_architecture_decisions"],
  ["queryArchitectureDecisions", "query_architecture_decisions"],
  ["dreamgraph:record_architecture_decision", "record_architecture_decision"],
  ["mcp__dreamgraph.record_architecture_decision", "record_architecture_decision"],
  ["recordArchitectureDecision", "record_architecture_decision"],
  ["dreamgraph:modify_api_surface", "modify_api_surface"],
  ["mcp__dreamgraph.modify_api_surface", "modify_api_surface"],
  ["modifyApiSurface", "modify_api_surface"],
]);

const MUTATION_KEYWORDS = [
  "patch", "fix", "repair", "implement", "implementation", "edit", "modify",
  "change", "update", "write", "add", "create", "insert", "delete", "remove",
  "rename", "replace", "refactor", "wire", "persist", "hydrate", "restore",
  "finish", "complete", "apply", "regression", "coverage", "scaffold",
  "make it compile", "make build pass", "source mutation", "file mutation",
  "source edit", "file edit", "patch stable", "add/update",
];

const VERIFICATION_KEYWORDS = [
  "test", "tests", "tested", "verify", "verifies", "verified", "verification",
  "validate", "validation", "build", "lint", "typecheck", "type-check",
  "sanity", "check", "checks", "vitest", "npm test", "npm run", "pnpm",
  "yarn", "tsc", "compile", "run the relevant", "run targeted", "inspect output",
];

const SOURCE_TARGET_KEYWORDS = [
  "src/", "tests/", "test/", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts",
  "routes.ts", "standalone-architect-routes", "source", "code", "file",
  "files", "helper", "helpers", "route", "routes", "persistence", "runtime dir",
  "runtimedir", "runtime_dir", "chat-history", "transcript", "hydration",
];

const GRAPH_WRITE_KEYWORDS = [
  "update dreamgraph", "update the dreamgraph", "update knowledge graph",
  "graph mutation", "graph write", "enrich", "enrich seed", "register entity",
  "add entity", "edit entity", "modify entity", "seed data", "modify api surface",
  "register api", "solidify insight", "solidify_cognitive_insight", "record changes",
  "record graph", "record all changes",
];

const ADR_KEYWORDS = [
  "adr", "adrs", "architecture decision", "decision record", "decision log",
  "guardrail", "guard rail", "record adr", "document decision", "new adr",
  "superseding adr", "propose adr", "architectural decision",
];

const UI_KEYWORDS = [
  "ui", "webview", "interface", "component", "element", "registry",
  "ui registry", "ui_registry", "button", "pill", "panel", "chat shell",
];

const COGNITIVE_KEYWORDS = [
  "cognitive", "dream", "dreams", "dream cycle", "nightmare", "lucid",
  "remediation", "tension", "system narrative", "system story", "graph health",
  "status", "health",
];

const SCHEDULER_KEYWORDS = [
  "schedule", "scheduled", "scheduling", "cron", "recurring", "interval",
];

const PROJECT_SCAN_KEYWORDS = [
  "scan project", "scan_project", "init graph", "init_graph", "rebuild graph",
  "refresh graph", "reindex", "extract api surface", "extract_api_surface",
];

const GRAPH_MAINTENANCE_KEYWORDS = [
  "graph health", "semantic density", "hollow description", "parser-only",
  "parser only", "stale scan", "stale enrichment", "re-enrich", "reenrich",
  "force semantic enrichment", "scan database", "scan datastore", "database_url",
  "refresh parser", "refresh ui metadata", "normalize dreams", "resolve tensions",
  "bootstrap instance", "self-heal", "self healing", "cognitive maintenance",
];

const SUBSTANTIAL_ARCHITECTURAL_KEYWORDS = [
  "architecture", "architectural", "plan", "planning", "design", "implement",
  "implementation", "feature", "workflow", "contract", "capability", "invariant",
  "refactor", "migration", "module", "public api", "data model", "datastore",
  "codebase", "repository", "project", "system", "cross-module", "cross module",
];

const MAJOR_IMPLEMENTATION_KEYWORDS = [
  "implement", "implementation", "feature", "workflow", "refactor",
  "migration", "module", "public api", "data model", "datastore", "cross-module",
  "cross module", "major", "substantial", "architectural change", "architecture change",
];

const MINOR_CHANGE_KEYWORDS = [
  "typo", "formatting only", "comment only", "rename variable", "minor copy",
];

const DOCS_KEYWORDS = [
  "living docs", "export docs", "diagram", "visual flow", "mermaid",
  "ui migration", "migration plan", "archetype",
];

const DISCIPLINE_KEYWORDS = [
  "discipline session", "disciplined execution", "plan-do-verify",
  "submit plan", "approve plan", "discipline_verify",
];

const INFERABLE_TOOLS = uniqueTools([
  ...Object.values(ARCHITECT_TOOL_GROUPS).flat(),
]);
const INFERABLE_TOOL_SET = new Set(INFERABLE_TOOLS);

const READ_EQUIVALENT_TOOLS = new Set([
  "read_source_code",
  "search_source_code",
  "list_directory",
  "query_resource",
  "graph_rag_retrieve",
  "query_api_surface",
  "search_data_model",
  "read_markdown_chapter",
  "list_markdown_chapters",
  "read_local_file",
]);

const SOURCE_MUTATION_EQUIVALENT_TOOLS = new Set([
  "patch_file",
  "edit_file",
  "create_file",
  "append_to_file",
  "rename_file",
  "delete_file",
  "edit_markdown_section",
  "patch_markdown_chapter",
  "write_file",
]);

const GRAPH_RECORDING_EQUIVALENT_TOOLS = new Set([
  "enrich_seed_data",
  "enrich_parser_nodes",
  "solidify_cognitive_insight",
  "modify_api_surface",
  "edit_entity",
  "register_ui_element",
  "record_architecture_decision",
]);

export function buildArchitectToolManifestFromText(parts: readonly string[]): ArchitectToolManifestLike {
  const intent = inferArchitectToolIntent(parts);
  const text = parts.join("\n");
  const mentioned = INFERABLE_TOOLS.filter((tool) => hasToolMention(text, tool));
  const explicitRequired = explicitRequiredToolMentions(text);
  const recoveryOnly = isMissingToolRecoveryPrompt(text, explicitRequired);
  const required: string[] = [...GRAPH_GROUNDING_REQUIRED_TOOLS];
  const preferred: string[] = [...GRAPH_GROUNDING_PREFERRED_TOOLS, ...mentioned];
  const substantialArchitecturalWork = isSubstantialArchitecturalWork(text, intent.mutating);
  const majorImplementation = isMajorImplementationWork(text, intent.mutating);

  if (recoveryOnly) {
    required.push(...explicitRequired);
    if (explicitRequired.some((tool) => SOURCE_MUTATION_EQUIVALENT_TOOLS.has(tool))) {
      required.push("read_source_code", ...GRAPH_RECORDING_REQUIRED_TOOLS, "run_command");
      preferred.push("search_source_code", "modify_api_surface", "solidify_cognitive_insight");
    }
    if (explicitRequired.some((tool) => GRAPH_RECORDING_EQUIVALENT_TOOLS.has(tool))) {
      preferred.push("modify_api_surface", "solidify_cognitive_insight", "record_architecture_decision");
    }
    const requiredTools = mergeToolNames(required);
    return {
      required_tools: requiredTools,
      preferred_tools: withoutToolNames(mergeToolNames(preferred), requiredTools),
    };
  }

  if (substantialArchitecturalWork) {
    required.push(...GRAPH_HEALTH_REQUIRED_TOOLS);
  } else {
    preferred.push(...GRAPH_HEALTH_REQUIRED_TOOLS);
  }
  if (majorImplementation) {
    required.push(...TARGETED_DREAM_REQUIRED_TOOLS);
  }

  if (intent.mutating) {
    required.push("read_source_code", "patch_file", ...GRAPH_RECORDING_REQUIRED_TOOLS);
    if (hasAny(text, ["append", "append marker", "append to"])) preferred.push("append_to_file");
    preferred.push("modify_api_surface", "solidify_cognitive_insight");
  }
  if (intent.verifying) {
    required.push("run_command");
  } else if (intent.mutating) {
    preferred.push("run_command");
  }
  if (!intent.mutating && hasAny(text, ["inspect", "read", "review", "locate", "find", "search", "query"])) {
    preferred.push("search_source_code", "read_source_code");
  }
  if (intent.graphWriting) {
    preferred.push("query_resource", "enrich_seed_data", "modify_api_surface");
  }
  if (intent.groups.includes("adr")) {
    preferred.push("query_architecture_decisions");
    if (hasAny(text, ["record adr", "document decision", "capture decision", "add adr", "new adr", "superseding adr", "architecture decision record"])) {
      required.push("record_architecture_decision");
    }
    preferred.push("record_architecture_decision");
  }
  if (intent.groups.includes("ui_registry")) {
    preferred.push("query_ui_elements");
    if (intent.mutating && hasAny(text, ["register ui", "register element", "ui registry", "ui_registry"])) {
      preferred.push("register_ui_element");
    }
  }

  const requiredTools = mergeToolNames(required, explicitRequired);
  return {
    required_tools: requiredTools,
    preferred_tools: withoutToolNames(mergeToolNames(preferred), requiredTools),
  };
}

export function selectArchitectToolNames(input: {
  prompt: string;
  availableToolNames: readonly string[];
  manifest?: ArchitectToolManifestLike | null;
  autonomy?: boolean;
  primedTools?: readonly string[];
}): ArchitectToolSelectionDecision {
  const available = uniqueTools(input.availableToolNames.filter((name) => TOOL_NAME_RE.test(name)));
  const availableSet = new Set(available);
  const intent = inferArchitectToolIntent([input.prompt]);
  const manifest = input.manifest ?? null;
  const inferredManifest = buildArchitectToolManifestFromText([input.prompt]);
  const noMutationDirective = hasNoMutationDirective(input.prompt);
  let requiredTools = mergeToolNames(manifest?.required_tools ?? [], inferredManifest.required_tools);
  let preferredTools = withoutToolNames(
    mergeToolNames(manifest?.preferred_tools ?? [], inferredManifest.preferred_tools),
    requiredTools,
  );
  if (noMutationDirective) {
    requiredTools = requiredTools.filter((tool) => !SOURCE_MUTATION_EQUIVALENT_TOOLS.has(tool));
    requiredTools = requiredTools.filter((tool) => !GRAPH_RECORDING_EQUIVALENT_TOOLS.has(tool));
    preferredTools = preferredTools.filter((tool) => !SOURCE_MUTATION_EQUIVALENT_TOOLS.has(tool));
    preferredTools = preferredTools.filter((tool) => !GRAPH_RECORDING_EQUIVALENT_TOOLS.has(tool));
  }
  const selected: string[] = [];
  const reasons = [...intent.rationale];
  if (noMutationDirective) reasons.push("no-mutation directive -> suppress source_write tools");
  const add = (name: string): boolean => {
    const normalized = normalizeArchitectToolName(name);
    if (!normalized || !availableSet.has(normalized) || selected.includes(normalized)) return false;
    selected.push(normalized);
    return true;
  };

  for (const tool of requiredTools) add(tool);
  if (availableSet.has("run_command")) {
    add("run_command");
    reasons.push("pinned[run_command]");
  }
  for (const tool of preferredTools) add(tool);

  for (const tool of directToolMentions(input.prompt, available)) {
    if (add(tool)) reasons.push(`tool-name[${tool}]`);
  }

  const groups = input.autonomy
    ? uniqueGroups([...intent.groups, "ops_debug", "adr"])
    : intent.groups;
  if (input.autonomy) reasons.push("autonomy=on -> ops_debug+adr");

  for (const group of groups) {
    for (const tool of ARCHITECT_TOOL_GROUPS[group]) add(tool);
  }

  const primed = mergeToolNames(input.primedTools ?? [], requiredTools, preferredTools);
  if (primed.length > 0) {
    for (const group of groupsForTools(primed)) {
      for (const tool of ARCHITECT_TOOL_GROUPS[group]) {
        if (add(tool)) reasons.push(`primed-group[${group}]`);
      }
    }
    for (const tool of primed) {
      if (add(tool)) reasons.push(`primed[${tool}]`);
    }
  }

  const cap = input.autonomy
    ? MAX_SELECTED_TOOLS_AUTONOMY
    : intent.mutating || intent.verifying || requiredTools.length > 0
      ? MAX_SELECTED_TOOLS_MUTATION
      : MAX_SELECTED_TOOLS_DEFAULT;
  let finalSelected = selected;
  if (selected.length > cap) {
    reasons.push(`cap=${cap} truncated from ${selected.length}`);
    finalSelected = selected.slice(0, cap);
  }

  const known = new Set(Object.values(ARCHITECT_TOOL_GROUPS).flat());
  const allowUnknownPassthrough = !input.autonomy && !intent.mutating && !intent.verifying && requiredTools.length === 0;
  if (allowUnknownPassthrough) {
    for (const tool of available) {
      if (finalSelected.length >= cap) break;
      if (!known.has(tool) && !finalSelected.includes(tool)) {
        finalSelected.push(tool);
        reasons.push(`passthrough[${tool}]`);
      }
    }
  }

  return {
    selected: finalSelected,
    required_tools: requiredTools,
    preferred_tools: preferredTools,
    unavailable_required_tools: requiredTools.filter((tool) => !availableSet.has(tool)),
    groups,
    mutating: intent.mutating,
    verifying: intent.verifying,
    rationale: reasons.join("; "),
  };
}

export function inferArchitectToolIntent(parts: readonly string[]): ArchitectToolIntent {
  const text = parts.join("\n");
  const lower = text.toLowerCase();
  const groups: ArchitectToolGroupKey[] = ["core_read", "adr"];
  const rationale: string[] = ["core_read baseline", "ADR grounding baseline"];
  const mutationKeyword = hasAny(lower, MUTATION_KEYWORDS);
  const sourceTarget = hasAny(lower, SOURCE_TARGET_KEYWORDS) || /\b(?:src|tests?|docs|extensions|packages)\/[A-Za-z0-9_.\/-]+/.test(lower);
  const explicitNoMutation = hasNoMutationDirective(lower);
  const mutating = !explicitNoMutation && (mutationKeyword || (sourceTarget && hasAny(lower, ["add", "update", "fix", "patch", "persist", "restore", "prove", "regression", "coverage"])));
  const verifying = hasAny(lower, VERIFICATION_KEYWORDS);
  const graphWriting = !explicitNoMutation && hasAny(lower, GRAPH_WRITE_KEYWORDS);

  if (mutating) {
    groups.push("source_write", "verification", "graph_write", "adr");
    rationale.push("mutation intent -> source_write+verification+graph_write+adr");
  }
  if (!mutating && verifying) {
    groups.push("verification");
    rationale.push("verification intent -> verification");
  }
  if (graphWriting) {
    groups.push("graph_write", "adr");
    rationale.push("graph write intent -> graph_write+adr");
  }
  if (hasAny(lower, ADR_KEYWORDS)) {
    groups.push("adr");
    rationale.push("ADR intent -> adr");
  }
  if (hasAny(lower, UI_KEYWORDS)) {
    groups.push("ui_registry");
    rationale.push("UI intent -> ui_registry");
  }
  if (hasAny(lower, COGNITIVE_KEYWORDS)) {
    groups.push("cognitive_read");
    rationale.push("cognitive/status intent -> cognitive_read");
  }
  if (hasAny(lower, GRAPH_MAINTENANCE_KEYWORDS)) {
    groups.push("graph_health", "graph_maintenance");
    rationale.push("graph maintenance intent -> graph_health+graph_maintenance");
  }
  if (hasAny(lower, ["dream_cycle", "run dream", "run a dream", "normalize dreams", "nightmare", "lucid"])) {
    groups.push("cognitive_run");
    rationale.push("cognitive run intent -> cognitive_run");
  }
  if (hasAny(lower, SCHEDULER_KEYWORDS)) {
    groups.push("scheduler");
    rationale.push("scheduler intent -> scheduler");
  }
  if (hasAny(lower, PROJECT_SCAN_KEYWORDS)) {
    groups.push("project_scan", "graph_write", "cognitive_read");
    rationale.push("project scan intent -> project_scan+graph_write+cognitive_read");
  }
  if (hasAny(lower, DOCS_KEYWORDS)) {
    groups.push("docs_visuals");
    rationale.push("docs/visual intent -> docs_visuals");
  }
  if (hasAny(lower, DISCIPLINE_KEYWORDS)) {
    groups.push("discipline");
    rationale.push("discipline intent -> discipline");
  }

  return {
    groups: uniqueGroups(groups),
    mutating,
    verifying,
    graphWriting,
    rationale,
  };
}

function isSubstantialArchitecturalWork(text: string, mutating: boolean): boolean {
  const lower = text.toLowerCase();
  if (hasAny(lower, MINOR_CHANGE_KEYWORDS)) return false;
  return hasAny(lower, SUBSTANTIAL_ARCHITECTURAL_KEYWORDS)
    || (mutating && hasAny(lower, ["source", "code", "files", "route", "runtime"]));
}

function isMajorImplementationWork(text: string, mutating: boolean): boolean {
  if (!mutating) return false;
  const lower = text.toLowerCase();
  return !hasAny(lower, MINOR_CHANGE_KEYWORDS) && hasAny(lower, MAJOR_IMPLEMENTATION_KEYWORDS);
}

function explicitRequiredToolMentions(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|[\n\r]|[.;]\s*)\s*(?:[-*]\s*)?(?:satisfy these missing governed MCP tool obligations(?: before finalizing)?|required governed MCP tool obligation(?:\(s\))? still unsatisfied|missing required tools?|missing governed MCP tool obligations?|required MCP tool obligation not satisfied|required DreamGraph MCP tools for this pass|required_tools|required tools)\s*:\s*([^\n\r]+)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) != null) {
      for (const tool of toolNamesFromPhrase(match[1] ?? "")) {
        out.push(tool);
      }
    }
  }
  return mergeToolNames(out);
}

function isMissingToolRecoveryPrompt(text: string, explicitRequired: readonly string[]): boolean {
  if (explicitRequired.length === 0) return false;
  return /\b(?:satisfy these missing governed MCP tool obligations|retry required governed tools|required_tools_not_called|required_tools_missing|required governed MCP tool obligation(?:\(s\))? still unsatisfied|required MCP tool obligation not satisfied)\b/i.test(text);
}

function toolNamesFromPhrase(phrase: string): string[] {
  const out: string[] = [];
  const tokens = phrase.match(/[A-Za-z][A-Za-z0-9_-]{0,79}/g) ?? [];
  for (const token of tokens) {
    const normalized = normalizeArchitectToolName(token);
    if (!normalized || !INFERABLE_TOOL_SET.has(normalized)) continue;
    out.push(normalized);
  }
  return out;
}

function hasNoMutationDirective(text: string): boolean {
  return /\b(read[- ]?only|inspect only(?!\s+as\s+needed)|report only|do not patch|no patch|no source mutation|without mutating|do not mutate|no files? (?:should be )?mutated|no repository files? (?:should be )?changed)\b/i.test(text);
}

export function isRequiredArchitectToolSatisfied(requiredTool: string, calledTools: readonly string[]): boolean {
  const normalized = normalizeArchitectToolName(requiredTool);
  if (!normalized) return true;
  const called = new Set(calledTools.map((tool) => normalizeArchitectToolName(tool)).filter((tool): tool is string => Boolean(tool)));
  if (called.has(normalized)) return true;
  if (normalized === "read_source_code") return [...called].some((tool) => READ_EQUIVALENT_TOOLS.has(tool));
  if (normalized === "patch_file") return [...called].some((tool) => SOURCE_MUTATION_EQUIVALENT_TOOLS.has(tool));
  if (normalized === "enrich_seed_data") return [...called].some((tool) => GRAPH_RECORDING_EQUIVALENT_TOOLS.has(tool));
  return false;
}

export function normalizeArchitectToolName(name: string): string | null {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const aliased = TOOL_ALIASES.get(trimmed) ?? TOOL_ALIASES.get(trimmed.toLowerCase()) ?? trimmed;
  const normalized = aliased.replace(/^dreamgraph:/, "").replace(/^mcp__dreamgraph\./, "");
  return TOOL_NAME_RE.test(normalized) ? normalized : null;
}

export function mergeToolNames(...groups: readonly (readonly string[])[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of group) {
      const normalized = normalizeArchitectToolName(item);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      names.push(normalized);
      if (names.length >= MAX_REQUIRED_TOOLS) return names;
    }
  }
  return names;
}

export function withoutToolNames(names: readonly string[], excluded: readonly string[]): string[] {
  const blocked = new Set(excluded);
  return names.filter((name) => !blocked.has(name));
}

function directToolMentions(text: string, availableToolNames: readonly string[]): string[] {
  return availableToolNames.filter((tool) => hasToolMention(text, tool));
}

function hasToolMention(text: string, toolName: string): boolean {
  const lower = text.toLowerCase();
  const normalized = normalizeArchitectToolName(toolName) ?? toolName;
  const camel = normalized.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()).toLowerCase();
  return lower.includes(normalized.toLowerCase())
    || lower.includes(`dreamgraph:${normalized.toLowerCase()}`)
    || lower.includes(`mcp__dreamgraph.${normalized.toLowerCase()}`)
    || lower.includes(camel);
}

function groupsForTools(tools: readonly string[]): ArchitectToolGroupKey[] {
  const out: ArchitectToolGroupKey[] = [];
  const set = new Set(tools);
  for (const [group, names] of Object.entries(ARCHITECT_TOOL_GROUPS) as Array<[ArchitectToolGroupKey, readonly string[]]>) {
    if (names.some((name) => set.has(name))) out.push(group);
  }
  return uniqueGroups(out);
}

function hasAny(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => matchesKeyword(lower, keyword));
}

function matchesKeyword(lowerText: string, keyword: string): boolean {
  const lowerKeyword = keyword.toLowerCase();
  if (/^[a-z0-9_]+$/.test(lowerKeyword) && lowerKeyword.length <= 4) {
    return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(lowerKeyword)}($|[^a-z0-9_])`).test(lowerText);
  }
  return lowerText.includes(lowerKeyword);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueGroups(groups: readonly ArchitectToolGroupKey[]): ArchitectToolGroupKey[] {
  return [...new Set(groups)];
}

function uniqueTools(tools: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const normalized = normalizeArchitectToolName(tool);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
