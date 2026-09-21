import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config as appConfig } from "../../src/config/config.js";
import { createSchedule, runScheduleNow } from "../../src/cognitive/scheduler.js";
import {
  DEFAULT_REVIEW_PROFILE,
  REVIEW_OUTPUT_SCHEMA,
  createReviewReport,
  fleetReviewEmission,
  getReviewProfile,
  loadReviewReports,
  persistReviewReport,
  registerReviewProfile,
  runReviewProfile,
  serializeReviewReport,
  type ReviewProfile,
  type ReviewSnapshot,
} from "../../src/cognitive/review-seam.js";
import { securityEntitiesFromFactSnapshot } from "../../src/cognitive/adversarial.js";
import { getDataDir, setDataDirOverride } from "../../src/utils/paths.js";
import { setDataDirResolver } from "../../src/utils/cache.js";
import type { FactSnapshot } from "../../src/cognitive/strategies/_shared.js";

function fixtureSnapshot(): ReviewSnapshot {
  const feature = {
    id: "feature:upload",
    type: "feature" as const,
    name: "Upload form",
    description: "External input upload create write",
    domain: "web",
    keywords: ["upload", "email"],
    source_repo: "fixture-repo",
    source_files: ["src/upload.ts"],
    tags: [],
    category: "feature",
    links: [{ target: "data_model:users", type: "data_model", relationship: "write", description: "writes users", strength: "strong" }],
    steps: [],
    key_fields: [],
    relationships: [],
    descriptionTokens: new Set(["external", "input", "upload", "create", "write"]),
  };
  const model = {
    id: "data_model:users",
    type: "data_model" as const,
    name: "Users",
    description: "User email storage",
    domain: "data",
    keywords: ["email"],
    source_repo: "fixture-repo",
    source_files: ["db/users.sql"],
    tags: [],
    category: "data_model",
    links: [],
    steps: [],
    key_fields: ["email"],
    relationships: [],
    descriptionTokens: new Set(["user", "email", "storage"]),
  };
  const reviewFeature = {
    id: "feature:review",
    type: "feature" as const,
    name: "Review form",
    description: "Allows a reviewer to inspect incoming records.",
    domain: "web",
    keywords: ["review", "records"],
    source_repo: "fixture-repo",
    source_files: ["src/review.ts"],
    tags: [],
    category: "feature",
    links: [],
    steps: [],
    key_fields: [],
    relationships: [],
    descriptionTokens: new Set(["reviewer", "inspect", "incoming", "records"]),
  };
  const fact: FactSnapshot = {
    entities: new Map([[feature.id, feature], [model.id, model], [reviewFeature.id, reviewFeature]]),
    edgeSet: new Set([`${feature.id}|${model.id}`]),
    domains: new Set(["web", "data"]),
    sourceFileIndex: new Map([["src/upload.ts", [feature.id]], ["db/users.sql", [model.id]], ["src/review.ts", [reviewFeature.id]]]),
    degree: new Map([[feature.id, 1], [model.id, 1], [reviewFeature.id, 0]]),
  };
  return {
    context: {
      run_id: "run_fixture",
      captured_at: "2026-09-16T00:00:00.000Z",
      graph_version: "fixture-version-1",
      repository_names: ["fixture-repo"],
      entity_count: 3,
    },
    fact,
    security: securityEntitiesFromFactSnapshot(fact),
  };
}

const profile: ReviewProfile = {
  id: "fixture-profile",
  version: "1.0.0",
  role: "opportunity and threat reviewer",
  prompt: "Find one grounded opportunity and actionable threats in the supplied graph.",
  strategies: ["dream:gap_detection", "nightmare:all_threats"],
  output_schema: REVIEW_OUTPUT_SCHEMA,
};

