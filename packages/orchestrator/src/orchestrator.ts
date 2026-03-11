/** @module Top-level orchestrator factory — wires all components and manages the finalization phase */

/**
 * Orchestrator Factory — creates and wires all components.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Handoff, MetricsSnapshot, Task } from "@longshot/core";
import { createLogger, createTracer, type Tracer } from "@longshot/core";
import { loadConfig, type OrchestratorConfig } from "./config.js";
import { MergeQueue } from "./merge-queue.js";
import { Monitor } from "./monitor.js";
import { Planner } from "./planner.js";
import { Reconciler, type SweepResult } from "./reconciler.js";
import { GitMutex } from "./shared.js";
import { DEFAULT_SUBPLANNER_CONFIG, Subplanner } from "./subplanner.js";
import { TaskQueue } from "./task-queue.js";
import { JournalTaskStore, type TaskStore } from "./task-store.js";
import { WorkerPool } from "./worker-pool.js";

const logger = createLogger("orchestrator", "root-planner");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrchestratorCallbacks {
  onTaskCreated?: (task: Task) => void;
  onTaskCompleted?: (task: Task, handoff: Handoff) => void;
  onIterationComplete?: (iteration: number, tasks: Task[], handoffs: Handoff[]) => void;
  onError?: (error: Error) => void;
  onSweepComplete?: (result: import("./reconciler.js").SweepResult) => void;
  onReconcilerError?: (error: Error) => void;
  onWorkerTimeout?: (workerId: string, taskId: string) => void;
  onEmptyDiff?: (workerId: string, taskId: string) => void;
  onMetricsUpdate?: (snapshot: MetricsSnapshot) => void;
  onTaskStatusChange?: (task: Task, oldStatus: string, newStatus: string) => void;
  onFinalizationStart?: () => void;
  onFinalizationAttempt?: (attempt: number, sweepResult: SweepResult) => void;
  onFinalizationComplete?: (attempts: number, passed: boolean) => void;
}

export interface Orchestrator {
  /** Underlying components — exposed for advanced use cases. */
  planner: Planner;
  subplanner: Subplanner;
  reconciler: Reconciler;
  monitor: Monitor;
  workerPool: WorkerPool;
  taskQueue: TaskQueue;
  taskStore: TaskStore;
  mergeQueue: MergeQueue;
  config: OrchestratorConfig;
  tracer: Tracer;

  /** Start background services (worker pool, monitor, reconciler). */
  start(): Promise<void>;

  /** Gracefully stop all services. */
  stop(): Promise<void>;

  /**
   * Full lifecycle: start → planner.runLoop(request) → stop.
   * Returns the final metrics snapshot.
   */
  run(request: string): Promise<MetricsSnapshot>;

  /** Whether the planner loop is currently running. */
  isRunning(): boolean;

  /** Current metrics snapshot. */
  getSnapshot(): MetricsSnapshot;
}

export interface CreateOrchestratorOptions {
  /**
   * Project root directory. Prompts are read from `<projectRoot>/prompts/`.
   * Defaults to `process.cwd()`.
   */
  projectRoot?: string;

  /**
   * Override individual config values loaded from env.
   * Applied on top of loadConfig().
   */
  configOverrides?: Partial<
    Pick<OrchestratorConfig, "maxWorkers" | "targetRepoPath" | "stateDir" | "runId">
  >;

  /** Max planner iterations before stopping. Default: 100. */
  maxIterations?: number;

  /** Reconciler sweep interval in ms. Default: 300_000 (5 min). */
  reconcilerIntervalMs?: number;

  /** Max fix tasks per reconciler sweep. Default: 5. */
  reconcilerMaxFixTasks?: number;

  /** Max finalization sweep attempts. Default: 3. */
  finalizationMaxAttempts?: number;

  /** Whether to run the finalization phase. Default: true. */
  finalizationEnabled?: boolean;

