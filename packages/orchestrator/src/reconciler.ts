/** @module Periodic build and test reconciliation with adaptive intervals and LLM-generated fix tasks */

/**
 * Reconciler - Timer-based sweep that keeps the target repo green.
 * Periodically runs tsc + npm test, and creates fix tasks when failures are detected.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Span, Task, Tracer } from "@longshot/core";
import { createLogger } from "@longshot/core";
import type { OrchestratorConfig } from "./config.js";
import {
  LLMClient,
  type LLMClientConfig,
  type LLMMessage,
  type LLMResponse,
} from "./llm-client.js";
import type { MergeQueue } from "./merge-queue.js";
import type { Monitor } from "./monitor.js";
import { parseLLMTaskArray, slugifyForBranch } from "./shared.js";
import type { TaskQueue } from "./task-queue.js";

const execFileAsync = promisify(execFile);

interface ExecErrorShape {
  stdout?: string;
  stderr?: string;
  code?: number | null;
}

function isExecErrorShape(error: unknown): error is ExecErrorShape {
  return typeof error === "object" && error !== null;
}
const logger = createLogger("reconciler", "reconciler");

export interface ReconcilerConfig {
  /** How often to sweep (ms). Default 300_000 = 5 min */
  intervalMs: number;
  /** Max fix tasks created per sweep. Default 5 */
  maxFixTasks: number;
}

export const DEFAULT_RECONCILER_CONFIG: ReconcilerConfig = {
  intervalMs: 300_000,
  maxFixTasks: 5,
};

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type ReconcilerRunCommand = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<ExecResult>;

export type ReconcilerCompleteLLM = (
  messages: LLMMessage[],
  overrides?: Partial<Pick<LLMClientConfig, "model" | "temperature" | "maxTokens">>,
  parentSpan?: Span,
) => Promise<LLMResponse>;

/**
 * Dependency injection seam for deterministic unit tests.
 * Production uses real subprocess execution and an LLM client.
 */
