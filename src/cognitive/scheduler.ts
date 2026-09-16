/**
 * DreamGraph v5.2 — Dream Scheduler
 *
 * Policy-driven temporal orchestration for cognitive actions.
 *
 * Scheduling modes:
 * A. Time interval  — run dream_cycle every 6 hours, nightmare_cycle daily
 * B. Cycle-based    — every 10 cycles run metacognition, every 50 generate digest
 * C. Idle-time      — if no manual activity in 30 min, run background dreaming
 * D. Cron-like      — hour/day granularity for predictable schedules
 *
 * Design decisions:
 * - In-process scheduler with persistence (no external daemons)
 * - If DreamGraph restarts, schedules reload; missed jobs logged, not replayed
 * - Deterministic: tick → evaluate → execute → persist
 * - Safety: max runs/hour, global cooldown, error streaks pause schedules
 *
 * "Dream freely. Schedule wisely. Execute deterministically."
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { existsSync } from "node:fs";
import { engine } from "./engine.js";
import { dataPath } from "../utils/paths.js";
import { getActiveScope } from "../instance/lifecycle.js";
import { updateInstanceCounters } from "../instance/index.js";
import { dream } from "./dreamer.js";
import {
  normalize,
  recordWeakConnectionTensions,
  resolveTensionsFromPromotedEdges,
} from "./normalizer.js";
import { nightmare } from "./adversarial.js";
import { runMetacognitiveAnalysis } from "./metacognition.js";
import { dispatchEvent } from "./event-router.js";
import { exportArchetypes } from "./federation.js";
import { maybeAutoNarrate, generateDiffChapter } from "./narrator.js";
import { graphEventBus } from "../graph/events.js";
import { logger } from "../utils/logger.js";
import { getLlmReadinessStatus } from "./llm-readiness.js";
import { getLlmProvider, getNormalizerLlmConfig } from "./llm.js";
import type { LlmMessage } from "./llm.js";
import { preflightGraphInputs } from "./cycle-input-gate.js";
import { formatCycleSummary } from "./cycle-outcome.js";
import type { CycleOutcome, ScheduleActionResult } from "./cycle-outcome.js";
import { emitDreamCycleVerdict, emitNightmareVerdict } from "./verdict-ledger.js";
import type { CycleInputReady } from "./cycle-input-gate.js";
import type { TensionResolutionCandidate, TensionResolutionStrategy, TensionSignal } from "./types.js";
import { withFileLock } from "../utils/mutex.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./types.js";
import type {
  DreamSchedule,
  ScheduleExecution,
  ScheduleFile,
  SchedulerConfig,
  ScheduleAction,
  ScheduleTriggerType,
  ScheduleStatus,
  DreamHistoryEntry,
  DreamStrategy,
  AdversarialStrategy,
} from "./types.js";

// ---------------------------------------------------------------------------
// Per-action parameter schemas (F-01)
//
// `DreamSchedule.parameters` is an open `Record<string, unknown>` because
// schedules are persisted to JSON. We validate the shape at the top of each
// `executeAction` case so the action body can use strongly-typed values.
// ---------------------------------------------------------------------------

const DREAM_STRATEGIES = [
  "gap_detection",
  "weak_reinforcement",
  "cross_domain",
  "missing_abstraction",
  "symmetry_completion",
  "tension_directed",
  "reflective",
  "causal_replay",
  "pgo_wave",
  "llm_dream",
  "orphan_bridging",
  "schema_grounding",
  "all",
] as const satisfies readonly DreamStrategy[];

const ADVERSARIAL_STRATEGIES = [
  "privilege_escalation",
  "data_leak_path",
  "injection_surface",
  "missing_validation",
  "broken_access_control",
  "all_threats",
] as const satisfies readonly AdversarialStrategy[];

const DreamCycleParamsSchema = z.object({
  strategy: z.enum(DREAM_STRATEGIES).default("all"),
  max_dreams: z.number().int().positive().default(100),
  focus_entities: z.array(z.string().min(1)).max(100).default([]),
  focus_hops: z.number().int().min(1).max(4).default(2),
  focus_reason: z.string().max(500).optional(),
});

const NightmareCycleParamsSchema = z.object({
  strategy: z.enum(ADVERSARIAL_STRATEGIES).default("all_threats"),
});

const MetacognitiveParamsSchema = z.object({
  window_size: z.number().int().min(5).max(500).default(50),
  auto_apply: z.boolean().default(false),
});

const FederationExportParamsSchema = z.object({
  /** Optional destination override. Absolute or relative to the instance data dir. */
  export_path: z.string().trim().min(1).optional(),
});

