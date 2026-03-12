/** @module Ephemeral worker pool that spawns Python subprocesses for Modal sandbox execution */

/**
 * Worker Pool — Ephemeral sandbox model
 *
 * Each task gets its own short-lived Modal sandbox:
 *   create → write task.json → exec worker-runner.js → read result.json → terminate
 *
 * There is no persistent pool. `start()` and `stop()` are no-ops.
 * `assignTask()` spawns a Python subprocess that handles the full sandbox lifecycle.
 *
 * stdout from spawn_sandbox.py is streamed line-by-line so that intermediate
 * worker logs (tool calls, progress, etc.) are re-emitted as NDJSON "Worker progress"
 * events in real-time — visible in the dashboard while agents are running.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Handoff, HarnessConfig, Span, Task, Tracer } from "@longshot/core";
import { createLogger } from "@longshot/core";
import { WeightedRoundRobinSelector } from "./shared.js";

const logger = createLogger("worker-pool", "root-planner");

type WorkerEndpoint = HarnessConfig["llm"]["endpoints"][number];

function isHandoff(value: unknown): value is Handoff {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (
    !("taskId" in value) ||
    !("status" in value) ||
    !("summary" in value) ||
    !("filesChanged" in value) ||
    !("metrics" in value)
  ) {
    return false;
  }

  return (
    typeof value.taskId === "string" &&
    typeof value.status === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.filesChanged) &&
    typeof value.metrics === "object" &&
    value.metrics !== null
  );
}

export interface Worker {
  id: string;
  currentTask: Task;
  startedAt: number;
}

/**
 * Dependency injection seam for deterministic unit tests.
 *
 * This is intentionally tiny and non-breaking: production uses Node built-ins,
 * while tests can provide stable spawn/timer behavior without forking real processes.
 */
export interface WorkerPoolDeps {
  spawn: typeof spawn;
  createInterface: typeof createInterface;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  now: () => number;
}

export class WorkerPool {
  private activeWorkers: Map<string, Worker>;
  private workerPrompt: string;
  private deps: WorkerPoolDeps;
  private config: {
    maxWorkers: number;
    workerTimeout: number;
    llm: HarnessConfig["llm"];
    git: HarnessConfig["git"];
    pythonPath: string;
    gitToken?: string;
  };
  private tracer: Tracer | null = null;
  private taskCompleteCallbacks: ((handoff: Handoff) => void)[];
  private workerFailedCallbacks: ((taskId: string, error: Error) => void)[];
  private activeToolCalls: Map<string, number>;
  private timedOutBranches: string[] = [];
  private endpointSelector: WeightedRoundRobinSelector<WorkerEndpoint> | null;

  constructor(
    config: {
      maxWorkers: number;
      workerTimeout: number;
      llm: HarnessConfig["llm"];
      git: HarnessConfig["git"];
      pythonPath: string;
      gitToken?: string;
    },
    workerPrompt: string,
    deps?: Partial<WorkerPoolDeps>,
  ) {
    this.activeWorkers = new Map();
    this.workerPrompt = workerPrompt;
    this.deps = {
      spawn,
      createInterface,
      setTimeout,
      clearTimeout,
      now: () => Date.now(),
      ...deps,
    };
    this.config = config;
    this.taskCompleteCallbacks = [];
    this.workerFailedCallbacks = [];
    this.activeToolCalls = new Map();
    this.endpointSelector =
      this.config.llm.endpoints.length > 0
        ? new WeightedRoundRobinSelector(this.config.llm.endpoints)
        : null;
  }

  setTracer(tracer: Tracer): void {
    this.tracer = tracer;
  }

  /**
   * No-op — ephemeral model has no persistent sandboxes to start.
   */
  async start(): Promise<void> {
    logger.info("Worker pool ready (ephemeral mode)", { maxWorkers: this.config.maxWorkers });
  }

  /**
   * No-op — ephemeral sandboxes self-terminate after each task.
   */
  async stop(): Promise<void> {
    logger.info("Worker pool stopped", { activeCount: this.activeWorkers.size });
  }