export interface ReconcilerDeps {
  runCommand: ReconcilerRunCommand;
  completeLLM: ReconcilerCompleteLLM;
  now: () => number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export interface SweepResult {
  buildOk: boolean;
  testsOk: boolean;
  hasConflictMarkers: boolean;
  buildOutput: string;
  testOutput: string;
  conflictFiles: string[];
  fixTasks: Task[];
}

/**
 * Runs a command and captures output + exit code without throwing.
 */
async function runCommand(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  try {
    const result = await execFileAsync(cmd, args, { cwd, maxBuffer: 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error: unknown) {
    const err = isExecErrorShape(error) ? error : {};
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      code: err.code ?? 1,
    };
  }
}

/**
 * Reconciler that periodically checks if the target repo builds and tests pass.
 * When failures are detected, it calls the LLM to produce fix tasks and enqueues them.
 */
export class Reconciler {
  private config: OrchestratorConfig;
  private reconcilerConfig: ReconcilerConfig;
  private completeLLM: ReconcilerCompleteLLM;
  private runCommand: ReconcilerRunCommand;
  private now: () => number;
  private mergeQueue: MergeQueue;
  private monitor: Monitor;
  private systemPrompt: string;
  private targetRepoPath: string;

  private tracer: Tracer | null = null;
  private timer: ReturnType<typeof setTimeout> | null;
  private running: boolean;
  private fixCounter: number;

  private consecutiveGreenSweeps: number;
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;
  private currentIntervalMs: number;

  private sweepCompleteCallbacks: ((result: SweepResult) => void)[];
  private errorCallbacks: ((error: Error) => void)[];
  private setTimeoutFn: typeof setTimeout;
  private clearTimeoutFn: typeof clearTimeout;

  private recentFixScopes: Set<string> = new Set();

  constructor(
    config: OrchestratorConfig,
    reconcilerConfig: ReconcilerConfig,
    _taskQueue: TaskQueue,
    mergeQueue: MergeQueue,
    monitor: Monitor,
    systemPrompt: string,
    deps?: Partial<ReconcilerDeps>,
  ) {
    this.config = config;
    this.reconcilerConfig = reconcilerConfig;
    this.mergeQueue = mergeQueue;
    this.monitor = monitor;
    this.systemPrompt = systemPrompt;
    this.targetRepoPath = config.targetRepoPath;

    this.timer = null;
    this.running = false;
    this.fixCounter = 0;

    this.consecutiveGreenSweeps = 0;
    this.minIntervalMs = Math.min(60_000, reconcilerConfig.intervalMs);
    this.maxIntervalMs = reconcilerConfig.intervalMs;
    this.currentIntervalMs = reconcilerConfig.intervalMs;

    const llmClient = new LLMClient({
      endpoints: config.llm.endpoints,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
      temperature: config.llm.temperature,
      timeoutMs: config.llm.timeoutMs,
    });

    this.completeLLM =
      deps?.completeLLM ??
      ((messages, overrides, span) => llmClient.complete(messages, overrides, span));
    this.runCommand = deps?.runCommand ?? runCommand;
    this.now = deps?.now ?? (() => Date.now());
    this.setTimeoutFn = deps?.setTimeout ?? setTimeout;
    this.clearTimeoutFn = deps?.clearTimeout ?? clearTimeout;

    this.sweepCompleteCallbacks = [];
    this.errorCallbacks = [];
  }

  setTracer(tracer: Tracer): void {
    this.tracer = tracer;
  }

  /**
   * Start the periodic sweep timer
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNextSweep();
    logger.info("Reconciler started", { intervalMs: this.currentIntervalMs });
  }

  /**
   * Stop the periodic sweep timer
   */
  stop(): void {
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info("Reconciler stopped");
  }

  /**
   * Check if reconciler is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Run a single sweep: check build + tests, create fix tasks if needed.
   */
  async sweep(): Promise<SweepResult> {
    logger.info("Starting reconciler sweep");
    const sweepSpan = this.tracer?.startSpan("reconciler.sweep", { agentId: "reconciler" });

    const mergeCountBefore = this.mergeQueue.getMergeStats().totalMerged;

    const buildSpan = sweepSpan?.child("reconciler.build");
    logger.debug("Running tsc --noEmit", { targetRepo: this.targetRepoPath });
    const tscResult = await this.runCommand("npx", ["tsc", "--noEmit"], this.targetRepoPath);
    const buildOutput = tscResult.stdout + tscResult.stderr;
    const buildNotConfigured = /no inputs were found|could not find a valid tsconfig/i.test(
      buildOutput,
    );
    const buildOk =
      buildNotConfigured || (tscResult.code === 0 && !tscResult.stderr?.includes("error TS"));
    logger.debug("tsc result", {
      exitCode: tscResult.code,
      ok: buildOk,
      buildNotConfigured,
      stdoutSize: tscResult.stdout.length,
      stderrSize: tscResult.stderr.length,
      outputPreview: buildOutput.slice(0, 500),
    });
    buildSpan?.setAttributes({ exitCode: tscResult.code ?? -1, ok: buildOk, buildNotConfigured });
    buildSpan?.end();

    const buildRunSpan = sweepSpan?.child("reconciler.buildRun");
    logger.debug("Running npm run build", { targetRepo: this.targetRepoPath });
    const buildRunResult = await this.runCommand(
      "npm",
      ["run", "build", "--if-present"],
      this.targetRepoPath,
    );
    const buildRunOutput = buildRunResult.stdout + buildRunResult.stderr;
    const buildRunNotConfigured =
      /Missing script|npm error|ERR!/i.test(buildRunOutput) &&
      buildRunResult.code !== 0 &&
      !buildRunOutput.includes("error TS");
    const buildRunOk = buildRunNotConfigured || buildRunResult.code === 0;
    logger.debug("npm run build result", {
      exitCode: buildRunResult.code,
      ok: buildRunOk,
      buildRunNotConfigured,
    });
    buildRunSpan?.setAttributes({
      exitCode: buildRunResult.code ?? -1,
      ok: buildRunOk,
      buildRunNotConfigured,
    });
    buildRunSpan?.end();

    const testSpan = sweepSpan?.child("reconciler.test");
    logger.debug("Running npm test", { targetRepo: this.targetRepoPath });
    const testResult = await this.runCommand("npm", ["test"], this.targetRepoPath);
    const testOutput = testResult.stdout + testResult.stderr;
    const testNotConfigured = /Missing script|no test specified/i.test(testOutput);
    const testsOk =
      testNotConfigured || (testResult.code === 0 && !testResult.stderr?.includes("FAIL"));
    logger.debug("npm test result", {
      exitCode: testResult.code,
      ok: testsOk,
      testNotConfigured,
      stdoutSize: testResult.stdout.length,
      stderrSize: testResult.stderr.length,
      outputPreview: testOutput.slice(0, 500),
    });
    testSpan?.setAttributes({ exitCode: testResult.code ?? -1, ok: testsOk, testNotConfigured });
    testSpan?.end();

    const conflictResult = await this.runCommand(
      "git",
      ["grep", "-rl", "<<<<<<<", "--", "*.ts", "*.tsx", "*.js", "*.json"],
      this.targetRepoPath,
    );
    const conflictFiles = conflictResult.stdout.trim().split("\n").filter(Boolean);
    const hasConflictMarkers = conflictFiles.length > 0;

    logger.info("Sweep check results", {
      buildOk,
      buildRunOk,
      testsOk,
      hasConflictMarkers,
      conflictFileCount: conflictFiles.length,
    });

    if (buildOk && buildRunOk && testsOk && !hasConflictMarkers) {
      logger.info("All green — no fix tasks needed");
      sweepSpan?.setAttributes({
        buildOk,
        buildRunOk,
        testsOk,
        hasConflictMarkers,
        fixTasksCreated: 0,
      });
      sweepSpan?.setStatus("ok");
      sweepSpan?.end();

      this.consecutiveGreenSweeps++;
      this.recentFixScopes.clear();
      if (this.consecutiveGreenSweeps >= 3) {
        this.adjustInterval(this.maxIntervalMs);
      }

      return {
        buildOk: true,
        testsOk: true,
        hasConflictMarkers: false,
        buildOutput: "",
        testOutput: "",
        conflictFiles: [],
        fixTasks: [],
      };
    }

    const mergeCountAfter = this.mergeQueue.getMergeStats().totalMerged;
    if (mergeCountAfter > mergeCountBefore) {
      logger.info("Merges occurred during sweep — discarding stale results", {
        mergesBefore: mergeCountBefore,
        mergesAfter: mergeCountAfter,
      });
      sweepSpan?.setAttributes({
        buildOk,
        buildRunOk,
        testsOk,
        hasConflictMarkers,
        staleSkip: true,
        fixTasksCreated: 0,
      });
      sweepSpan?.setStatus("ok", "stale skip");
      sweepSpan?.end();
      return {
        buildOk,
        testsOk,
        hasConflictMarkers,
        buildOutput: "",
        testOutput: "",
        conflictFiles: [],
        fixTasks: [],
      };
    }

    const gitResult = await this.runCommand(
      "git",
      ["log", "--oneline", "-10"],
      this.targetRepoPath,
    );
    const recentCommits = gitResult.stdout.trim();

    let userMessage = "";

    if (hasConflictMarkers) {
      userMessage += `## Merge Conflict Markers Found\nFiles with unresolved conflict markers (<<<<<<< / ======= / >>>>>>>):\n`;
      for (const f of conflictFiles.slice(0, 20)) {
        userMessage += `- ${f}\n`;
      }
      userMessage += `\n`;
    }

    if (!buildOk) {
      userMessage += `## Build Output (tsc --noEmit)\n\`\`\`\n${buildOutput.slice(0, 8000)}\n\`\`\`\n\n`;
    }

    if (!buildRunOk) {
      userMessage += `## Build Output (npm run build)\n\`\`\`\n${buildRunOutput.slice(0, 8000)}\n\`\`\`\n\n`;
    }

    if (!testsOk) {
      userMessage += `## Test Output (npm test)\n\`\`\`\n${testOutput.slice(0, 8000)}\n\`\`\`\n\n`;
    }

    userMessage += `## Recent Commits\n${recentCommits}\n\n`;

    if (this.recentFixScopes.size > 0) {
      userMessage += `## Pending Fix Scopes\nFix tasks already target these files — do NOT create duplicates: ${[...this.recentFixScopes].join(", ")}\n\n`;
    }

    const messages: LLMMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: userMessage },
    ];

    logger.info("Calling LLM for fix task generation", { messageLength: userMessage.length });
    logger.debug("Reconciler LLM prompt", {
      systemPromptSize: this.systemPrompt.length,
      userMessagePreview: userMessage.slice(0, 500),
    });

    let rawTasks: ReturnType<typeof parseLLMTaskArray>;

    try {
      const response = await this.completeLLM(messages, undefined, sweepSpan);
      this.monitor.recordTokenUsage(response.usage.totalTokens);
      logger.debug("Reconciler LLM response", {
        contentLength: response.content.length,
        preview: response.content.slice(0, 500),
        tokens: response.usage.totalTokens,
        endpoint: response.endpoint,
        latencyMs: response.latencyMs,
      });
      rawTasks = parseLLMTaskArray(response.content);
    } catch (llmError) {
      const errMsg = llmError instanceof Error ? llmError.message : String(llmError);
      logger.warn(
        "LLM unreachable for reconciler — skipping fix task generation (will retry next sweep)",
        {
          error: errMsg,
          buildOk,
          testsOk,
          hasConflictMarkers,
        },
      );
      sweepSpan?.setAttributes({
        buildOk,
        buildRunOk,
        testsOk,
        hasConflictMarkers,
        llmFailed: true,
        fixTasksCreated: 0,
      });
      sweepSpan?.setStatus("error", `LLM unreachable: ${errMsg}`);
      sweepSpan?.end();
      return {
        buildOk,
        testsOk,
        hasConflictMarkers,
        buildOutput: buildOk ? "" : buildOutput.slice(0, 8000),
        testOutput: testsOk ? "" : testOutput.slice(0, 8000),
        conflictFiles,
        fixTasks: [],
      };
    }

    const capped = rawTasks.slice(0, this.reconcilerConfig.maxFixTasks);

    const tasks: Task[] = [];
    for (const raw of capped) {
      const scope = raw.scope || [];
      const allScopesCovered = scope.length > 0 && scope.every((f) => this.recentFixScopes.has(f));
      if (allScopesCovered) {
        logger.debug("Skipping duplicate fix task (scope already covered)", { scope });
        continue;
      }

      this.fixCounter++;
      const id = raw.id || `fix-${String(this.fixCounter).padStart(3, "0")}`;
      tasks.push({
        id,
        description: raw.description,
        scope,
        acceptance: raw.acceptance || "tsc --noEmit returns 0 and npm test returns 0",
        branch:
          raw.branch || `${this.config.git.branchPrefix}${id}-${slugifyForBranch(raw.description)}`,
        status: "pending" as const,
        createdAt: this.now(),
        priority: 1,
      });

      for (const f of scope) {
        this.recentFixScopes.add(f);
      }
    }

    logger.info(`Created ${tasks.length} fix tasks`, {
      taskIds: tasks.map((t) => t.id),
      recentFixScopes: this.recentFixScopes.size,
    });

    sweepSpan?.setAttributes({
      buildOk,
      buildRunOk,
      testsOk,
      hasConflictMarkers,
      fixTasksCreated: tasks.length,
    });
    sweepSpan?.setStatus(buildOk && buildRunOk && testsOk && !hasConflictMarkers ? "ok" : "error");
    sweepSpan?.end();

    // Adaptive sweep: errors detected, reset green counter and speed up
    this.consecutiveGreenSweeps = 0;
    this.adjustInterval(this.minIntervalMs);

    return {
      buildOk,
      testsOk,
      hasConflictMarkers,
      buildOutput: buildOk ? "" : buildOutput.slice(0, 8000),
      testOutput: testsOk ? "" : testOutput.slice(0, 8000),
      conflictFiles,
      fixTasks: tasks,
    };
  }

