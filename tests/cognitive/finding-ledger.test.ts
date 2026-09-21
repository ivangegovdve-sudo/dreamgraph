import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  findingsFromDreamCycle,
  findingFromDreamEdge,
  findingFromThreatEdge,
  reconcileDreamCycleArtifacts,
} from "../../src/cognitive/finding-model.js";
import {
  appendVerdictLedger,
  isVerdictLedgerEnabled,
  readVerdictLedger,
} from "../../src/cognitive/verdict-ledger.js";
import type { DreamEdge, DreamNode, ThreatEdge } from "../../src/cognitive/types.js";

const dreamEdge: DreamEdge = {
  id: "dream-edge-1",
  from: "feature-a",
  to: "feature-b",
  type: "hypothetical",
  relation: "potential_unified_pipeline",
  reason: "Both features share a deployment boundary.",
  confidence: 0.73,
  origin: "rem",
  created_at: "2026-09-16T12:00:00.000Z",
  dream_cycle: 4,
  strategy: "gap_detection",
  ttl: 5,
  decay_rate: 0.1,
  reinforcement_count: 0,
  last_reinforced_cycle: 4,
  status: "candidate",
  activation_score: 0.8,
  plausibility: 0.7,
  evidence_score: 0.5,
  contradiction_score: 0,
};

const dreamNode: DreamNode = {
  id: "dream-node-1",
  type: "hypothetical_feature",
  name: "Unified deployment view",
  description: "A shared deployment view could reduce release drift.",
  inspiration: ["feature-a"],
  confidence: 0.61,
  origin: "rem",
  created_at: "2026-09-16T12:00:00.000Z",
  dream_cycle: 4,
  ttl: 5,
  decay_rate: 0.1,
  reinforcement_count: 0,
  last_reinforced_cycle: 4,
  status: "candidate",
  activation_score: 0.8,
};

const threatEdge: ThreatEdge = {
  id: "threat-edge-1",
  from: "feature-a",
  to: "data-user",
  threat_category: "broken_access_control",
  severity: "high",
  cwe_id: "CWE-862",
  attack_vector: "Unauthenticated feature access reaches user data.",
  blast_radius: ["feature-a", "data-user"],
  confidence: 0.91,
  description: "The access path lacks an authorization boundary.",
  mitigation: "Add an authorization check before the data access.",
  discovered_at: "2026-09-16T12:00:00.000Z",
  dream_cycle: 0,
};

const repositories = {
  "feature-a": "repo-a",
  "feature-b": "repo-b",
  "data-user": "repo-a",
};

describe("unified finding model", () => {
  it("keeps DreamEdge and ThreatEdge provenance intact", () => {
    const opportunity = findingFromDreamEdge(dreamEdge, {
      outcome: "FOUND",
      entity_repositories: repositories,
    });
    const threat = findingFromThreatEdge(threatEdge, {
      outcome: "FOUND",
      entity_repositories: repositories,
    });

    expect(opportunity).toMatchObject({
      finding_id: "opportunity:dream-edge-1",
      kind: "opportunity",
      affected_repositories: ["repo-a", "repo-b"],
      affected_entities: ["feature-a", "feature-b"],
      confidence: 0.73,
      severity: null,
      rationale: dreamEdge.reason,
      lifecycle_state: "candidate",
      next_action: "validate opportunity",
      outcome: "FOUND",
      provenance: { kind: "dream_edge" },
    });
    expect(opportunity.provenance.kind === "dream_edge" && opportunity.provenance.edge).toBe(dreamEdge);

    expect(threat).toMatchObject({
      finding_id: "threat:threat-edge-1",
      kind: "threat",
      affected_repositories: ["repo-a"],
      affected_entities: ["feature-a", "data-user"],
      confidence: 0.91,
      severity: "high",
      rationale: threatEdge.description,
      lifecycle_state: "new",
      next_action: threatEdge.mitigation,
      outcome: "FOUND",
      provenance: { kind: "threat_edge" },
    });
    expect(threat.provenance.kind === "threat_edge" && threat.provenance.edge).toBe(threatEdge);
  });

  it("uses the persisted post-normalization artifact state", () => {
    const normalizedNode: DreamNode = {
      ...dreamNode,
      confidence: 0.94,
      status: "rejected",
    };
    const normalizedEdge: DreamEdge = {
      ...dreamEdge,
      confidence: 0.88,
      status: "validated",
    };
    const reconciled = reconcileDreamCycleArtifacts(
      { nodes: [dreamNode], edges: [dreamEdge] },
      { nodes: [normalizedNode], edges: [normalizedEdge] },
    );
    const findings = findingsFromDreamCycle(reconciled.nodes, reconciled.edges, {
      outcome: "FOUND",
      entity_repositories: repositories,
    });

    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      finding_id: "opportunity:node:dream-node-1",
      lifecycle_state: "rejected",
      confidence: 0.94,
      next_action: "discard opportunity",
    });
    expect(findings[1]).toMatchObject({
      finding_id: "opportunity:dream-edge-1",
      lifecycle_state: "validated",
      confidence: 0.88,
      next_action: "use validated opportunity",
    });
    expect(findings[0].provenance.kind === "dream_node" && findings[0].provenance.node).toBe(normalizedNode);
    expect(findings[1].provenance.kind === "dream_edge" && findings[1].provenance.edge).toBe(normalizedEdge);
  });
});

