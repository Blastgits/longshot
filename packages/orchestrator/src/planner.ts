/** @module Root planning loop — iterative LLM-driven task generation with delta optimization */

import type { Handoff, Span, Task, Tracer } from "@longshot/core";
import { createLogger } from "@longshot/core";
import type { OrchestratorConfig } from "./config.js";
import type { MergeQueue } from "./merge-queue.js";
import type { Monitor } from "./monitor.js";
import type { SweepResult } from "./reconciler.js";
import { ScopeTracker } from "./scope-tracker.js";
import {
  ConcurrencyLimiter,
  cleanupPiSession,
  createPlannerPiSession,
  MAX_FILES_PER_HANDOFF,
  MAX_HANDOFF_SUMMARY_CHARS,
  type PiSessionResult,
  parsePlannerResponse,
  type RepoState,
  readRepoState,
  sleep,
  slugifyForBranch,
  WeightedRoundRobinSelector,
} from "./shared.js";
import { DEFAULT_SUBPLANNER_CONFIG, type Subplanner, shouldDecompose } from "./subplanner.js";
import type { TaskQueue } from "./task-queue.js";
import type { WorkerPool } from "./worker-pool.js";

const logger = createLogger("planner", "root-planner");

const LOOP_SLEEP_MS = 500;

/**
 * Minimum handoffs received since the last plan before triggering a replan.
 * Kept low (3) so the planner can adapt quickly as early tasks in a batch
 * complete — the planner prompt now controls batch sizing dynamically
 * rather than relying on this constant to throttle planning frequency.
 */
const MIN_HANDOFFS_FOR_REPLAN = 3;

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const MAX_CONSECUTIVE_ERRORS = 10;

const MAX_TASK_RETRIES = 1;

type PlannerEndpoint = OrchestratorConfig["llm"]["endpoints"][number];

export interface PlannerConfig {
  maxIterations: number;
}

/**
 * Dependency injection seam for deterministic unit tests.
 * Production uses the Pi session + real repo reads; tests can inject fakes.
 */
export interface PlannerDeps {
  createPlannerPiSession: typeof createPlannerPiSession;
  cleanupPiSession: typeof cleanupPiSession;
  parsePlannerResponse: typeof parsePlannerResponse;
  readRepoState: typeof readRepoState;
  sleep: typeof sleep;
  slugifyForBranch: typeof slugifyForBranch;
  now: () => number;
}

export class Planner {
  private config: OrchestratorConfig;
  private plannerConfig: PlannerConfig;
  private piSession: PiSessionResult | null = null;
  private lastTotalTokens: number = 0;
  private taskQueue: TaskQueue;
  private workerPool: WorkerPool;
  private mergeQueue: MergeQueue;
  private monitor: Monitor;
  private systemPrompt: string;
  private targetRepoPath: string;
  private subplanner: Subplanner | null;
  private deps: PlannerDeps;
  private plannerEndpointSelector: WeightedRoundRobinSelector<PlannerEndpoint> | null;

  private running: boolean;
  private taskCounter: number;
  private dispatchLimiter: ConcurrencyLimiter;

  private pendingHandoffs: { task: Task; handoff: Handoff }[];
  private allHandoffs: Handoff[];
  private handoffsSinceLastPlan: Handoff[];
  private activeTasks: Set<string>;
  private dispatchedTaskIds: Set<string>;
  private scopeTracker: ScopeTracker;

  private lastSweepResult: SweepResult | null = null;

  // Delta tracking: avoid re-sending unchanged context each follow-up (~40K chars saved/iteration)
  private previousFileTree: Set<string> = new Set();
  private previousFeaturesHash: number = 0;
  private previousDecisionsHash: number = 0;

  private tracer: Tracer | null = null;
  private rootSpan: Span | null = null;

  private taskCreatedCallbacks: ((task: Task) => void)[];
  private taskCompletedCallbacks: ((task: Task, handoff: Handoff) => void)[];
  private iterationCompleteCallbacks: ((
    iteration: number,
    tasks: Task[],
    handoffs: Handoff[],
  ) => void)[];
  private errorCallbacks: ((error: Error) => void)[];