  async assignTask(task: Task, parentSpan?: Span): Promise<Handoff> {
    const worker: Worker = {
      id: `ephemeral-${task.id}`,
      currentTask: task,
      startedAt: this.deps.now(),
    };
    this.activeWorkers.set(worker.id, worker);

    logger.info("Dispatching task to ephemeral sandbox", { taskId: task.id });

    const workerSpan =
      parentSpan?.child("worker.execute", { taskId: task.id, agentId: "worker-pool" }) ??
      this.tracer?.startSpan("worker.execute", { taskId: task.id, agentId: "worker-pool" });

    const traceCtx =
      workerSpan && this.tracer ? this.tracer.propagationContext(workerSpan) : undefined;

    const endpoint = this.endpointSelector?.next();
    if (!endpoint) {
      throw new Error("No LLM endpoints configured");
    }

    const baseUrl = endpoint.endpoint.replace(/\/+$/, "");
    const llmEndpointUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

    const payload = JSON.stringify({
      task,
      systemPrompt: this.workerPrompt,
      repoUrl: this.config.git.repoUrl,
      gitToken: this.config.gitToken || process.env.GIT_TOKEN || "",
      llmConfig: {
        endpoint: llmEndpointUrl,
        model: this.config.llm.model,
        maxTokens: this.config.llm.maxTokens,
        temperature: this.config.llm.temperature,
        apiKey: endpoint.apiKey,
      },
      trace: traceCtx,
    });

    logger.debug("Sandbox payload prepared", {
      taskId: task.id,
      endpointName: endpoint.name,
      model: this.config.llm.model,
      payloadSize: payload.length,
      hasTraceCtx: !!traceCtx,
    });

    try {
      const handoff = await this.runSandboxStreaming(task.id, task.branch, payload, workerSpan);

      for (const cb of this.taskCompleteCallbacks) {
        cb(handoff);
      }

      workerSpan?.setAttributes({
        status: handoff.status,
        filesChanged: handoff.filesChanged.length,
        tokensUsed: handoff.metrics.tokensUsed,
        toolCallCount: handoff.metrics.toolCallCount,
        durationMs: handoff.metrics.durationMs,
      });
      workerSpan?.setStatus("ok");
      workerSpan?.end();

      logger.info("Task completed", { taskId: task.id, status: handoff.status });

      return handoff;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Ephemeral sandbox failed", { taskId: task.id, error: err.message });

      workerSpan?.setStatus("error", err.message);
      workerSpan?.end();

      for (const cb of this.workerFailedCallbacks) {
        cb(task.id, err);
      }

      throw err;
    } finally {
      this.activeWorkers.delete(worker.id);
      this.activeToolCalls.delete(task.id);
    }
  }

