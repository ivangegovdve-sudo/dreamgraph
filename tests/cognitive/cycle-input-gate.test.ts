import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  preflightGraphInputs,
  writeGraphManifest,
  type GraphManifest,
} from "../../src/cognitive/cycle-input-gate.js";
import {
  cycleOutcomeForFindingCount,
  formatCycleSummary,
  unknownCycleResponse,
} from "../../src/cognitive/cycle-outcome.js";

async function writeGraphFixture(options: {
  graphDir: string;
  repos: Record<string, string>;
  entityCount: number;
  generatedAt?: string;
}): Promise<void> {
  await mkdir(options.graphDir, { recursive: true });
  const entity = {
    id: "feature_fixture",
    name: "Fixture feature",
    source_repo: "repo-a",
  };
  const features = Array.from({ length: options.entityCount }, (_, index) => ({
    ...entity,
    id: `${entity.id}_${index}`,
  }));
  await writeFile(join(options.graphDir, "features.json"), JSON.stringify(features));
  await writeFile(join(options.graphDir, "workflows.json"), "[]");
  await writeFile(join(options.graphDir, "data_model.json"), "[]");
  await writeFile(join(options.graphDir, "index.json"), JSON.stringify({
    entities: Object.fromEntries(features.map((item) => [item.id, {
      type: "feature",
      uri: `feature://${item.id}`,
      name: item.name,
      source_repo: item.source_repo,
    }])),
  }));
  const manifest: GraphManifest = {
    schema: "dreamgraph.graph_manifest.v1",
    schema_version: "1.0.0",
    graph_version: "fixture-v1",
    generated_at: options.generatedAt ?? new Date().toISOString(),
    source_repos: options.repos,
    entity_count: options.entityCount,
  };
  await writeFile(join(options.graphDir, "graph_manifest.json"), JSON.stringify(manifest));
}

describe("cycle input gate", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dreamgraph-cycle-gate-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns UNKNOWN for an empty graph instead of a clean scan", async () => {
    const repo = join(root, "repo-a");
    await mkdir(repo);
    const graphDir = join(root, "data");
    await writeGraphFixture({ graphDir, repos: { "repo-a": repo }, entityCount: 0 });

    const result = await preflightGraphInputs({
      dataDir: graphDir,
      repos: { "repo-a": repo },
    });

    expect(result.status).toBe("UNKNOWN");
    expect(result.reason_code).toBe("GRAPH_EMPTY");
    expect(result.message).not.toMatch(/clean|0 threats|no findings/i);
  });

  it("returns UNKNOWN when a configured repository cannot be resolved", async () => {
    const graphDir = join(root, "data");
    const missingRepo = join(root, "does-not-exist");
    await writeGraphFixture({ graphDir, repos: { "repo-a": missingRepo }, entityCount: 1 });

    const result = await preflightGraphInputs({
      dataDir: graphDir,
      repos: { "repo-a": missingRepo },
    });

    expect(result.status).toBe("UNKNOWN");
    expect(result.reason_code).toBe("REPOSITORY_UNRESOLVABLE");
  });

  it("accepts a stamped, parseable graph with entities and resolvable repositories", async () => {
    const repo = join(root, "repo-a");
    await mkdir(repo);
    const graphDir = join(root, "data");
    await writeGraphFixture({ graphDir, repos: { "repo-a": repo }, entityCount: 1 });

    const result = await preflightGraphInputs({
      dataDir: graphDir,
      repos: { "repo-a": repo },
    });

    expect(result).toMatchObject({
      status: "READY",
      graph_version: "fixture-v1",
      entity_count: 1,
      repo_count: 1,
    });
  });

  it("writes a freshness/version stamp from the current graph contents", async () => {
    const repo = join(root, "repo-a");
    await mkdir(repo);
    const graphDir = join(root, "data");
    await writeGraphFixture({ graphDir, repos: { "repo-a": repo }, entityCount: 1 });

    await writeGraphManifest({ dataDir: graphDir, repos: { "repo-a": repo } });
    const result = await preflightGraphInputs({
      dataDir: graphDir,
      repos: { "repo-a": repo },
    });

    expect(result.status).toBe("READY");
    expect(result.status === "READY" && result.graph_version).toMatch(/^sha256:/);
  });
});

describe("cycle outcome and scheduler summary", () => {
  it("classifies zero findings as DRY and positive findings as FOUND", () => {
    expect(cycleOutcomeForFindingCount(0)).toBe("DRY");
    expect(cycleOutcomeForFindingCount(2)).toBe("FOUND");
  });

  it("includes the outcome and count in scheduled summaries", () => {
    expect(formatCycleSummary("nightmare_cycle", "all_threats", "DRY", 0))
      .toBe("nightmare_cycle(all_threats): DRY, 0 threats found");
    expect(formatCycleSummary("nightmare_cycle", "all_threats", "FOUND", 2))
      .toBe("nightmare_cycle(all_threats): FOUND, 2 threats found");
    expect(formatCycleSummary("nightmare_cycle", "all_threats", "UNKNOWN"))
      .toMatch(/^nightmare_cycle\(all_threats\): UNKNOWN, scan not run:/);
    expect(formatCycleSummary("nightmare_cycle", "all_threats", "UNKNOWN"))
      .not.toMatch(/0 threats found/);
  });

  it("maps UNKNOWN to a failure response that cannot serialize as a clean result", () => {
    const response = unknownCycleResponse({
      status: "UNKNOWN",
      reason_code: "GRAPH_EMPTY",
      message: "Cycle inputs were not usable: graph has no entities.",
    });

    expect(response).toMatchObject({
      success: false,
      error: {
        code: "UNKNOWN_INPUTS",
        outcome: "UNKNOWN",
      },
    });
    expect(JSON.stringify(response)).not.toMatch(/threats_found|clean audit|0 threats/i);
  });
});