  constructor(
    config: OrchestratorConfig,
    plannerConfig: PlannerConfig,
    taskQueue: TaskQueue,
    workerPool: WorkerPool,
    mergeQueue: MergeQueue,
    monitor: Monitor,
    systemPrompt: string,
    subplanner?: Subplanner,
    deps?: Partial<PlannerDeps>,
  ) {
    this.config = config;
    this.plannerConfig = plannerConfig;
    this.taskQueue = taskQueue;
    this.workerPool = workerPool;
    this.mergeQueue = mergeQueue;
    this.monitor = monitor;
    this.systemPrompt = systemPrompt;
    this.targetRepoPath = config.targetRepoPath;
    this.subplanner = subplanner ?? null;
    this.plannerEndpointSelector =
      config.llm.endpoints.length > 0 ? new WeightedRoundRobinSelector(config.llm.endpoints) : null;

    this.deps = {
      createPlannerPiSession,
      cleanupPiSession,
      parsePlannerResponse,
      readRepoState,
      sleep,
      slugifyForBranch,
      now: () => Date.now(),
      ...deps,
    };

    this.running = false;
    this.taskCounter = 0;
    this.dispatchLimiter = new ConcurrencyLimiter(config.maxWorkers);

    this.pendingHandoffs = [];
    this.allHandoffs = [];
    this.handoffsSinceLastPlan = [];
    this.activeTasks = new Set();
    this.dispatchedTaskIds = new Set();
    this.scopeTracker = new ScopeTracker();

    this.taskCreatedCallbacks = [];
    this.taskCompletedCallbacks = [];
    this.iterationCompleteCallbacks = [];
    this.errorCallbacks = [];
  }

  // ---------------------------------------------------------------------------
  // Tracing
  // ---------------------------------------------------------------------------

  setTracer(tracer: Tracer): void {
    this.tracer = tracer;
  }

  private async initSession(): Promise<void> {
    if (this.piSession) return;

    logger.info("Initializing Pi agent session for planner");
    const llmEndpoint = this.plannerEndpointSelector?.next();
    this.piSession = await this.deps.createPlannerPiSession({
      systemPrompt: this.systemPrompt,
      targetRepoPath: this.targetRepoPath,
      llmConfig: this.config.llm,
      llmEndpoint,
    });
    this.lastTotalTokens = 0;
    logger.info("Pi agent session ready");
  }