  private runSandboxStreaming(
    taskId: string,
    branchName: string,
    payload: string,
    workerSpan?: Span,
  ): Promise<Handoff> {
    return new Promise<Handoff>((resolve, reject) => {
      const proc = this.deps.spawn(
        this.config.pythonPath,
        ["-u", "infra/spawn_sandbox.py", payload],
        {
          cwd: process.cwd(),
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      logger.debug("Sandbox process spawned", {
        taskId,
        pythonPath: this.config.pythonPath,
        timeoutSec: this.config.workerTimeout,
      });

      const stdoutLines: string[] = [];
      const stderrChunks: string[] = [];
      let settled = false;

      const timer = this.deps.setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill("SIGKILL");
        this.timedOutBranches.push(branchName);
        logger.error("Worker timed out", {
          taskId,
          branch: branchName,
          timeoutSec: this.config.workerTimeout,
        });
        reject(
          new Error(`Sandbox timed out after ${this.config.workerTimeout}s for task ${taskId}`),
        );
      }, this.config.workerTimeout * 1000);

      if (!proc.stdout) {
        this.deps.clearTimeout(timer);
        settled = true;
        reject(new Error(`Sandbox process stdout unavailable for task ${taskId}`));
        return;
      }

      const rl = this.deps.createInterface({ input: proc.stdout });

      rl.on("line", (line: string) => {
        stdoutLines.push(line);
        this.forwardWorkerLine(taskId, line);

        if (workerSpan) {
          const lower = line.toLowerCase();
          if (lower.includes("sandbox created")) {
            workerSpan.event("sandbox.created");
          } else if (lower.includes("repo cloned")) {
            workerSpan.event("sandbox.cloned");
          } else if (lower.includes("starting worker agent")) {
            workerSpan.event("sandbox.workerStarted");
          } else if (lower.includes("pushed branch")) {
            workerSpan.event("sandbox.pushed");
          }
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString("utf-8"));
      });

      proc.on("close", (_code: number | null) => {
        this.deps.clearTimeout(timer);
        if (settled) return;
        settled = true;

        const stderr = stderrChunks.join("");

        logger.debug("Sandbox process exited", {
          taskId,
          exitCode: _code,
          stdoutLines: stdoutLines.length,
          stderrSize: stderr.length,
        });

        if (stderr) {
          const hasErrors = /error|exception|traceback|fatal|panic/i.test(stderr);
          if (hasErrors) {
            logger.warn("Sandbox stderr contains errors", {
              taskId,
              stderr: stderr.slice(0, 800),
            });
          } else {
            logger.debug("Sandbox stderr output", {
              taskId,
              stderr: stderr.slice(0, 500),
            });
          }
        }

        if (stdoutLines.length === 0) {
          reject(new Error(`Sandbox produced no output for task ${taskId}`));
          return;
        }

        const lastLine = stdoutLines.at(-1);
        if (!lastLine) {
          reject(new Error(`Sandbox produced invalid output for task ${taskId}`));
          return;
        }

        try {
          const parsed: unknown = JSON.parse(lastLine);
          if (!isHandoff(parsed)) {
            throw new Error("Sandbox output did not match Handoff shape");
          }

          resolve(parsed);
        } catch {
          reject(
            new Error(`Failed to parse sandbox output as Handoff JSON: ${lastLine.slice(0, 200)}`),
          );
        }
      });

      proc.on("error", (err: Error) => {
        this.deps.clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  }

  private forwardWorkerLine(taskId: string, line: string): void {
    if (line.startsWith("{")) {
      logger.debug("Worker JSON output", { taskId, line: line.slice(0, 300) });
      return;
    }

    const spawnMatch = line.match(/^\[spawn\]\s*(.+)/);
    if (spawnMatch) {
      logger.info("Worker progress", {
        taskId,
        phase: "sandbox",
        detail: spawnMatch[1],
      });
      return;
    }

    const workerMatch = line.match(/^\[worker:[^\]]*\]\s*(.+)/);
    if (workerMatch) {
      const detail = workerMatch[1];
      if (!detail) {
        return;
      }

      logger.info("Worker progress", {
        taskId,
        phase: "execution",
        detail,
      });

      const toolCallMatch = detail.match(/Tool calls:\s*(\d+)/);
      if (toolCallMatch) {
        const toolCallCount = toolCallMatch[1];
        if (toolCallCount) {
          this.activeToolCalls.set(taskId, parseInt(toolCallCount, 10));
        }
      }
      return;
    }

    if (line.trim()) {
      logger.debug("Worker output", { taskId, line: line.slice(0, 200) });
    }
  }

  getAvailableWorkers(): { id: string }[] {
    const available = this.config.maxWorkers - this.activeWorkers.size;
    if (available <= 0) return [];
    return Array.from({ length: available }, (_, i) => ({ id: `slot-${i}` }));
  }

  getAllWorkers(): Worker[] {
    return Array.from(this.activeWorkers.values());
  }

  getWorkerCount(): number {
    return this.activeWorkers.size;
  }

  getActiveTaskCount(): number {
    return this.activeWorkers.size;
  }

  getTotalActiveToolCalls(): number {
    let total = 0;
    for (const count of this.activeToolCalls.values()) {
      total += count;
    }
    return total;
  }

  getTimedOutBranches(): string[] {
    return [...this.timedOutBranches];
  }

  drainTimedOutBranches(): string[] {
    const branches = this.timedOutBranches;
    this.timedOutBranches = [];
    return branches;
  }

  onTaskComplete(callback: (handoff: Handoff) => void): void {
    this.taskCompleteCallbacks.push(callback);
  }

  onWorkerFailed(callback: (taskId: string, error: Error) => void): void {
    this.workerFailedCallbacks.push(callback);
  }
}