  /**
   * Register callback for sweep completion
   */
  onSweepComplete(callback: (result: SweepResult) => void): void {
    this.sweepCompleteCallbacks.push(callback);
  }

  /**
   * Register callback for errors
   */
  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback);
  }

  getCurrentIntervalMs(): number {
    return this.currentIntervalMs;
  }

  private adjustInterval(targetMs: number): void {
    if (this.currentIntervalMs === targetMs) return;
    this.currentIntervalMs = targetMs;

    if (this.running && this.timer) {
      this.clearTimeoutFn(this.timer);
      this.scheduleNextSweep();
    }

    logger.info("Adjusted sweep interval", {
      newIntervalMs: this.currentIntervalMs,
      consecutiveGreen: this.consecutiveGreenSweeps,
    });
  }

  private scheduleNextSweep(): void {
    if (!this.running) {
      return;
    }

    this.timer = this.setTimeoutFn(() => this.runScheduledSweep(), this.currentIntervalMs);
  }

  private async runScheduledSweep(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.timer = null;

    try {
      const result = await this.sweep();
      for (const cb of this.sweepCompleteCallbacks) {
        cb(result);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Sweep failed", { error: err.message });
      for (const cb of this.errorCallbacks) {
        cb(err);
      }
    } finally {
      if (this.running && !this.timer) {
        this.scheduleNextSweep();
      }
    }
  }
}