const DispatchEventParamsSchema = z.object({
  source: z
    .enum([
      "git_webhook",
      "ci_cd",
      "runtime_anomaly",
      "tension_threshold",
      "federation_import",
      "manual",
    ])
    .default("manual"),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).default("info"),
  description: z.string().optional(),
  affected_entities: z.array(z.string()).default([]),
  payload: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Parse `schedule.parameters` against a per-action schema. On failure we log a
 * warning and fall back to the schema defaults — schedules should be resilient
 * (a malformed param shouldn't kill the daemon's tick loop), but the warning
 * makes drift visible.
 */
function parseScheduleParams<S extends z.ZodTypeAny>(
  schedule: DreamSchedule,
  schema: S,
): z.infer<S> {
  const parsed = schema.safeParse(schedule.parameters ?? {});
  if (parsed.success) {
    return parsed.data;
  }
  logger.warn(
    `[scheduler] Schedule '${schedule.id}' (${schedule.action}) has invalid parameters: ` +
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  );
  // Fall back to schema defaults by parsing an empty object.
  return schema.parse({}) as z.infer<S>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const schedulesPath = () => dataPath("schedules.json");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let config: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG };
let tickTimer: ReturnType<typeof setInterval> | null = null;
let runsThisHour = 0;
let hourWindowStart = Date.now();
let lastRunTimestamp = 0;
let lastActivityTimestamp = Date.now();

// Schedules currently being executed (outside the file lock). Prevents the
// next tick from re-claiming a schedule whose long-running action has not yet
// finished writing back its results. Keyed by schedule.id.
const inFlightSchedules = new Set<string>();

// Separate mutex key used to serialise cognitive `executeAction` runs.
// Held independently from the `schedules.json` file lock so that UI calls
// (updateSchedule / getSchedules / deleteSchedule) are never blocked while
// an LLM-bound action is in flight. See the lifecycle comment on `tick()`
// for the full rationale.
const SCHEDULER_EXEC_LOCK = "scheduler.execution";

/**
 * Run `executeAction` with a hard wall-clock timeout.
 *
 * A misbehaving LLM client or hung HTTP socket can leave a `dream_cycle`
 * (or any other action) waiting forever. Without this guard, a single hang
 * silently freezes the scheduler: the cognitive-execution mutex is never
 * released, every following tick finds it locked, and the next manual
 * `Run`/`Resume` button waits indefinitely too. The dashboard symptom is
 * "schedule active, 0 runs, never advances" — exactly what triggered the
 * bug report.
 *
 * On timeout we reject with a descriptive error so the surrounding
 * try/catch records a failed execution and bumps `error_count`. The
 * underlying action promise is left to settle on its own; we cannot truly
 * cancel a Node Promise, but we no longer wait for it.
 */
async function executeActionWithTimeout(schedule: DreamSchedule): Promise<ScheduleActionResult> {
  const timeoutMs = Math.max(1_000, config.execution_timeout_ms);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        `executeAction timeout after ${timeoutMs}ms ` +
        `(schedule="${schedule.name}", action=${schedule.action})`
      ));
    }, timeoutMs);
    if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
  });
  try {
    return await Promise.race([executeAction(schedule), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Schedule File I/O
// ---------------------------------------------------------------------------

function emptyScheduleFile(): ScheduleFile {
  return {
    metadata: {
      description: "Dream Scheduler — persistent schedule registry and execution log.",
      schema_version: "1.0.0",
      total_schedules: 0,
      total_executions: 0,
      last_tick: null,
    },
    schedules: [],
    executions: [],
  };
}

async function loadScheduleFile(): Promise<ScheduleFile> {
  try {
    if (!existsSync(schedulesPath())) return emptyScheduleFile();
    const raw = await readFile(schedulesPath(), "utf-8");
    const p = JSON.parse(raw);
    const e = emptyScheduleFile();
    return {
      metadata: { ...e.metadata, ...(p.metadata && typeof p.metadata === "object" ? p.metadata : {}) },
      schedules: Array.isArray(p.schedules) ? p.schedules : [],
      executions: Array.isArray(p.executions) ? p.executions : [],
    };
  } catch {
    return emptyScheduleFile();
  }
}

async function saveScheduleFile(file: ScheduleFile): Promise<void> {
  file.metadata.total_schedules = file.schedules.length;
  file.metadata.total_executions = file.executions.length;
  // Stamp instance UUID when running in instance mode
  const scope = getActiveScope();
  if (scope) file.metadata.instance_uuid = scope.uuid;
  await atomicWriteFile(schedulesPath(), JSON.stringify(file, null, 2));
}

// ---------------------------------------------------------------------------
// Safety Guards
// ---------------------------------------------------------------------------

function resetHourWindowIfNeeded(): void {
  const now = Date.now();
  if (now - hourWindowStart > 3_600_000) {
    hourWindowStart = now;
    runsThisHour = 0;
  }
}

function getScheduleSkipReason(schedule: DreamSchedule, now = Date.now()): string | null {
  resetHourWindowIfNeeded();

  if (!config.enabled) return "scheduler_disabled";
  if (!schedule.enabled) return "schedule_disabled";
  if (schedule.status !== "active") return `status_${schedule.status}`;
  if (runsThisHour >= config.max_runs_per_hour) return "rate_limit";
  if (now - lastRunTimestamp < config.global_cooldown_ms) return "global_cooldown";
  if (schedule.action === "nightmare_cycle" && now - lastRunTimestamp < config.nightmare_cooldown_ms) {
    return "nightmare_cooldown";
  }
  if (schedule.max_runs !== null && schedule.run_count >= schedule.max_runs) return "max_runs";
  if (schedule.error_count >= config.max_error_streak) return "error_streak";
  return null;
}

function canRunSchedule(schedule: DreamSchedule, now = Date.now()): boolean {
  const reason = getScheduleSkipReason(schedule, now);
  if (reason === "rate_limit") {
    logger.warn(`Scheduler: rate limit reached (${config.max_runs_per_hour}/hr)`);
  }
  return reason === null;
}

// ---------------------------------------------------------------------------
// Due Evaluation
// ---------------------------------------------------------------------------

function isDue(schedule: DreamSchedule, now: number): boolean {
  if (!schedule.enabled || schedule.status !== "active") return false;

  switch (schedule.trigger_type) {
    case "interval": {
      if (!schedule.interval_ms) return false;
      if (!schedule.last_run_at) return true; // never run — due immediately
      const elapsed = now - new Date(schedule.last_run_at).getTime();
      return elapsed >= schedule.interval_ms;
    }

    case "cron_like": {
      if (!schedule.cron) return false;
      return isCronDue(schedule.cron, schedule.last_run_at, now);
    }

    case "after_cycles": {
      // Evaluated separately via notifyCycleComplete — not in tick loop
      return false;
    }

    case "on_idle": {
      if (!schedule.idle_ms) return false;
      const idleDuration = now - lastActivityTimestamp;
      if (idleDuration < schedule.idle_ms) return false;
      // Don't re-fire if already ran during this idle period
      if (schedule.last_run_at) {
        const lastRun = new Date(schedule.last_run_at).getTime();
        if (lastRun > lastActivityTimestamp) return false;
      }
      return true;
    }

    default:
      return false;
  }
}

/**
 * Simple cron-like evaluator. Supports: "minute hour day-of-month month day-of-week"
 * Uses "*" for any. Only checks if the CURRENT UTC time matches and not already run this period.
 * All comparisons use UTC methods to stay consistent with ISO-string timestamps.
 */
function isCronDue(cron: string, lastRun: string | null, now: number): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;

  const date = new Date(now);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  const matches = (field: string, value: number): boolean => {
    if (field === "*") return true;
    // Support comma-separated values
    return field.split(",").some((v) => parseInt(v, 10) === value);
  };

  if (!matches(minute, date.getUTCMinutes())) return false;
  if (!matches(hour, date.getUTCHours())) return false;
  if (!matches(dayOfMonth, date.getUTCDate())) return false;
  if (!matches(month, date.getUTCMonth() + 1)) return false;
  if (!matches(dayOfWeek, date.getUTCDay())) return false;

  // Check we haven't already run in this matching window (same UTC minute)
  if (lastRun) {
    const lastDate = new Date(lastRun);
    if (
      lastDate.getUTCFullYear() === date.getUTCFullYear() &&
      lastDate.getUTCMonth() === date.getUTCMonth() &&
      lastDate.getUTCDate() === date.getUTCDate() &&
      lastDate.getUTCHours() === date.getUTCHours() &&
      lastDate.getUTCMinutes() === date.getUTCMinutes()
    ) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Action Execution
// ---------------------------------------------------------------------------

async function executeAction(schedule: DreamSchedule): Promise<ScheduleActionResult> {
  let cycleInput: CycleInputReady | undefined;
  if (schedule.action === "dream_cycle" || schedule.action === "nightmare_cycle") {
    const input = await preflightGraphInputs();
    if (input.status === "UNKNOWN") {
      const strategy = typeof schedule.parameters?.strategy === "string"
        ? schedule.parameters.strategy
        : schedule.action === "dream_cycle" ? "all" : "all_threats";
      return {
        summary: formatCycleSummary(schedule.action, strategy, "UNKNOWN", undefined, input.message),
        outcome: "UNKNOWN",
        graph_version: input.graph_version,
      };
    }
    cycleInput = input;
  }
  switch (schedule.action) {
    case "dream_cycle": {
      const params = parseScheduleParams(schedule, DreamCycleParamsSchema);
      const strategy = params.strategy;
      const maxDreams = params.max_dreams;

      // Execute a full dream cycle internally
      if (engine.getState() !== "awake") await engine.interrupt();
      engine.enterRem();
      const decayResult = await engine.applyDecay();
      const tensionDecay = await engine.applyTensionDecay();
      const dreamResult = await dream(strategy, maxDreams, {
        entity_ids: params.focus_entities,
        hops: params.focus_hops,
        reason: params.focus_reason,
      });

      engine.enterNormalizing();
      const normResult = await normalize();

      // --- Tension creation from normalizer's tension candidates ---
      let tensionsCreated = 0;
      let tensionsResolved = 0;

      tensionsCreated = await recordWeakConnectionTensions(
        normResult.tensionCandidates,
        "scheduler"
      );

      // --- Resolve tensions when promoted edges address them ---
      tensionsResolved = await resolveTensionsFromPromotedEdges(
        normResult.promotedEdges,
        "scheduler"
      );

      engine.wake();

      // Record history
      const entry: DreamHistoryEntry = {
        session_id: `sched_${schedule.id}_${Date.now()}`,
        cycle_number: engine.getCurrentDreamCycle(),
        timestamp: new Date().toISOString(),
        strategy,
        duration_ms: 0,
        generated_edges: dreamResult.edges.length,
        generated_nodes: dreamResult.nodes.length,
        duplicates_merged: dreamResult.duplicates_merged,
        decayed_edges: decayResult.decayedEdges,
        decayed_nodes: decayResult.decayedNodes,
        normalization: {
          validated: normResult.validated,
          latent: normResult.latent,
          rejected: normResult.rejected,
          promoted: normResult.promotedEdges.length,
          promoted_entities: normResult.promotedNodes,
          blocked_by_gate: normResult.blockedByGate,
          // Entity-level detail so cycles don't run blind
          promoted_details: normResult.promotedEdges.map(e => ({
            id: e.id,
            from: e.from,
            to: e.to,
            relation: e.relation,
            confidence: e.confidence,
          })),
          tension_details: normResult.tensionCandidates.map(tc => ({
            from: tc.from,
            to: tc.to,
            reason: tc.reason,
            confidence: tc.confidence,
          })),
        },
        tension_signals_created: tensionsCreated,
        tension_signals_resolved: tensionsResolved,
        tensions_expired: tensionDecay.expired,
        tensions_decayed: tensionDecay.decayed,
        per_strategy_yields:
          strategy === "all" && dreamResult.strategy_yields
            ? { ...dreamResult.strategy_yields }
            : undefined,
      };
      await engine.appendHistoryEntry(entry);

      // Persist cycle counter to instance state
      try {
        await updateInstanceCounters({
          total_dream_cycles: engine.getCurrentDreamCycle(),
        });
      } catch { /* non-critical */ }

      // Post-cycle hooks
      try { await maybeAutoNarrate(); } catch { /* swallow */ }

      // Phase 4 #8 — tension resolution lifecycle. Best-effort: never block
      // the dream cycle's success summary on resolver failures.
      // v8.2.6 — when LLM is ready, build a proposer that asks the model for
      // a strategy + rationale; falls back to the heuristic on any error.
      let resolverSummary = "";
      try {
        const llmReady = getLlmReadinessStatus()?.state === "ready";
        const proposer = llmReady
          ? async (sig: TensionSignal) => {
              try {
                const llm = getLlmProvider();
                const cfg = getNormalizerLlmConfig();
                const messages: LlmMessage[] = [
                  {
                    role: "system",
                    content:
                      "You are the DreamGraph tension resolver. Pick the best strategy for closing a tension. " +
                      "Respond ONLY with strict JSON: {\"strategy\":\"merge|mediator|split|reframe|wont_fix\",\"rationale\":\"...\",\"validation_window\":1-5}.",
                  },
                  {
                    role: "user",
                    content:
                      `Tension type: ${sig.type}\n` +
                      `Description: ${sig.description}\n` +
                      `Entities: ${sig.entities.join(", ")}\n` +
                      `Urgency: ${sig.urgency.toFixed(2)}`,
                  },
                ];
                const resp = await llm.complete(messages, {
                  model: cfg.model,
                  temperature: cfg.temperature,
                  maxTokens: 400,
                  jsonMode: true,
                });
                const parsed = JSON.parse(resp.text) as {
                  strategy?: string;
                  rationale?: string;
                  validation_window?: number;
                };
                const allowed: TensionResolutionStrategy[] = ["merge", "mediator", "split", "reframe", "wont_fix"];
                if (!parsed.strategy || !allowed.includes(parsed.strategy as TensionResolutionStrategy)) {
                  return null;
                }
                const candidate: Omit<TensionResolutionCandidate, "proposed_at"> = {
                  strategy: parsed.strategy as TensionResolutionStrategy,
                  rationale: typeof parsed.rationale === "string" && parsed.rationale.trim()
                    ? parsed.rationale.trim()
                    : "LLM proposal (no rationale provided)",
                  validation_window: Math.min(5, Math.max(1, Math.floor(parsed.validation_window ?? 3))),
                  source: "llm",
                };
                return candidate;
              } catch (err) {
                logger.warn(
                  `dream_cycle: LLM tension proposer failed for ${sig.id} — falling back. ` +
                  `Error: ${err instanceof Error ? err.message : err}`
                );
                return null;
              }
            }
          : undefined;
        const proposeResult = await engine.runTensionResolverCycle({ maxSamples: 5, proposer });
        const validateResult = await engine.validateResolutionCandidates();
        resolverSummary =
          `, resolver(proposed=${proposeResult.proposed}, ` +
          `auto_applied=${proposeResult.auto_applied}, ` +
          `confirmed=${validateResult.confirmed}, ` +
          `wont_fix=${validateResult.accepted_wont_fix}, ` +
          `escalated=${validateResult.escalated})`;
      } catch (err) {
        logger.warn(
          `dream_cycle: tension resolver pass failed — continuing. ` +
          `Error: ${err instanceof Error ? err.message : err}`
        );
      }

      if (engine.getState() !== "awake") await engine.interrupt();

      await emitDreamCycleVerdict({
        nodes: dreamResult.nodes,
        edges: dreamResult.edges,
        outcome: dreamResult.outcome,
        graph_version: cycleInput!.graph_version,
      });

      return {
        summary: `dream_cycle(${strategy}${dreamResult.focus_entities.length > 0 ? `, focus=${dreamResult.focus_entities.length}` : ""}): ${dreamResult.outcome}, ${dreamResult.edges.length} edges, ${normResult.promotedEdges.length} promoted, ${normResult.rejected} rejected${resolverSummary}`,
        outcome: dreamResult.outcome,
        finding_count: dreamResult.edges.length + dreamResult.nodes.length,
        graph_version: cycleInput!.graph_version,
      };
    }

    case "nightmare_cycle": {
      const params = parseScheduleParams(schedule, NightmareCycleParamsSchema);
      const strategy = params.strategy;

      if (engine.getState() !== "awake") await engine.interrupt();
      engine.enterNightmare();
      const result = await nightmare(strategy, cycleInput!.graph_version);
      engine.wakeFromNightmare();

      await emitNightmareVerdict(result);

      if (engine.getState() !== "awake") await engine.interrupt();

      return {
        summary: formatCycleSummary("nightmare_cycle", strategy, result.outcome, result.threats_found.length),
        outcome: result.outcome,
        finding_count: result.threats_found.length,
        graph_version: result.graph_version,
      };
    }

    case "metacognitive_analysis": {
      const params = parseScheduleParams(schedule, MetacognitiveParamsSchema);
      const entry = await runMetacognitiveAnalysis(params.window_size, params.auto_apply);
      return { summary: `metacognition: ${entry.overall_health}, ${entry.threshold_recommendations.length} recommendations` };
    }

    case "dispatch_cognitive_event": {
      const params = parseScheduleParams(schedule, DispatchEventParamsSchema);
      const event = {
        id: `sched_evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        source: params.source,
        severity: params.severity,
        timestamp: new Date().toISOString(),
        payload: params.payload,
        affected_entities: params.affected_entities,
        description: params.description ?? `Scheduled event from ${schedule.name}`,
      };
      const logEntry = await dispatchEvent(event);
      return { summary: `event dispatched: ${logEntry.result.action_taken}` };
    }

    case "narrative_chapter": {
      const chapter = await generateDiffChapter();
      if (chapter) {
        return { summary: `narrative chapter ${chapter.chapter_number} generated: "${chapter.title}"` };
      }
      return { summary: "narrative chapter: no significant changes to narrate" };
    }

    case "federation_export": {
      const params = parseScheduleParams(schedule, FederationExportParamsSchema);
      const result = await exportArchetypes(params.export_path);
      return { summary: `federation export: ${result.archetypes_exported} archetypes → ${result.file_path}` };
    }

    case "graph_maintenance": {
      // Decay pass + tension decay without new dreaming
      if (engine.getState() !== "awake") await engine.interrupt();
      engine.enterRem();
      const decayResult = await engine.applyDecay();
      const tensionDecay = await engine.applyTensionDecay();
      await engine.interrupt(); // skip normalization

      return { summary: `maintenance: ${decayResult.decayedEdges} edges decayed, ${decayResult.decayedNodes} nodes decayed, ${tensionDecay.expired} tensions expired` };
    }

    default:
      throw new Error(`Unknown schedule action: ${schedule.action}`);
  }
}

// ---------------------------------------------------------------------------
// Tick Loop
//
// The scheduler must remain UI-responsive even while a long-running cognitive
// action (dream_cycle, nightmare_cycle, metacognitive_analysis, …) is
// executing. Many actions make LLM calls that take tens of seconds.
//
// Lock discipline:
//   1. Phase 1 — short `schedules.json` lock to read the file, pick due
//      schedules, mark them as "claimed" (advance last_run_at + run_count,
//      add to in-flight set), and write the file back. The lock is released
//      before any cognitive work starts.
//   2. Phase 2 — `executeAction` runs without the file lock, serialised by
//      a separate `scheduler.execution` mutex so that two cognitive actions
//      do not race on shared engine state.
//   3. Phase 3 — short `schedules.json` lock to write back the execution
//      result (success/error, summary, error streak, history append).
//
// This means UI calls that only touch the JSON (`updateSchedule`,
// `deleteSchedule`, `getSchedules`) acquire the file lock for milliseconds
// even while a 30 s LLM call is in flight.
// ---------------------------------------------------------------------------

/** Snapshot of a schedule claimed by phase 1, used by phase 2/3. */
interface ScheduleClaim {
  scheduleId: string;
  scheduleName: string;
  action: ScheduleAction;
  startTime: number;
  /** Frozen copy used by executeAction so it sees stable parameters. */
  schedule: DreamSchedule;
}

async function tick(): Promise<void> {
  // -------- Phase 1: claim due schedules under the file lock --------
  const claims = await withFileLock("schedules.json", async () => {
    const now = Date.now();
    const file = await loadScheduleFile();
    const out: ScheduleClaim[] = [];

    for (const schedule of file.schedules) {
      let skipReason: string | null = null;
      if (inFlightSchedules.has(schedule.id)) skipReason = "in_flight";
      else if (!isDue(schedule, now)) skipReason = getScheduleSkipReason(schedule, now) ?? "not_due";
      else skipReason = getScheduleSkipReason(schedule, now);

      if (skipReason) {
        if (schedule.last_skip_reason !== skipReason) {
          schedule.last_skip_reason = skipReason;
          schedule.updated_at = new Date(now).toISOString();
        }
        graphEventBus.emit("schedule.skipped", {
          affected_ids: [schedule.id],
          payload: {
            schedule_id: schedule.id,
            schedule_name: schedule.name,
            action: schedule.action,
            reason: skipReason,
          },
        });
        continue;
      }

      // Reserve the schedule: advance last_run_at so subsequent ticks see it
      // as not-due, bump the in-flight set so even an interval shorter than
      // the action duration cannot re-claim it. The actual run_count and
      // execution record are written back in phase 3.
      schedule.last_run_at = new Date(now).toISOString();
      schedule.updated_at = schedule.last_run_at;
      schedule.last_skip_reason = null;
      computeNextRun(schedule);
      inFlightSchedules.add(schedule.id);

      runsThisHour++;
      lastRunTimestamp = now;
      graphEventBus.emit("schedule.claimed", {
        affected_ids: [schedule.id],
        payload: {
          schedule_id: schedule.id,
          schedule_name: schedule.name,
          action: schedule.action,
          triggered_at: schedule.last_run_at,
        },
      });

      out.push({
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        action: schedule.action,
        startTime: now,
        schedule: { ...schedule },
      });
    }

    file.metadata.last_tick = new Date().toISOString();
    await saveScheduleFile(file);
    return out;
  });

  if (claims.length === 0) return;

  // -------- Phase 2 + 3: execute outside the file lock --------
  await Promise.all(
    claims.map((claim) =>
      runClaimedSchedule(claim, "exec").catch((err) => {
        logger.error(`Scheduler runClaimedSchedule unexpected failure: ${err}`);
      }),
    ),
  );
}

/**
 * Run a claimed schedule outside the `schedules.json` lock.
 *
 * Cognitive actions are serialised globally by SCHEDULER_EXEC_LOCK so they
 * cannot trample shared engine state. Result write-back briefly re-acquires
 * the file lock.
 */
async function runClaimedSchedule(
  claim: ScheduleClaim,
  idPrefix: "exec" | "exec_cycle"
): Promise<void> {
  let resultSummary = "";
  let success = true;
  let errorMsg: string | undefined;
  let outcome: CycleOutcome | undefined;
  let findingCount: number | undefined;
  let graphVersion: string | undefined;

  try {
    await withFileLock(SCHEDULER_EXEC_LOCK, async () => {
      try {
        logger.info(`Scheduler executing: ${claim.scheduleName} (${claim.action})`);
        const result = await executeActionWithTimeout(claim.schedule);
        resultSummary = result.summary;
        outcome = result.outcome;
        findingCount = result.finding_count;
        graphVersion = result.graph_version;
        if (outcome === "UNKNOWN") {
          success = false;
          errorMsg = result.summary;
        }
      } catch (err) {
        success = false;
        if (claim.action === "dream_cycle" || claim.action === "nightmare_cycle") outcome = "UNKNOWN";
        if (claim.action === "dream_cycle" || claim.action === "nightmare_cycle") {
          if (engine.getState() !== "awake") await engine.interrupt().catch(() => {});
        }
        errorMsg = err instanceof Error ? err.message : String(err);
        resultSummary = `Error: ${errorMsg}`;
        logger.error(`Scheduler error for ${claim.scheduleName}: ${errorMsg}`);
      }
    });
  } finally {
    // Always run phase 3, even if executeAction threw before completing.
    try {
      await writeBackExecution(claim, idPrefix, success, resultSummary, errorMsg, outcome, findingCount, graphVersion);
    } finally {
      inFlightSchedules.delete(claim.scheduleId);
    }
  }
}

async function writeBackExecution(
  claim: ScheduleClaim,
  idPrefix: "exec" | "exec_cycle",
  success: boolean,
  resultSummary: string,
  errorMsg: string | undefined,
  outcome?: CycleOutcome,
  findingCount?: number,
  graphVersion?: string,
): Promise<void> {
  await withFileLock("schedules.json", async () => {
    const file = await loadScheduleFile();
    const schedule = file.schedules.find((s) => s.id === claim.scheduleId);
    const completedAt = new Date();
    const duration = completedAt.getTime() - claim.startTime;
    const executionId = `${idPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    if (schedule) {
      if (success) {
        schedule.error_count = 0;
        schedule.last_error = null;
      } else {
        schedule.error_count++;
        schedule.last_error = errorMsg ?? "unknown error";
        if (errorMsg?.includes("executeAction timeout after")) {
          graphEventBus.emit("schedule.timed_out", {
            affected_ids: [schedule.id],
            payload: {
              schedule_id: schedule.id,
              schedule_name: schedule.name,
              action: schedule.action,
              error: errorMsg,
            },
          });
        }
        if (schedule.error_count >= config.max_error_streak) {
          schedule.status = "error";
          schedule.enabled = false;
          graphEventBus.emit("schedule.paused", {
            affected_ids: [schedule.id],
            payload: {
              schedule_id: schedule.id,
              schedule_name: schedule.name,
              action: schedule.action,
              reason: "error_streak",
              error_count: schedule.error_count,
            },
          });
          logger.warn(
            `Schedule "${schedule.name}" paused after ${schedule.error_count} consecutive errors`
          );
        }
      }
      schedule.run_count++;
      schedule.updated_at = completedAt.toISOString();
      computeNextRun(schedule);

      if (schedule.max_runs !== null && schedule.run_count >= schedule.max_runs) {
        schedule.status = "exhausted";
        schedule.enabled = false;
      }

      graphEventBus.emit("schedule.executed", {
        affected_ids: [schedule.id],
        payload: {
          schedule_id: schedule.id,
          schedule_name: schedule.name,
          action: schedule.action,
          execution_id: executionId,
          success,
          duration_ms: duration,
          status: schedule.status,
          error: errorMsg ?? null,
          outcome: outcome ?? null,
          finding_count: findingCount ?? null,
          graph_version: graphVersion ?? null,
        },
      });
    }

    const execution: ScheduleExecution = {
      id: executionId,
      schedule_id: claim.scheduleId,
      schedule_name: claim.scheduleName,
      action: claim.action,
      triggered_at: new Date(claim.startTime).toISOString(),
      completed_at: completedAt.toISOString(),
      duration_ms: duration,
      success,
      result_summary: resultSummary,
      ...(outcome ? { outcome } : {}),
      ...(findingCount !== undefined ? { finding_count: findingCount } : {}),
      ...(graphVersion ? { graph_version: graphVersion } : {}),
      error: errorMsg,
      ...(getActiveScope() && { instance_uuid: getActiveScope()!.uuid }),
    };
    file.executions.push(execution);

    if (file.executions.length > config.max_history) {
      file.executions = file.executions.slice(-config.max_history);
    }

    await saveScheduleFile(file);
  });
}

function computeNextRun(schedule: DreamSchedule): void {
  if (!schedule.enabled || schedule.status !== "active") {
    schedule.next_run_at = null;
    return;
  }

  const now = Date.now();

  switch (schedule.trigger_type) {
    case "interval":
      schedule.next_run_at = schedule.interval_ms
        ? new Date(now + schedule.interval_ms).toISOString()
        : null;
      break;

    case "after_cycles":
      schedule.next_run_at = null; // cycle-triggered, not time-based
      break;

    case "on_idle":
      schedule.next_run_at = null; // idle-triggered, not predictable
      break;

    case "cron_like":
      // Approximate next run — just mark as "scheduled"
      schedule.next_run_at = null; // cron evaluated at tick time
      break;
  }
}

// ---------------------------------------------------------------------------
// Cycle-Based Trigger Hook
// ---------------------------------------------------------------------------

/**
 * Called after each dream_cycle completion.
 * Evaluates "after_cycles" schedules.
 */
export async function notifyCycleComplete(cycleNumber: number): Promise<void> {
  // Same lock discipline as `tick()`: claim cycle-triggered schedules under
  // the file lock, then run them outside it. See the lifecycle comment on
  // `tick()` for the rationale.
  const claims = await withFileLock("schedules.json", async () => {
    const file = await loadScheduleFile();
    const out: ScheduleClaim[] = [];
    const now = Date.now();

    for (const schedule of file.schedules) {
      if (inFlightSchedules.has(schedule.id)) continue;
      if (!schedule.enabled || schedule.status !== "active") continue;
      if (schedule.trigger_type !== "after_cycles") continue;
      if (!schedule.cycle_interval) continue;
      if (!canRunSchedule(schedule)) continue;

      const cyclesSinceLast = cycleNumber - schedule.last_cycle_checked;
      if (cyclesSinceLast < schedule.cycle_interval) continue;

      schedule.last_cycle_checked = cycleNumber;
      schedule.last_run_at = new Date(now).toISOString();
      schedule.updated_at = schedule.last_run_at;
      inFlightSchedules.add(schedule.id);

      runsThisHour++;
      lastRunTimestamp = now;

      out.push({
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        action: schedule.action,
        startTime: now,
        schedule: { ...schedule },
      });
    }

    if (out.length > 0) {
      await saveScheduleFile(file);
    }
    return out;
  });

  for (const claim of claims) {
    runClaimedSchedule(claim, "exec_cycle").catch((err) => {
      logger.error(`Scheduler runClaimedSchedule (cycle) unexpected failure: ${err}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Activity Tracking (for idle triggers)
// ---------------------------------------------------------------------------

/** Call this whenever manual MCP tool activity occurs */
export function recordActivity(): void {
  lastActivityTimestamp = Date.now();
}

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

export async function createSchedule(opts: {
  name: string;
  action: ScheduleAction;
  parameters?: Record<string, unknown>;
  trigger_type: ScheduleTriggerType;
  interval_ms?: number;
  cron?: string;
  cycle_interval?: number;
  idle_ms?: number;
  enabled?: boolean;
  max_runs?: number | null;
}): Promise<DreamSchedule> {
  return withFileLock("schedules.json", async () => {
    const file = await loadScheduleFile();
    const now = new Date().toISOString();

    const schedule: DreamSchedule = {
      id: `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: opts.name,
      action: opts.action,
      parameters: opts.parameters ?? {},
      trigger_type: opts.trigger_type,
      interval_ms: opts.interval_ms,
      cron: opts.cron,
      cycle_interval: opts.cycle_interval,
      idle_ms: opts.idle_ms,
      enabled: opts.enabled ?? true,
      status: "active",
      last_run_at: null,
      next_run_at: null,
      run_count: 0,
      max_runs: opts.max_runs ?? null,
      last_cycle_checked: engine.getCurrentDreamCycle(),
      error_count: 0,
      last_error: null,
      last_skip_reason: null,
      created_at: now,
      updated_at: now,
    };

    computeNextRun(schedule);
    file.schedules.push(schedule);
    await saveScheduleFile(file);

    logger.info(`Schedule created: "${schedule.name}" (${schedule.action}, ${schedule.trigger_type})`);
    return schedule;
  });
}

export async function updateSchedule(
  scheduleId: string,
  updates: Partial<Pick<DreamSchedule,
    "name" | "enabled" | "parameters" | "interval_ms" | "cron" |
    "cycle_interval" | "idle_ms" | "max_runs"
  >>
): Promise<DreamSchedule | null> {
  return withFileLock("schedules.json", async () => {
    const file = await loadScheduleFile();
    const schedule = file.schedules.find((s) => s.id === scheduleId);
    if (!schedule) return null;

    if (updates.name !== undefined) schedule.name = updates.name;
    if (updates.enabled !== undefined) {
      schedule.enabled = updates.enabled;
      // Re-enable resets error state
      if (updates.enabled && schedule.status === "error") {
        schedule.status = "active";
        schedule.error_count = 0;
        schedule.last_error = null;
      }
      if (!updates.enabled && schedule.status === "active") {
        schedule.status = "paused";
      }
      if (updates.enabled && schedule.status === "paused") {
        schedule.status = "active";
      }
    }
    if (updates.parameters !== undefined) schedule.parameters = updates.parameters;
    if (updates.interval_ms !== undefined) schedule.interval_ms = updates.interval_ms;
    if (updates.cron !== undefined) schedule.cron = updates.cron;
    if (updates.cycle_interval !== undefined) schedule.cycle_interval = updates.cycle_interval;
    if (updates.idle_ms !== undefined) schedule.idle_ms = updates.idle_ms;
    if (updates.max_runs !== undefined) schedule.max_runs = updates.max_runs;

    schedule.updated_at = new Date().toISOString();
    computeNextRun(schedule);
    await saveScheduleFile(file);

    logger.info(`Schedule updated: "${schedule.name}" (${schedule.id})`);
    return schedule;
  });
}

export async function deleteSchedule(scheduleId: string): Promise<boolean> {
  return withFileLock("schedules.json", async () => {
    const file = await loadScheduleFile();
    const idx = file.schedules.findIndex((s) => s.id === scheduleId);
    if (idx === -1) return false;

    const removed = file.schedules.splice(idx, 1)[0];
    await saveScheduleFile(file);

    logger.info(`Schedule deleted: "${removed.name}" (${removed.id})`);
    return true;
  });
}

export async function runScheduleNow(scheduleId: string): Promise<ScheduleExecution> {
  // Phase 1: snapshot the schedule under the file lock and stamp it as
  // in-flight so a concurrent tick cannot also pick it up. Released before
  // executeAction starts so UI calls remain responsive even if the action
  // takes 30+ seconds (LLM round-trip).
  const snapshot = await withFileLock("schedules.json", async () => {
    const file = await loadScheduleFile();
    const schedule = file.schedules.find((s) => s.id === scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    if (inFlightSchedules.has(scheduleId)) {
      throw new Error(`Schedule already running: ${schedule.name}`);
    }
    inFlightSchedules.add(scheduleId);
    const claim: ScheduleClaim = {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      action: schedule.action,
      startTime: Date.now(),
      schedule: { ...schedule },
    };
    return claim;
  });

  // Phase 2: execute under the cognitive-execution mutex (no file lock).
  let resultSummary = "";
  let success = true;
  let errorMsg: string | undefined;
  let outcome: CycleOutcome | undefined;
  let findingCount: number | undefined;
  let graphVersion: string | undefined;

  try {
    await withFileLock(SCHEDULER_EXEC_LOCK, async () => {
      try {
        logger.info(`Scheduler (forced): ${snapshot.scheduleName} (${snapshot.action})`);
        const result = await executeActionWithTimeout(snapshot.schedule);
        resultSummary = result.summary;
        outcome = result.outcome;
        findingCount = result.finding_count;
        graphVersion = result.graph_version;
        if (outcome === "UNKNOWN") {
          success = false;
          errorMsg = result.summary;
        }
      } catch (err) {
        success = false;
        if (snapshot.action === "dream_cycle" || snapshot.action === "nightmare_cycle") outcome = "UNKNOWN";
        if (snapshot.action === "dream_cycle" || snapshot.action === "nightmare_cycle") {
          if (engine.getState() !== "awake") await engine.interrupt().catch(() => {});
        }
        errorMsg = err instanceof Error ? err.message : String(err);
        resultSummary = `Error: ${errorMsg}`;
      }
    });
  } finally {
    inFlightSchedules.delete(scheduleId);
  }

  // Phase 3: write the execution record back. We rebuild the execution
  // object here (rather than relying on writeBackExecution) so we can return
  // the manual-execution id with its `_manual_` infix, preserving the
  // public surface of this function.
  return withFileLock("schedules.json", async () => {
    const file = await loadScheduleFile();
    const schedule = file.schedules.find((s) => s.id === scheduleId);
    const completedAt = new Date();
    const duration = completedAt.getTime() - snapshot.startTime;

    if (schedule) {
      if (success) {
        schedule.error_count = 0;
        schedule.last_error = null;
      } else {
        schedule.error_count++;
        schedule.last_error = errorMsg ?? "unknown error";
      }
      schedule.last_run_at = completedAt.toISOString();
      schedule.run_count++;
      schedule.updated_at = completedAt.toISOString();
      computeNextRun(schedule);
    }

    const execution: ScheduleExecution = {
      id: `exec_manual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      schedule_id: snapshot.scheduleId,
      schedule_name: snapshot.scheduleName,
      action: snapshot.action,
      triggered_at: new Date(snapshot.startTime).toISOString(),
      completed_at: completedAt.toISOString(),
      duration_ms: duration,
      success,
      result_summary: resultSummary,
      ...(outcome ? { outcome } : {}),
      ...(findingCount !== undefined ? { finding_count: findingCount } : {}),
      ...(graphVersion ? { graph_version: graphVersion } : {}),
      error: errorMsg,
      ...(getActiveScope() && { instance_uuid: getActiveScope()!.uuid }),
    };
    file.executions.push(execution);

    if (file.executions.length > config.max_history) {
      file.executions = file.executions.slice(-config.max_history);
    }
    await saveScheduleFile(file);

    return execution;
  });
}

// ---------------------------------------------------------------------------
// Query Operations
// ---------------------------------------------------------------------------

export async function getSchedules(): Promise<DreamSchedule[]> {
  const file = await loadScheduleFile();
  return file.schedules;
}

export async function getScheduleHistory(
  scheduleId?: string,
  limit?: number
): Promise<ScheduleExecution[]> {
  const file = await loadScheduleFile();
  let executions = file.executions;
  if (scheduleId) {
    executions = executions.filter((e) => e.schedule_id === scheduleId);
  }
  if (limit) {
    executions = executions.slice(-limit);
  }
  return executions;
}

export async function getScheduleFile(): Promise<ScheduleFile> {
  return loadScheduleFile();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the scheduler tick loop.
 * Called once during server initialization.
 */
export function startScheduler(cfg?: Partial<SchedulerConfig>): void {
  if (cfg) {
    config = { ...config, ...cfg };
  }

  if (!config.enabled) {
    logger.info("Dream Scheduler: disabled by configuration");
    return;
  }

  if (tickTimer) {
    logger.warn("Dream Scheduler: already running, stopping first");
    stopScheduler();
  }

  tickTimer = setInterval(() => {
    tick().catch((err) => {
      logger.error(`Scheduler tick error: ${err}`);
    });
  }, config.tick_interval_ms);

  // Don't block Node exit
  if (tickTimer && typeof tickTimer === "object" && "unref" in tickTimer) {
    tickTimer.unref();
  }

  // Fire an immediate tick on startup so overdue schedules pick up promptly
  // after a daemon restart (otherwise they would idle for up to one full
  // tick_interval_ms before evaluation). Queued, not awaited — startScheduler
  // must remain synchronous from the caller's perspective.
  setImmediate(() => {
    tick().catch((err) => {
      logger.error(`Scheduler initial tick error: ${err}`);
    });
  });

  const instanceTag = getActiveScope() ? ` [${getActiveScope()!.uuid.slice(0, 8)}]` : "";
  logger.info(
    `Dream Scheduler started${instanceTag}: tick=${config.tick_interval_ms}ms, ` +
    `max_runs/hr=${config.max_runs_per_hour}, cooldown=${config.global_cooldown_ms}ms`
  );
}

/**
 * Stop the scheduler tick loop.
 */
export function stopScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
    logger.info("Dream Scheduler stopped");
  }
}

/**
 * Update scheduler configuration at runtime.
 */
export function updateSchedulerConfig(newConfig: Partial<SchedulerConfig>): void {
  const wasEnabled = config.enabled;
  config = { ...config, ...newConfig };

  // Restart tick loop if interval changed or enabled/disabled
  if (tickTimer && (newConfig.tick_interval_ms || newConfig.enabled === false)) {
    stopScheduler();
    if (config.enabled) {
      startScheduler();
    }
  } else if (!wasEnabled && config.enabled) {
    startScheduler();
  }

  logger.info(`Scheduler config updated: ${JSON.stringify(config)}`);
}

/**
 * Get current scheduler config (for diagnostics).
 */
export function getSchedulerConfig(): SchedulerConfig {
  return { ...config };
}