async function writeScheduledGraph(dataDir: string, repo: string): Promise<void> {
  const upload = {
    id: "feature:upload",
    name: "Upload form",
    description: "External input upload create write",
    domain: "web",
    keywords: ["upload", "email"],
    source_repo: "fixture-repo",
    source_files: ["src/upload.ts"],
    tags: [],
    category: "feature",
    links: [{ target: "data_model:users", type: "data_model", relationship: "write", description: "writes users", strength: "strong" }],
    steps: [],
    key_fields: [],
    relationships: [],
  };
  const users = {
    id: "data_model:users",
    name: "Users",
    description: "User email storage",
    domain: "data",
    keywords: ["email"],
    source_repo: "fixture-repo",
    source_files: ["db/users.sql"],
    tags: [],
    category: "data_model",
    links: [],
    steps: [],
    key_fields: ["email"],
    relationships: [],
  };
  const review = {
    id: "feature:review",
    name: "Review form",
    description: "Allows a reviewer to inspect incoming records.",
    domain: "web",
    keywords: ["review", "records"],
    source_repo: "fixture-repo",
    source_files: ["src/review.ts"],
    tags: [],
    category: "feature",
    links: [],
    steps: [],
    key_fields: [],
    relationships: [],
  };
  const entities = [upload, users, review];
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "features.json"), JSON.stringify([upload, review]));
  await writeFile(join(dataDir, "workflows.json"), "[]");
  await writeFile(join(dataDir, "data_model.json"), JSON.stringify([users]));
  await writeFile(join(dataDir, "datastores.json"), "[]");
  await writeFile(join(dataDir, "index.json"), JSON.stringify({
    entities: Object.fromEntries(entities.map((entity) => [entity.id, {
      type: entity.category,
      uri: `${entity.category}://${entity.id}`,
      name: entity.name,
      source_repo: entity.source_repo,
    }])),
  }));
  await writeFile(join(dataDir, "graph_manifest.json"), JSON.stringify({
    schema: "dreamgraph.graph_manifest.v1",
    schema_version: "1.0.0",
    graph_version: "fixture-scheduled-v1",
    generated_at: new Date().toISOString(),
    source_repos: { "fixture-repo": repo },
    entity_count: 3,
  }));
}