  /** Callbacks wired to planner/monitor/reconciler events. */
  callbacks?: OrchestratorCallbacks;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createOrchestrator(
  options: CreateOrchestratorOptions = {},
): Promise<Orchestrator> {
  const projectRoot = options.projectRoot ?? process.cwd();

  // --- Config ---
  const config = loadConfig();
  if (options.configOverrides?.maxWorkers !== undefined) {
    config.maxWorkers = options.configOverrides.maxWorkers;
  }
  if (options.configOverrides?.targetRepoPath !== undefined) {
    config.targetRepoPath = options.configOverrides.targetRepoPath;
  }
  if (options.configOverrides?.stateDir !== undefined) {
    config.stateDir = options.configOverrides.stateDir;
  }
  if (options.configOverrides?.runId !== undefined) {
    config.runId = options.configOverrides.runId;
  }
  if (options.finalizationMaxAttempts !== undefined) {
    config.finalization.maxAttempts = options.finalizationMaxAttempts;
  }
  if (options.finalizationEnabled !== undefined) {
    config.finalization.enabled = options.finalizationEnabled;
  }

  logger.info("Config loaded", {
    maxWorkers: config.maxWorkers,
    targetRepo: config.targetRepoPath,
    stateDir: config.stateDir,
    runId: config.runId,
  });
  logger.debug("Full config", {
    maxWorkers: config.maxWorkers,
    workerTimeout: config.workerTimeout,
    mergeStrategy: config.mergeStrategy,
    model: config.llm.model,
    maxTokens: config.llm.maxTokens,
    temperature: config.llm.temperature,
    endpoints: config.llm.endpoints.map((e) => ({
      name: e.name,
      endpoint: e.endpoint,
      weight: e.weight,
    })),
    repoUrl: config.git.repoUrl,
    mainBranch: config.git.mainBranch,
    branchPrefix: config.git.branchPrefix,
    targetRepoPath: config.targetRepoPath,
  });

  // --- Prompts ---
  const readPrompt = async (name: string): Promise<string> => {
    const promptPath = resolve(projectRoot, "prompts", `${name}.md`);
    return readFile(promptPath, "utf-8");
  };

  const [rootPrompt, workerPrompt, reconcilerPrompt, subplannerPrompt] = await Promise.all([
    readPrompt("root-planner"),
    readPrompt("worker"),
    readPrompt("reconciler"),
    readPrompt("subplanner"),
  ]);
  logger.debug("Prompts loaded", {
    rootPromptSize: rootPrompt.length,
    workerPromptSize: workerPrompt.length,
    reconcilerPromptSize: reconcilerPrompt.length,
    subplannerPromptSize: subplannerPrompt.length,
  });

  // --- Components ---
  const taskQueue = new TaskQueue();
  const taskStore = new JournalTaskStore({ stateDir: config.stateDir, runId: config.runId });
  const gitMutex = new GitMutex();

  const workerPool = new WorkerPool(
    {
      maxWorkers: config.maxWorkers,
      workerTimeout: config.workerTimeout,
      llm: config.llm,
      git: config.git,
      pythonPath: config.pythonPath,
      gitToken: process.env.GIT_TOKEN,
    },
    workerPrompt,
  );

  const mergeQueue = new MergeQueue({
    mergeStrategy: config.mergeStrategy,
    mainBranch: config.git.mainBranch,
    repoPath: config.targetRepoPath,
    gitMutex,
  });

  const monitor = new Monitor(
    {
      healthCheckInterval: config.healthCheckInterval,
      workerTimeout: config.workerTimeout,
    },
    workerPool,
    taskQueue,
  );

  const subplanner = new Subplanner(
    config,
    DEFAULT_SUBPLANNER_CONFIG,
    taskQueue,
    workerPool,
    mergeQueue,
    monitor,
    subplannerPrompt,
  );

  const planner = new Planner(
    config,
    { maxIterations: options.maxIterations ?? 100 },
    taskQueue,
    workerPool,
    mergeQueue,
    monitor,
    rootPrompt,
    subplanner,
    undefined,
    taskStore,
  );

  const reconciler = new Reconciler(
    config,
    {
      intervalMs: options.reconcilerIntervalMs ?? 300_000,
      maxFixTasks: options.reconcilerMaxFixTasks ?? 5,
    },
    taskQueue,
    mergeQueue,
    monitor,
    reconcilerPrompt,
  );

  // --- Tracer ---
  const tracer = createTracer();
  planner.setTracer(tracer);
  workerPool.setTracer(tracer);
  mergeQueue.setTracer(tracer);
  reconciler.setTracer(tracer);
  subplanner.setTracer(tracer);

  // --- Wire callbacks ---
  const cb = options.callbacks;
  if (cb?.onTaskCreated) planner.onTaskCreated(cb.onTaskCreated);
  if (cb?.onTaskCompleted) planner.onTaskCompleted(cb.onTaskCompleted);
  if (cb?.onIterationComplete) planner.onIterationComplete(cb.onIterationComplete);
  if (cb?.onError) planner.onError(cb.onError);
  if (cb?.onSweepComplete) reconciler.onSweepComplete(cb.onSweepComplete);
  if (cb?.onReconcilerError) reconciler.onError(cb.onReconcilerError);
  if (cb?.onWorkerTimeout) monitor.onWorkerTimeout(cb.onWorkerTimeout);
  if (cb?.onEmptyDiff) monitor.onEmptyDiff(cb.onEmptyDiff);
  if (cb?.onMetricsUpdate) monitor.onMetricsUpdate(cb.onMetricsUpdate);
  if (cb?.onTaskStatusChange) taskQueue.onStatusChange(cb.onTaskStatusChange);

  // --- Instance ---
  let started = false;

  const instance: Orchestrator = {
    planner,
    subplanner,
    reconciler,
    monitor,
    workerPool,
    taskQueue,
    taskStore,
    mergeQueue,
    config,
    tracer,

    async start() {
      if (started) return;
      started = true;
      await workerPool.start();
      monitor.start();
      reconciler.start();

      reconciler.onSweepComplete((result) => {
        planner.setLastSweepResult(result);
        for (const task of result.fixTasks) {
          planner.injectTask(task);
        }

        const timedOut = workerPool.drainTimedOutBranches();
        for (const branch of timedOut) {
          logger.info("Timed-out branch preserved for finalization retry", { branch });
        }
      });

      logger.debug("All components started", {
        monitorInterval: config.healthCheckInterval,
        workerTimeout: config.workerTimeout,
        mergeStrategy: config.mergeStrategy,
        maxWorkers: config.maxWorkers,
      });

      mergeQueue.startBackground();
      mergeQueue.onMergeResult((result) => {
        monitor.recordMergeAttempt(result.success);
        logger.info("Merge result", {
          branch: result.branch,
          status: result.status,
          success: result.success,
        });
        logger.debug("Merge result details", {
          branch: result.branch,
          status: result.status,
          success: result.success,
          message: result.message,
          conflicts: result.conflicts,
        });
      });

      let conflictCounter = 0;
      const MAX_CONFLICT_FIX_TASKS = 30;

      mergeQueue.onConflict((info) => {
        if (info.branch.includes("conflict-fix")) {
          logger.warn("Skipping conflict-fix for conflict-fix branch (cascade prevention)", {
            branch: info.branch,
          });
          return;
        }

        if (conflictCounter >= MAX_CONFLICT_FIX_TASKS) {
          logger.warn(
            "Conflict-fix budget exhausted, skipping (branch preserved for finalization)",
            {
              branch: info.branch,
              limit: MAX_CONFLICT_FIX_TASKS,
            },
          );
          return;
        }

        conflictCounter++;
        const fixId = `conflict-fix-${String(conflictCounter).padStart(3, "0")}`;
        const fixTask: Task = {
          id: fixId,
          description:
            `Resolve merge conflict from branch "${info.branch}". Conflicting files: ${info.conflictingFiles.join(", ")}. ` +
            `The sandbox will check out the original branch and rebase it onto main — conflict markers will be present in the working tree. ` +
            `Open each conflicting file, find <<<<<<< / ======= / >>>>>>> blocks, resolve by keeping the correct version based on surrounding code context. ` +
            `Remove all conflict markers and run \`git add\` on each resolved file, then \`git rebase --continue\`. Ensure the file compiles after resolution.`,
          scope: info.conflictingFiles.slice(0, 5),
          acceptance: `No <<<<<<< markers remain in the affected files. tsc --noEmit returns 0 for these files. Rebase completes cleanly.`,
          branch: info.branch,
          status: "pending",
          createdAt: Date.now(),
          priority: 1,
          conflictSourceBranch: info.branch,
        };

        logger.info("Creating conflict-resolution task", {
          fixId,
          branch: info.branch,
          conflictingFiles: info.conflictingFiles,
          remainingBudget: MAX_CONFLICT_FIX_TASKS - conflictCounter,
        });

        planner.injectTask(fixTask);
      });

      logger.info("Orchestrator started");
    },

    async stop() {
      planner.stop();
      reconciler.stop();
      mergeQueue.stopBackground();
      monitor.stop();
      await workerPool.stop();
      started = false;

      const snapshot = monitor.getSnapshot();
      logger.info("Orchestrator stopped", { ...snapshot });
    },

    async run(request: string) {
      await instance.start();

      logger.info("Beginning planner loop", { request: request.slice(0, 200) });
      await planner.runLoop(request);

      const mainSnapshot = monitor.getSnapshot();
      logger.info("Planner loop complete", { ...mainSnapshot });

      // ── Finalization Phase ────────────────────────────────────────
      if (config.finalization.enabled) {
        const finalizationStart = Date.now();
        let attempt = 0;
        let finalBuildOk = false;
        let finalTestsOk = false;

        logger.info("Entering finalization phase", {
          maxAttempts: config.finalization.maxAttempts,
        });

        if (cb?.onFinalizationStart) cb.onFinalizationStart();

        while (attempt < config.finalization.maxAttempts) {
          attempt++;
          logger.info(`Finalization attempt ${attempt}/${config.finalization.maxAttempts}`);

          // Step 1: Drain the merge queue
          const mergeQueueDepth = mergeQueue.getQueueLength();
          if (mergeQueueDepth > 0) {
            logger.info("Draining merge queue", { depth: mergeQueueDepth });
            const mergeResults = await mergeQueue.processQueue();
            for (const result of mergeResults) {
              monitor.recordMergeAttempt(result.success);
            }
          }

          // Step 2: Re-enqueue unmerged branches for another attempt
          const allBranches = planner.getAllDispatchedBranches();
          const unmerged = allBranches.filter((b) => !mergeQueue.isBranchMerged(b));
          if (unmerged.length > 0) {
            logger.info("Re-enqueuing unmerged branches (retry counts reset)", {
              count: unmerged.length,
              branches: unmerged,
            });
            for (const branch of unmerged) {
              mergeQueue.resetRetryCount(branch);
              mergeQueue.enqueue(branch, 1);
            }
            const retryResults = await mergeQueue.processQueue();
            for (const result of retryResults) {
              monitor.recordMergeAttempt(result.success);
            }
          }

          // Step 3: Synchronous reconciler sweep
          logger.info("Running finalization sweep (build + test + conflict check)");
          let sweepResult: SweepResult;
          try {
            sweepResult = await reconciler.sweep();
          } catch (sweepErr) {
            const msg = sweepErr instanceof Error ? sweepErr.message : String(sweepErr);
            logger.error("Finalization sweep threw an error", { attempt, error: msg });
            break;
          }

          planner.setLastSweepResult(sweepResult);

          if (cb?.onFinalizationAttempt) cb.onFinalizationAttempt(attempt, sweepResult);

          finalBuildOk = sweepResult.buildOk;
          finalTestsOk = sweepResult.testsOk;

          // Step 4: Check branch completeness
          const postSweepUnmerged = allBranches.filter((b) => !mergeQueue.isBranchMerged(b));
          const allMerged = postSweepUnmerged.length === 0;

          if (
            sweepResult.buildOk &&
            sweepResult.testsOk &&
            !sweepResult.hasConflictMarkers &&
            allMerged
          ) {
            logger.info("Finalization sweep PASSED — all green, all branches merged!", { attempt });
            break;
          }

          logger.info("Finalization sweep found issues", {
            attempt,
            buildOk: sweepResult.buildOk,
            testsOk: sweepResult.testsOk,
            hasConflictMarkers: sweepResult.hasConflictMarkers,
            conflictFiles: sweepResult.conflictFiles.length,
            fixTaskCount: sweepResult.fixTasks.length,
            allMerged,
            unmergedBranches: postSweepUnmerged.length,
          });

          if (sweepResult.fixTasks.length === 0 && allMerged) {
            logger.warn("Sweep found failures but generated no fix tasks — cannot self-heal", {
              buildOk: sweepResult.buildOk,
              testsOk: sweepResult.testsOk,
              hasConflictMarkers: sweepResult.hasConflictMarkers,
            });
            break;
          }

          if (attempt >= config.finalization.maxAttempts) {
            logger.warn("Max finalization attempts reached", {
              attempt,
              fixTasks: sweepResult.fixTasks.length,
              unmergedBranches: postSweepUnmerged.length,
            });
            break;
          }

          // Step 5: Inject fix tasks and wait for completion
          if (sweepResult.fixTasks.length > 0) {
            for (const task of sweepResult.fixTasks) {
              planner.injectTask(task);
            }

            logger.info("Waiting for finalization fix tasks to complete", {
              count: sweepResult.fixTasks.length,
            });
            const fixWaitStart = Date.now();
            const fixWaitTimeout = config.finalization.sweepTimeoutMs;
            while (planner.getActiveTaskCount() > 0) {
              if (Date.now() - fixWaitStart > fixWaitTimeout) {
                logger.warn("Timed out waiting for finalization fix tasks", {
                  activeCount: planner.getActiveTaskCount(),
                  timeoutMs: fixWaitTimeout,
                });
                break;
              }
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
        }

        // Final branch completeness assessment
        const finalAllBranches = planner.getAllDispatchedBranches();
        const finalUnmerged = finalAllBranches.filter((b) => !mergeQueue.isBranchMerged(b));
        const finalAllMerged = finalUnmerged.length === 0;

        if (finalUnmerged.length > 0) {
          logger.warn(
            "Run finished with unmerged branches (preserved on remote for manual recovery)",
            {
              total: finalAllBranches.length,
              merged: finalAllBranches.length - finalUnmerged.length,
              unmerged: finalUnmerged.length,
              branches: finalUnmerged,
            },
          );
        }

        const finalizationDuration = Date.now() - finalizationStart;
        monitor.setFinalizationMetrics({
          attempts: attempt,
          buildPassed: finalBuildOk,
          testsPassed: finalTestsOk,
          allMerged: finalAllMerged,
          unmergedCount: finalUnmerged.length,
          durationMs: finalizationDuration,
        });

        const passed = finalBuildOk && finalTestsOk && finalAllMerged;
        if (cb?.onFinalizationComplete) cb.onFinalizationComplete(attempt, passed);

        logger.info("Finalization phase complete", {
          attempts: attempt,
          buildPassed: finalBuildOk,
          testsPassed: finalTestsOk,
          allMerged: finalAllMerged,
          unmergedBranches: finalUnmerged.length,
          durationMs: finalizationDuration,
          passed,
        });
      } else {
        logger.info("Finalization phase disabled — skipping");
      }

      const snapshot = monitor.getSnapshot();
      logger.info("Orchestrator run complete", { ...snapshot });

      await instance.stop();
      return snapshot;
    },

    isRunning() {
      return planner.isRunning();
    },

    getSnapshot() {
      return monitor.getSnapshot();
    },
  };

  return instance;
}
