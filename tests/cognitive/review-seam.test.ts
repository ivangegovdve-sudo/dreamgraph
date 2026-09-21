import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_PROFILE,
  REVIEW_OUTPUT_SCHEMA,
  createReviewReport,
  fleetReviewEmission,
  getReviewProfile,
  loadReviewReports,
  persistReviewReport,
  runReviewProfile,
  serializeReviewReport,
  type ReviewProfile,
  type ReviewSnapshot,
} from "../../src/cognitive/review-seam.js";
import { securityEntitiesFromFactSnapshot } from "../../src/cognitive/adversarial.js";
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

  it("keeps fleet emission off unless explicitly enabled", () => {
    expect(fleetReviewEmission({})).toMatchObject({ enabled: false, emitted: false });
    expect(fleetReviewEmission({ DREAMGRAPH_FLEET_REVIEW_EMIT_ENABLED: "true" })).toMatchObject({ enabled: true, emitted: false });
  });
});