describe("Dreams and Nightmares review seam", () => {
  it("exposes a profile registry and runs selected strategies over one pinned snapshot", async () => {
    expect(getReviewProfile(DEFAULT_REVIEW_PROFILE.id)).toEqual(DEFAULT_REVIEW_PROFILE);

    const snapshot = fixtureSnapshot();
    const result = await runReviewProfile(profile, snapshot);

    expect(result.context.graph_version).toBe("fixture-version-1");
    expect(result.context.run_id).toBe("run_fixture");
    expect(result.outcome).toBe("FOUND");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(new Set(result.findings.map((finding) => finding.provenance.kind)))
      .toEqual(new Set(["dream_edge", "threat_edge"]));
  });

  it("keeps UNKNOWN explicit and rejects an UNKNOWN report without an error", () => {
    const report = createReviewReport({
      profile,
      context: fixtureSnapshot().context,
      findings: [],
      outcome: "UNKNOWN",
      error: { code: "GRAPH_EMPTY", message: "graph unavailable" },
      fleet_emission: fleetReviewEmission({}),
    });

    expect(JSON.parse(serializeReviewReport(report))).toMatchObject({
      outcome: "UNKNOWN",
      error: { code: "GRAPH_EMPTY" },
      findings: [],
    });
    expect(() => serializeReviewReport({ ...report, error: undefined })).toThrow(/UNKNOWN report requires an error/);
  });

  it("rejects empty or unsupported profile strategy selections", async () => {
    expect(() => registerReviewProfile({
      ...profile,
      id: "invalid-empty-profile",
      strategies: [],
    })).toThrow(/at least one strategy/);

    await expect(runReviewProfile({
      ...profile,
      strategies: ["dream:reflective"] as ReviewProfile["strategies"],
    }, fixtureSnapshot())).rejects.toThrow(/not supported by the snapshot seam/);
  });

  it("persists a report without flattening its provenance", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "dreamgraph-review-"));
    try {
      const result = await runReviewProfile(profile, fixtureSnapshot());
      const report = createReviewReport({
        profile,
        context: result.context,
        findings: result.findings,
        outcome: result.outcome,
        fleet_emission: fleetReviewEmission({}),
      });
      await persistReviewReport(report, dataDir);
      const reports = await loadReviewReports(dataDir);

      expect(reports).toHaveLength(1);
      expect(reports[0].profile).toMatchObject({ id: "fixture-profile", version: "1.0.0" });
      expect(new Set(reports[0].findings.map((finding) => finding.provenance.kind)))
        .toEqual(new Set(["dream_edge", "threat_edge"]));
      expect(JSON.parse(await readFile(join(dataDir, "review_reports.json"), "utf8")).reports).toHaveLength(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("carries one composite report through the scheduled review_cycle action", async () => {
    const root = await mkdtemp(join(tmpdir(), "dreamgraph-scheduled-review-"));
    const dataDir = join(root, "data");
    const repo = join(root, "fixture-repo");
    const previousDataDir = getDataDir();
    const previousRepos = { ...appConfig.repos };
    try {
      await mkdir(repo, { recursive: true });
      await writeScheduledGraph(dataDir, repo);
      setDataDirOverride(dataDir);
      setDataDirResolver(() => dataDir);
      for (const key of Object.keys(appConfig.repos)) delete appConfig.repos[key];
      appConfig.repos["fixture-repo"] = repo;
      registerReviewProfile(profile);

      const schedule = await createSchedule({
        name: "fixture scheduled review",
        action: "review_cycle",
        parameters: { profile_id: profile.id },
        trigger_type: "interval",
        interval_ms: 1,
        max_runs: 1,
      });
      const execution = await runScheduleNow(schedule.id);

      expect(execution).toMatchObject({
        action: "review_cycle",
        success: true,
        outcome: "FOUND",
        finding_count: expect.any(Number),
        report_id: expect.stringMatching(/^report_/),
      });
      expect(execution.result_summary).toContain("review_cycle(fixture-profile): FOUND");

      const reports = await loadReviewReports(dataDir);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        report_id: execution.report_id,
        profile: {
          id: profile.id,
          role: profile.role,
          prompt: profile.prompt,
          output_schema: REVIEW_OUTPUT_SCHEMA,
        },
        context: { graph_version: "fixture-scheduled-v1", entity_count: 3 },
      });
      expect(new Set(reports[0].findings.map((finding) => finding.provenance.kind)))
        .toEqual(new Set(["dream_edge", "threat_edge"]));
    } finally {
      setDataDirOverride(previousDataDir);
      setDataDirResolver(() => appConfig.dataDir);
      for (const key of Object.keys(appConfig.repos)) delete appConfig.repos[key];
      Object.assign(appConfig.repos, previousRepos);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on a valid JSON report store with the wrong schema", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "dreamgraph-invalid-review-store-"));
    try {
      await writeFile(join(dataDir, "review_reports.json"), JSON.stringify({ schema: "wrong", reports: [] }));
      await expect(loadReviewReports(dataDir)).rejects.toThrow(/Review report store is invalid/);
      await expect(persistReviewReport(createReviewReport({
        profile,
        context: fixtureSnapshot().context,
        findings: [],
        outcome: "DRY",
        fleet_emission: fleetReviewEmission({}),
      }), dataDir)).rejects.toThrow(/Review report store is invalid/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps fleet emission off unless explicitly enabled", () => {
    expect(fleetReviewEmission({})).toMatchObject({ enabled: false, emitted: false });
    expect(fleetReviewEmission({ DREAMGRAPH_FLEET_REVIEW_EMIT_ENABLED: "true" })).toMatchObject({ enabled: true, emitted: false });
  });
});
