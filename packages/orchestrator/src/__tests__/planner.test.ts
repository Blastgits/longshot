import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Task } from "@longshot/core";
import type { OrchestratorConfig } from "../config.js";
import type { MergeQueue } from "../merge-queue.js";
import type { Monitor } from "../monitor.js";
import { Planner } from "../planner.js";
import type { TaskQueue } from "../task-queue.js";
import type { WorkerPool } from "../worker-pool.js";

function createConfig(): OrchestratorConfig {
  return {
    maxWorkers: 2,
    workerTimeout: 60,
    mergeStrategy: "rebase",
    llm: {
      endpoints: [{ name: "primary", endpoint: "https://llm.example.com", weight: 100 }],
      model: "gpt-test",
      maxTokens: 2048,
      temperature: 0.2,
      timeoutMs: 10_000,
    },
    git: {
      repoUrl: "https://github.com/example/repo.git",
      mainBranch: "main",
      branchPrefix: "worker/",
    },
    sandbox: {
      imageTag: "latest",
      cpuCores: 2,
      memoryMb: 2048,
      idleTimeout: 300,
    },
    targetRepoPath: "/tmp/repo",
    pythonPath: "python3",
    stateDir: "/tmp/taskstore-state",
    runId: "test-run",
    healthCheckInterval: 10,
    readinessTimeoutMs: 120_000,
    finalization: {
      maxAttempts: 2,
      enabled: true,
      sweepTimeoutMs: 120_000,
    },
  };
}

function createTask(id: string, branch: string): Task {
  return {
    id,
    description: `task ${id}`,
    scope: ["src/file.ts"],
    acceptance: "done",
    branch,
    status: "pending",
    createdAt: Date.now(),
    priority: 1,
  };
}

function createPlannerHarness(): {
  planner: Planner;
  enqueueCount: { value: number };
} {
  const taskMap = new Map<string, Task>();
  const enqueueCount = { value: 0 };

  const taskQueueStub = {
    enqueue(task: Task) {
      enqueueCount.value++;
      taskMap.set(task.id, task);
    },
    getById(id: string) {
      return taskMap.get(id);
    },
  } as unknown as TaskQueue;

  const planner = new Planner(
    createConfig(),
    { maxIterations: 10 },
    taskQueueStub,
    {} as WorkerPool,
    {} as MergeQueue,
    {} as Monitor,
    "root prompt",
  );

  const internals = planner as unknown as { dispatchSingleTask: (task: Task) => void };
  internals.dispatchSingleTask = () => {};

  return { planner, enqueueCount };
}

describe("Planner", () => {
  it("injectTask enqueues and tracks dispatched branch", () => {
    const { planner } = createPlannerHarness();
    const task = createTask("task-1", "worker/task-1");

    planner.injectTask(task);

    assert.strictEqual(planner.getActiveTaskCount(), 1);
    assert.deepStrictEqual(planner.getAllDispatchedBranches(), ["worker/task-1"]);
  });

  it("ignores duplicate injected tasks by id", () => {
    const { planner, enqueueCount } = createPlannerHarness();
    const task = createTask("task-dup", "worker/task-dup");

    planner.injectTask(task);
    planner.injectTask(task);

    assert.strictEqual(enqueueCount.value, 1);
    assert.strictEqual(planner.getActiveTaskCount(), 1);
  });

  it("fires onTaskCreated callback once for injected task", () => {
    const { planner } = createPlannerHarness();
    const task = createTask("task-cb", "worker/task-cb");

    const seen: string[] = [];
    planner.onTaskCreated((created) => {
      seen.push(created.id);
    });

    planner.injectTask(task);

    assert.deepStrictEqual(seen, ["task-cb"]);
  });
});
