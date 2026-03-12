import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Handoff, LLMEndpoint, Task } from "@longshot/core";
import { WorkerPool } from "../worker-pool.js";

function makeTask(id: string): Task {
  return {
    id,
    description: `Task ${id}`,
    scope: ["src/example.ts"],
    acceptance: "done",
    branch: `worker/${id}`,
    status: "pending",
    createdAt: Date.now(),
    priority: 1,
  };
}

function makeHandoff(taskId: string): Handoff {
  return {
    taskId,
    status: "complete",
    summary: "Completed",
    diff: "",
    filesChanged: ["src/example.ts"],
    concerns: [],
    suggestions: [],
    metrics: {
      linesAdded: 1,
      linesRemoved: 0,
      filesCreated: 0,
      filesModified: 1,
      tokensUsed: 42,
      toolCallCount: 2,
      durationMs: 150,
    },
  };
}

function makePoolConfig(withEndpoints: boolean = true, endpoints?: LLMEndpoint[]) {
  return {
    maxWorkers: 2,
    workerTimeout: 30,
    llm: {
      endpoints: withEndpoints
        ? (endpoints ?? [{ name: "primary", endpoint: "https://llm.example.com", weight: 100 }])
        : [],
      model: "gpt-test",
      maxTokens: 2048,
      temperature: 0.1,
      timeoutMs: 10_000,
    },
    git: {
      repoUrl: "https://github.com/example/repo.git",
      mainBranch: "main",
      branchPrefix: "worker/",
    },
    pythonPath: "python3",
  };
}

describe("WorkerPool", () => {
  it("start/stop are safe no-ops in ephemeral mode", async () => {
    const pool = new WorkerPool(makePoolConfig(), "worker prompt", { now: () => 1_000 });
    await pool.start();
    assert.strictEqual(pool.getWorkerCount(), 0);
    await pool.stop();
    assert.strictEqual(pool.getWorkerCount(), 0);
  });

  it("throws when assigning a task without configured endpoints", async () => {
    const pool = new WorkerPool(makePoolConfig(false), "worker prompt", { now: () => 2_000 });
    await assert.rejects(
      () => pool.assignTask(makeTask("task-no-endpoint")),
      /No LLM endpoints configured/,
    );
  });

  it("returns handoff, fires callbacks, and clears worker state on success", async () => {
    const pool = new WorkerPool(makePoolConfig(), "worker prompt", { now: () => 3_000 });
    const task = makeTask("task-success");
    const expectedHandoff = makeHandoff(task.id);

    const internals = pool as unknown as {
      runSandboxStreaming: (
        taskId: string,
        branch: string,
        payload: string,
        parentSpan?: unknown,
      ) => Promise<Handoff>;
    };
    internals.runSandboxStreaming = async () => expectedHandoff;

    let callbackHandoff: Handoff | undefined;
    pool.onTaskComplete((handoff) => {
      callbackHandoff = handoff;
    });

    const result = await pool.assignTask(task);

    assert.strictEqual(result.taskId, task.id);
    assert.strictEqual(pool.getWorkerCount(), 0);
    assert.strictEqual(pool.getTotalActiveToolCalls(), 0);
    assert.strictEqual(callbackHandoff?.taskId, task.id);
  });

  it("routes worker payloads across weighted endpoints instead of pinning the first", async () => {
    const endpoints: LLMEndpoint[] = [
      { name: "primary", endpoint: "https://primary.example.com", weight: 3, apiKey: "pk-1" },
      { name: "backup", endpoint: "https://backup.example.com", weight: 1, apiKey: "pk-2" },
    ];
    const pool = new WorkerPool(makePoolConfig(true, endpoints), "worker prompt", {
      now: () => 4_000,
    });

    const seenEndpoints: string[] = [];
    const internals = pool as unknown as {
      runSandboxStreaming: (
        taskId: string,
        branch: string,
        payload: string,
        parentSpan?: unknown,
      ) => Promise<Handoff>;
    };
    internals.runSandboxStreaming = async (taskId, _branch, payload) => {
      const parsed = JSON.parse(payload) as { llmConfig: { endpoint: string } };
      seenEndpoints.push(parsed.llmConfig.endpoint);
      return makeHandoff(taskId);
    };

    for (let i = 0; i < 8; i++) {
      await pool.assignTask(makeTask(`task-route-${i}`));
    }

    const primaryEndpoint = "https://primary.example.com/v1";
    const backupEndpoint = "https://backup.example.com/v1";
    assert.strictEqual(seenEndpoints.filter((endpoint) => endpoint === primaryEndpoint).length, 6);
    assert.strictEqual(seenEndpoints.filter((endpoint) => endpoint === backupEndpoint).length, 2);
    assert.ok(seenEndpoints.includes(backupEndpoint));
  });
});