  private disposeSession(): void {
    if (this.piSession) {
      this.deps.cleanupPiSession(this.piSession.session, this.piSession.tempDir);
      this.piSession = null;
      logger.info("Pi agent session disposed");
    }
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  async runLoop(request: string): Promise<void> {
    this.running = true;
    logger.info("Starting streaming planner loop", { request: request.slice(0, 200) });

    if (this.tracer) {
      this.rootSpan = this.tracer.startSpan("planner.runLoop", { agentId: "planner" });
      this.rootSpan.setAttribute("request", request.slice(0, 200));
    }

    let iteration = 0;
    let planningDone = false;
    let consecutiveErrors = 0;

    while (this.running && iteration < this.plannerConfig.maxIterations) {
      logger.debug("Loop tick", {
        iteration,
        activeTasks: this.activeTasks.size,
        pendingHandoffs: this.pendingHandoffs.length,
        handoffsSinceLastPlan: this.handoffsSinceLastPlan.length,
        planningDone,
      });
      try {
        this.collectCompletedHandoffs();

        const hasCapacity = this.dispatchLimiter.getActive() < this.config.maxWorkers;
        const hasEnoughHandoffs = this.handoffsSinceLastPlan.length >= MIN_HANDOFFS_FOR_REPLAN;
        const noActiveWork = this.activeTasks.size === 0 && iteration > 0;
        const needsPlan = hasCapacity && (iteration === 0 || hasEnoughHandoffs || noActiveWork);

        if (needsPlan && !planningDone) {
          logger.info(`Planning iteration ${iteration + 1}`, {
            activeWorkers: this.dispatchLimiter.getActive(),
            handoffsSinceLastPlan: this.handoffsSinceLastPlan.length,
            hasPiSession: this.piSession !== null,
          });

          const repoState = await this.readRepoState();

          const newHandoffs = [...this.handoffsSinceLastPlan];
          const tasks = await this.plan(request, repoState, newHandoffs);

          iteration++;
          consecutiveErrors = 0;
          this.handoffsSinceLastPlan = [];

          if (
            tasks.length === 0 &&
            this.activeTasks.size === 0 &&
            this.taskQueue.getPendingCount() === 0
          ) {
            logger.info("No more tasks to create and no active work. Planning complete.");
            planningDone = true;
          } else if (tasks.length > 0) {
            logger.info(`Created ${tasks.length} tasks for iteration ${iteration}`);
            this.dispatchTasks(tasks);

            for (const cb of this.iterationCompleteCallbacks) {
              cb(iteration, tasks, newHandoffs);
            }
          }
        }

        if (planningDone && this.activeTasks.size === 0 && this.taskQueue.getPendingCount() === 0) {
          break;
        }

        await this.deps.sleep(LOOP_SLEEP_MS);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        consecutiveErrors++;

        const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveErrors - 1), BACKOFF_MAX_MS);

        logger.error(
          `Planning failed (attempt ${consecutiveErrors}), retrying in ${(backoffMs / 1000).toFixed(0)}s`,
          {
            error: err.message,
            consecutiveErrors,
            iteration: iteration + 1,
            activeTasks: this.activeTasks.size,
            hasPiSession: this.piSession !== null,
          },
        );

        for (const cb of this.errorCallbacks) {
          cb(err);
        }

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          logger.error(`Aborting after ${MAX_CONSECUTIVE_ERRORS} consecutive planning failures`);
          break;
        }

        await this.deps.sleep(backoffMs);
      }
    }

    if (this.activeTasks.size > 0) {
      logger.info("Waiting for remaining active tasks", { count: this.activeTasks.size });
      while (this.activeTasks.size > 0 && this.running) {
        this.collectCompletedHandoffs();
        await this.deps.sleep(LOOP_SLEEP_MS);
      }
    }

    this.disposeSession();
    this.running = false;
    logger.info("Planner loop finished", {
      iterations: iteration,
      totalHandoffs: this.allHandoffs.length,
    });

    this.rootSpan?.setStatus("ok");
    this.rootSpan?.end();
  }

  stop(): void {
    this.running = false;
    this.disposeSession();
    logger.info("Planner stop requested");
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // Continuous conversation planning
  // ---------------------------------------------------------------------------

  async readRepoState(): Promise<RepoState> {
    return this.deps.readRepoState(this.targetRepoPath);
  }

  async plan(request: string, repoState: RepoState, newHandoffs: Handoff[]): Promise<Task[]> {
    const isFirstPlan = this.piSession === null;
    const iterationSpan = this.rootSpan?.child("planner.iteration", { agentId: "planner" });
    iterationSpan?.setAttributes({
      isFirstPlan,
      newHandoffs: newHandoffs.length,
    });

    await this.initSession();
    const session = this.piSession?.session;
    if (!session) {
      logger.warn("Planner session unavailable");
      iterationSpan?.setStatus("error", "session unavailable");
      iterationSpan?.end();
      return [];
    }

    const prompt = isFirstPlan
      ? this.buildInitialMessage(request, repoState)
      : this.buildFollowUpMessage(repoState, newHandoffs);

    logger.info("Prompting Pi session for task decomposition", {
      isFirstPlan,
      newHandoffs: newHandoffs.length,
      promptLength: prompt.length,
    });

    try {
      await session.prompt(prompt);

      const stats = session.getSessionStats();
      const tokenDelta = stats.tokens.total - this.lastTotalTokens;
      this.lastTotalTokens = stats.tokens.total;
      this.monitor.recordTokenUsage(tokenDelta);

      const responseText = session.getLastAssistantText();
      logger.debug("LLM response preview", {
        length: responseText?.length ?? 0,
        preview: responseText?.slice(0, 500),
      });
      if (!responseText) {
        logger.warn("Pi session returned no assistant text");
        iterationSpan?.setStatus("error", "no response text");
        iterationSpan?.end();
        return [];
      }

      const { scratchpad, tasks: rawTasks } = this.deps.parsePlannerResponse(responseText);
      logger.debug("Planner scratchpad", { scratchpad: scratchpad.slice(0, 500) });

      const allParsedTasks: Task[] = rawTasks.map((raw) => {
        this.taskCounter++;
        const id = raw.id || `task-${String(this.taskCounter).padStart(3, "0")}`;
        return {
          id,
          description: raw.description,
          scope: raw.scope || [],
          acceptance: raw.acceptance || "",
          branch:
            raw.branch ||
            `${this.config.git.branchPrefix}${id}-${this.deps.slugifyForBranch(raw.description)}`,
          status: "pending" as const,
          createdAt: this.deps.now(),
          priority: raw.priority || 5,
        };
      });

      for (const task of allParsedTasks) {
        logger.debug("Parsed task from LLM", {
          id: task.id,
          description: task.description.slice(0, 200),
          scope: task.scope,
          priority: task.priority,
        });
      }

      const tasks = allParsedTasks.filter((t) => {
        if (this.dispatchedTaskIds.has(t.id)) {
          logger.warn("Skipping duplicate task ID from LLM", { taskId: t.id });
          return false;
        }
        return true;
      });

      if (tasks.length < allParsedTasks.length) {
        logger.info("Dedup filtered tasks", {
          before: allParsedTasks.length,
          after: tasks.length,
          dropped: allParsedTasks.length - tasks.length,
        });
      }

      iterationSpan?.setAttribute("tasksCreated", tasks.length);
      iterationSpan?.setStatus("ok");
      iterationSpan?.end();

      return tasks;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      iterationSpan?.setStatus("error", error.message);
      iterationSpan?.end();
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Message builders
  // ---------------------------------------------------------------------------

  private static contentHash(content: string): number {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
    }
    return hash;
  }

  private buildInitialMessage(request: string, repoState: RepoState): string {
    let msg = `## Request\n${request}\n\n`;

    if (repoState.specMd) {
      msg += `## SPEC.md (Product Specification)\n${repoState.specMd}\n\n`;
    }

    if (repoState.featuresJson) {
      msg += `## FEATURES.json\n${repoState.featuresJson}\n\n`;
    }

    if (repoState.agentsMd) {
      msg += `## AGENTS.md (Coding Conventions)\n${repoState.agentsMd}\n\n`;
    }

    if (repoState.decisionsMd) {
      msg += `## DECISIONS.md (Architecture Decisions)\n${repoState.decisionsMd}\n\n`;
    }

    msg += `## Repository File Tree\n${repoState.fileTree.join("\n")}\n\n`;
    msg += `## Recent Commits\n${repoState.recentCommits.join("\n")}\n\n`;

    msg += `This is the initial planning call. SPEC.md and FEATURES.json above are binding — your tasks must conform to the dependencies, file structure, and features they define. Produce your first batch of tasks and your scratchpad.\n`;

    this.previousFileTree = new Set(repoState.fileTree);
    this.previousFeaturesHash = repoState.featuresJson
      ? Planner.contentHash(repoState.featuresJson)
      : 0;
    this.previousDecisionsHash = repoState.decisionsMd
      ? Planner.contentHash(repoState.decisionsMd)
      : 0;

    logger.debug("Built initial planner prompt", {
      length: msg.length,
      hasSpec: !!repoState.specMd,
      hasFeatures: !!repoState.featuresJson,
      hasAgents: !!repoState.agentsMd,
      hasDecisions: !!repoState.decisionsMd,
      fileTreeSize: repoState.fileTree.length,
      commitsCount: repoState.recentCommits.length,
    });
    return msg;
  }

  private buildFollowUpMessage(repoState: RepoState, newHandoffs: Handoff[]): string {
    let msg = `## Updated Repository State\n`;

    const currentTree = new Set(repoState.fileTree);
    const newFiles = repoState.fileTree.filter((f) => !this.previousFileTree.has(f));
    const removedFiles = [...this.previousFileTree].filter((f) => !currentTree.has(f));

    if (newFiles.length === 0 && removedFiles.length === 0) {
      msg += `File tree: unchanged (${currentTree.size} files). Use read-only tools to explore specific paths.\n\n`;
    } else if (newFiles.length > 50 || removedFiles.length > 50) {
      msg += `File tree:\n${repoState.fileTree.join("\n")}\n\n`;
    } else {
      msg += `File tree (${currentTree.size} files):\n`;
      if (newFiles.length > 0) msg += `  New: ${newFiles.join(", ")}\n`;
      if (removedFiles.length > 0) msg += `  Removed: ${removedFiles.join(", ")}\n`;
      msg += `\n`;
    }
    this.previousFileTree = currentTree;

    msg += `Recent commits:\n${repoState.recentCommits.join("\n")}\n\n`;

    if (repoState.featuresJson) {
      const hash = Planner.contentHash(repoState.featuresJson);
      if (hash !== this.previousFeaturesHash) {
        msg += `## FEATURES.json (updated)\n${repoState.featuresJson}\n\n`;
        this.previousFeaturesHash = hash;
      }
    }

    if (repoState.decisionsMd) {
      const hash = Planner.contentHash(repoState.decisionsMd);
      if (hash !== this.previousDecisionsHash) {
        msg += `## DECISIONS.md (updated)\n${repoState.decisionsMd}\n\n`;
        this.previousDecisionsHash = hash;
      }
    }

    if (newHandoffs.length > 0) {
      msg += `## New Worker Handoffs (${newHandoffs.length} since last plan)\n`;
      for (const h of newHandoffs) {
        msg += `### Task ${h.taskId} — ${h.status}\n`;

        const summary =
          h.summary.length > MAX_HANDOFF_SUMMARY_CHARS
            ? `${h.summary.slice(0, MAX_HANDOFF_SUMMARY_CHARS)}…`
            : h.summary;
        msg += `Summary: ${summary}\n`;

        const files =
          h.filesChanged.length > MAX_FILES_PER_HANDOFF
            ? [
                ...h.filesChanged.slice(0, MAX_FILES_PER_HANDOFF),
                `... (${h.filesChanged.length - MAX_FILES_PER_HANDOFF} more)`,
              ]
            : h.filesChanged;
        msg += `Files changed: ${files.join(", ")}\n`;

        if (h.concerns.length > 0) msg += `Concerns: ${h.concerns.join("; ")}\n`;
        if (h.suggestions.length > 0) msg += `Suggestions: ${h.suggestions.join("; ")}\n`;
        msg += `\n`;
      }
    }

    if (this.activeTasks.size > 0) {
      msg += `## Currently Active Tasks (${this.activeTasks.size})\n`;
      for (const id of this.activeTasks) {
        const t = this.taskQueue.getById(id);
        if (t) msg += `- ${id}: ${t.description.slice(0, 120)}\n`;
      }
      msg += `\n`;
    }

    const mergeStats = this.mergeQueue.getMergeStats();
    const mergeQueueLen = this.mergeQueue.getQueueLength();
    msg += `## Merge Queue Health\n`;
    msg += `Merged: ${mergeStats.totalMerged} | Conflicts: ${mergeStats.totalConflicts} | Failed: ${mergeStats.totalFailed} | Queue depth: ${mergeQueueLen}\n`;
    if (mergeStats.totalMerged + mergeStats.totalConflicts > 0) {
      const rate = Math.round(
        (mergeStats.totalMerged / (mergeStats.totalMerged + mergeStats.totalConflicts)) * 100,
      );
      msg += `Success rate: ${rate}%\n`;
    }
    msg += `\n`;

    const lockedFiles = this.scopeTracker.getLockedFiles();
    if (lockedFiles.length > 0) {
      msg += `## Currently Locked File Scopes (${lockedFiles.length} files)\n`;
      msg += `These files are being modified by active tasks — avoid assigning new work to them:\n`;
      msg += `${lockedFiles.join(", ")}\n\n`;
    }

    if (this.lastSweepResult) {
      const sr = this.lastSweepResult;
      msg += `## Build/Test Health\n`;
      msg += `Build: ${sr.buildOk ? "PASS" : "FAIL"}`;
      if (!sr.buildOk && sr.buildOutput) {
        msg += ` — errors:\n\`\`\`\n${sr.buildOutput.slice(0, 2000)}\n\`\`\``;
      }
      msg += `\nTests: ${sr.testsOk ? "PASS" : "FAIL"}`;
      if (!sr.testsOk && sr.testOutput) {
        msg += ` — output:\n\`\`\`\n${sr.testOutput.slice(0, 2000)}\n\`\`\``;
      }
      msg += `\n`;
      if (sr.hasConflictMarkers) {
        msg += `Conflict markers in: ${sr.conflictFiles.join(", ")}\n`;
      }
      msg += `\n`;
    }

    msg += `Continue planning. Review new handoffs and state changes. Rewrite your scratchpad and emit the next batch of tasks. Task ID deduplication is handled automatically — do not re-emit previously used IDs.`;
    if (this.lastSweepResult && (!this.lastSweepResult.buildOk || !this.lastSweepResult.testsOk)) {
      msg += ` Build/tests are failing — emit targeted fix tasks.`;
    }
    msg += `\n`;
    logger.debug("Built follow-up planner prompt", {
      length: msg.length,
      newHandoffs: newHandoffs.length,
      activeTasks: this.activeTasks.size,
      fileTreeDelta: newFiles.length + removedFiles.length,
    });
    return msg;
  }

  // ---------------------------------------------------------------------------
  // Task dispatch
  // ---------------------------------------------------------------------------

  private dispatchTasks(tasks: Task[]): void {
    for (const task of tasks) {
      if (this.activeTasks.has(task.id) || this.dispatchedTaskIds.has(task.id)) {
        logger.warn("Skipping already-dispatched task", { taskId: task.id });
        continue;
      }

      this.taskQueue.enqueue(task);
      for (const cb of this.taskCreatedCallbacks) {
        cb(task);
      }

      this.dispatchedTaskIds.add(task.id);
      this.activeTasks.add(task.id);
      this.dispatchSingleTask(task);
    }
  }

  /** Fire-and-forget: dispatches task to a worker, pushes result to pendingHandoffs on completion. */
  private dispatchSingleTask(task: Task): void {
    const dispatchSpan = this.rootSpan?.child("planner.dispatchTask", {
      taskId: task.id,
      agentId: "planner",
    });
    const promise = (async () => {
      logger.debug("Awaiting dispatch slot", {
        taskId: task.id,
        activeSlots: this.dispatchLimiter.getActive(),
        queuedWaiting: this.dispatchLimiter.getQueueLength(),
      });
      await this.dispatchLimiter.acquire();

      const current = this.taskQueue.getById(task.id);
      if (current && current.status !== "pending") {
        logger.warn("Task already dispatched (post-limiter check), skipping", {
          taskId: task.id,
          status: current.status,
        });
        this.dispatchLimiter.release();
        this.activeTasks.delete(task.id);
        dispatchSpan?.end();
        return;
      }

      if (task.scope.length > 0) {
        const overlaps = this.scopeTracker.getOverlaps(task.id, task.scope);
        if (overlaps.length > 0) {
          logger.warn("Scope overlap detected", {
            taskId: task.id,
            overlaps: overlaps.map((o) => ({ taskId: o.taskId, files: o.overlappingFiles })),
          });
        }
        this.scopeTracker.register(task.id, task.scope);
      }

      try {
        let handoff: Handoff;

        if (this.subplanner && shouldDecompose(task, DEFAULT_SUBPLANNER_CONFIG, 0)) {
          logger.info("Task scope is complex — routing through subplanner", {
            taskId: task.id,
            scopeSize: task.scope.length,
          });
          this.taskQueue.assignTask(task.id, "subplanner");
          this.taskQueue.startTask(task.id);
          handoff = await this.subplanner.decomposeAndExecute(task, 0, dispatchSpan);
        } else {
          this.taskQueue.assignTask(task.id, `ephemeral-${task.id}`);
          this.taskQueue.startTask(task.id);
          handoff = await this.workerPool.assignTask(task);
        }

        if (handoff.filesChanged.length === 0) {
          const workerId = this.taskQueue.getById(task.id)?.assignedTo || "unknown";
          this.monitor.recordEmptyDiff(workerId, task.id);
        }

        if (handoff.metrics.tokensUsed === 0 && handoff.metrics.toolCallCount === 0) {
          this.monitor.recordSuspiciousTask(task.id, "0 tokens and 0 tool calls");
        }

        if (handoff.status === "complete") {
          this.taskQueue.completeTask(task.id);
        } else {
          this.taskQueue.failTask(task.id);
        }

        this.monitor.recordTokenUsage(handoff.metrics.tokensUsed);

        for (const cb of this.taskCompletedCallbacks) {
          cb(task, handoff);
        }

        this.pendingHandoffs.push({ task, handoff });
        dispatchSpan?.setStatus("ok");
      } catch (error) {
        this.taskQueue.failTask(task.id);
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error("Task dispatch failed", { taskId: task.id, error: err.message });

        const failureHandoff: Handoff = {
          taskId: task.id,
          status: "failed",
          summary: `Worker failed: ${err.message}`,
          diff: "",
          filesChanged: [],
          concerns: [err.message],
          suggestions: ["Retry the task"],
          metrics: {
            linesAdded: 0,
            linesRemoved: 0,
            filesCreated: 0,
            filesModified: 0,
            tokensUsed: 0,
            toolCallCount: 0,
            durationMs: 0,
          },
        };
        this.pendingHandoffs.push({ task, handoff: failureHandoff });
        dispatchSpan?.setStatus("error", err.message);
      } finally {
        this.scopeTracker.release(task.id);
        this.dispatchLimiter.release();
        this.activeTasks.delete(task.id);
        dispatchSpan?.end();
      }
    })();

    promise.catch((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Unhandled dispatch error", { taskId: task.id, error: err.message });
      this.activeTasks.delete(task.id);
      for (const cb of this.errorCallbacks) {
        cb(err);
      }
    });
  }

  /** Drains pendingHandoffs (populated by dispatchSingleTask) into allHandoffs + merge queue. */
  private collectCompletedHandoffs(): void {
    while (this.pendingHandoffs.length > 0) {
      const completed = this.pendingHandoffs.shift();
      if (!completed) break;

      const { task, handoff } = completed;

      this.allHandoffs.push(handoff);
      this.handoffsSinceLastPlan.push(handoff);

      if (handoff.status === "complete") {
        if (task.conflictSourceBranch) {
          this.mergeQueue.resetRetryCount(task.branch);
        }
        this.mergeQueue.enqueue(task.branch, task.priority);
      } else if (
        (handoff.status === "failed" || handoff.status === "blocked") &&
        (task.retryCount ?? 0) < MAX_TASK_RETRIES
      ) {
        const retried = this.taskQueue.retryTask(task.id);
        if (retried) {
          logger.info("Auto-retrying failed task", {
            taskId: task.id,
            previousStatus: handoff.status,
            retryCount: task.retryCount,
            maxRetries: MAX_TASK_RETRIES,
            failureReason: handoff.summary.slice(0, 200),
          });
          this.activeTasks.add(task.id);
          this.dispatchSingleTask(task);
        }
      }

      logger.debug("Handoff details", {
        taskId: task.id,
        status: handoff.status,
        diffSize: handoff.diff.length,
        summary: handoff.summary.slice(0, 300),
        concerns: handoff.concerns,
        suggestions: handoff.suggestions,
      });
      logger.info("Collected handoff", {
        taskId: task.id,
        status: handoff.status,
        filesChanged: handoff.filesChanged.length,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Public: inject tasks from external sources (merge-queue conflict resolution)
  // ---------------------------------------------------------------------------

  /**
   * Inject a task directly into the planner's dispatch pipeline.
   * Used by the orchestrator to dispatch conflict-resolution fix tasks
   * without going through the LLM planning cycle.
   */
  injectTask(task: Task): void {
    if (this.activeTasks.has(task.id) || this.dispatchedTaskIds.has(task.id)) {
      logger.warn("Skipping duplicate injected task", { taskId: task.id });
      return;
    }

    this.taskQueue.enqueue(task);
    for (const cb of this.taskCreatedCallbacks) {
      cb(task);
    }
    this.dispatchedTaskIds.add(task.id);
    this.activeTasks.add(task.id);
    this.dispatchSingleTask(task);
    logger.info("Injected external task", { taskId: task.id });
  }

  getScopeTracker(): ScopeTracker {
    return this.scopeTracker;
  }

  setLastSweepResult(result: SweepResult): void {
    this.lastSweepResult = result;
  }

  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  getAllDispatchedBranches(): string[] {
    const branches: string[] = [];
    for (const taskId of this.dispatchedTaskIds) {
      const task = this.taskQueue.getById(taskId);
      if (task?.branch) {
        branches.push(task.branch);
      }
    }
    return branches;
  }

  // ---------------------------------------------------------------------------
  // Callbacks
  // ---------------------------------------------------------------------------

  onTaskCreated(callback: (task: Task) => void): void {
    this.taskCreatedCallbacks.push(callback);
  }

  onTaskCompleted(callback: (task: Task, handoff: Handoff) => void): void {
    this.taskCompletedCallbacks.push(callback);
  }

  onIterationComplete(
    callback: (iteration: number, tasks: Task[], handoffs: Handoff[]) => void,
  ): void {
    this.iterationCompleteCallbacks.push(callback);
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback);
  }
}