describe("append-only verdict ledger", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "dreamgraph-verdict-ledger-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("defaults the emission switch off", () => {
    expect(isVerdictLedgerEnabled()).toBe(false);
  });

  it("reads the emission switch after instance environment loading", () => {
    const previous = process.env.DREAMGRAPH_VERDICT_LEDGER_ENABLED;
    try {
      process.env.DREAMGRAPH_VERDICT_LEDGER_ENABLED = "true";
      expect(isVerdictLedgerEnabled()).toBe(true);

      process.env.DREAMGRAPH_VERDICT_LEDGER_ENABLED = "false";
      expect(isVerdictLedgerEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DREAMGRAPH_VERDICT_LEDGER_ENABLED;
      else process.env.DREAMGRAPH_VERDICT_LEDGER_ENABLED = previous;
    }
  });

  it("is inert when the emission switch is omitted or disabled", async () => {
    const finding = findingFromDreamEdge(dreamEdge, { outcome: "FOUND" });

    const result = await appendVerdictLedger({
      data_dir: dataDir,
      outcome: "FOUND",
      graph_version: "graph-v1",
      findings: [finding],
      enabled: false,
    });

    expect(result).toMatchObject({ enabled: false, new_finding_ids: [] });
    expect(existsSync(join(dataDir, "verdict_ledger.jsonl"))).toBe(false);
  });

  it("appends records and exposes the finding delta", async () => {
    const opportunity = findingFromDreamEdge(dreamEdge, { outcome: "FOUND" });
    const threat = findingFromThreatEdge(threatEdge, { outcome: "FOUND" });

    const first = await appendVerdictLedger({
      data_dir: dataDir,
      enabled: true,
      run_id: "run-1",
      recorded_at: "2026-09-16T12:01:00.000Z",
      outcome: "FOUND",
      graph_version: "graph-v1",
      findings: [opportunity],
    });
    const second = await appendVerdictLedger({
      data_dir: dataDir,
      enabled: true,
      run_id: "run-2",
      recorded_at: "2026-09-16T12:02:00.000Z",
      outcome: "FOUND",
      graph_version: "graph-v1",
      findings: [opportunity, threat],
    });

    expect(first.new_finding_ids).toEqual([opportunity.finding_id]);
    expect(second).toMatchObject({
      previous_run_id: "run-1",
      new_finding_ids: [threat.finding_id],
    });

    const ledger = await readVerdictLedger(dataDir);
    expect(ledger).toHaveLength(2);
    expect((await readFile(join(dataDir, "verdict_ledger.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("records UNKNOWN as not run rather than as a clean zero-finding verdict", async () => {
    const result = await appendVerdictLedger({
      data_dir: dataDir,
      enabled: true,
      run_id: "run-unknown",
      recorded_at: "2026-09-16T12:03:00.000Z",
      outcome: "UNKNOWN",
      graph_version: "graph-v1",
      reason: "graph inputs were unreadable",
      findings: [],
    });

    expect(result.entry).toMatchObject({
      outcome: "UNKNOWN",
      status: "scan_not_run",
      finding_count: null,
      reason: "graph inputs were unreadable",
    });
    expect(JSON.stringify(result.entry)).not.toMatch(/DRY|clean|0 findings/i);
  });

  it("repairs a truncated final record before the next append", async () => {
    const first = await appendVerdictLedger({
      data_dir: dataDir,
      enabled: true,
      run_id: "run-1",
      outcome: "FOUND",
      graph_version: "graph-v1",
      findings: [findingFromDreamEdge(dreamEdge, { outcome: "FOUND" })],
    });
    await appendFile(join(dataDir, "verdict_ledger.jsonl"), '{"schema":"dreamgraph.verdict_ledger.v1","run_id":"torn');

    await expect(readVerdictLedger(dataDir)).resolves.toHaveLength(1);

    const resumed = await appendVerdictLedger({
      data_dir: dataDir,
      enabled: true,
      run_id: "run-2",
      outcome: "DRY",
      graph_version: "graph-v1",
      findings: [],
    });

    expect(resumed.previous_run_id).toBe(first.run_id);
    expect(await readVerdictLedger(dataDir)).toHaveLength(2);
    expect((await readFile(join(dataDir, "verdict_ledger.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("rejects completed corrupt records instead of hiding them as a torn tail", async () => {
    await appendVerdictLedger({
      data_dir: dataDir,
      enabled: true,
      run_id: "run-1",
      outcome: "DRY",
      graph_version: "graph-v1",
      findings: [],
    });
    await appendFile(join(dataDir, "verdict_ledger.jsonl"), "not-json\n");

    await expect(readVerdictLedger(dataDir)).rejects.toThrow("record 2 is not valid JSON");
  });
});
