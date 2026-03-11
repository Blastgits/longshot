import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Reconciler, type ReconcilerDeps } from "../reconciler.js";
import type { TaskQueue } from "../task-queue.js";

function baseConfig() {
  return {
    maxWorkers: 2,
    workerTimeout: 60,
    mergeStrategy: "rebase" as const,
    llm: {
      endpoints: [{ name: "primary", endpoint: "https://llm.example.com", weight: 100 }],
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

function makeRunCommandGreen(): ReconcilerDeps["runCommand"] {
  return async (cmd, args) => {
    if (cmd === "git" && args[0] === "grep") return { stdout: "", stderr: "", code: 1 };
    if (cmd === "git" && args[0] === "log") return { stdout: "abc123 commit", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
}

describe("Reconciler", () => {
  it("returns all-green sweep result when build/test/conflict checks pass", async () => {
    let llmCalled = false;
    const monitor = { recordTokenUsage: () => {} };
    const mergeQueue = { getMergeStats: () => ({ totalMerged: 0 }) };

    const reconciler = new Reconciler(
      baseConfig(),
      { intervalMs: 1_000, maxFixTasks: 5 },
      {} as TaskQueue,
      mergeQueue as never,
      monitor as never,
      "system prompt",
      {
        runCommand: makeRunCommandGreen(),
        completeLLM: async () => {
          llmCalled = true;
          return {
            content: "[]",
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            finishReason: "stop",
            endpoint: "primary",
            latencyMs: 1,
          };
        },
      },
    );

    const result = await reconciler.sweep();

    assert.strictEqual(result.buildOk, true);
    assert.strictEqual(result.testsOk, true);
    assert.strictEqual(result.hasConflictMarkers, false);
    assert.strictEqual(result.fixTasks.length, 0);
    assert.strictEqual(llmCalled, false);
  });

  it("generates fix tasks when checks fail and LLM returns tasks", async () => {
    const tokenUsage: number[] = [];
    const monitor = { recordTokenUsage: (tokens: number) => tokenUsage.push(tokens) };
    const mergeQueue = { getMergeStats: () => ({ totalMerged: 0 }) };

    const runCommand: ReconcilerDeps["runCommand"] = async (cmd, args) => {
      if (cmd === "npx") {
        return { stdout: "", stderr: "error TS2345", code: 1 };
      }
      if (cmd === "npm" && args[0] === "run") {
        return { stdout: "build ok", stderr: "", code: 0 };
      }
      if (cmd === "npm" && args[0] === "test") {
        return { stdout: "tests ok", stderr: "", code: 0 };
      }
      if (cmd === "git" && args[0] === "grep") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (cmd === "git" && args[0] === "log") {
        return { stdout: "abc123 commit", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const reconciler = new Reconciler(
      baseConfig(),
      { intervalMs: 1_000, maxFixTasks: 5 },
      {} as TaskQueue,
      mergeQueue as never,
      monitor as never,
      "system prompt",
      {
        runCommand,
        completeLLM: async () => ({
          content: '[{"description":"Fix compile errors","scope":["src/a.ts"]}]',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: "stop",
          endpoint: "primary",
          latencyMs: 2,
        }),
        now: () => 123,
      },
    );

    const result = await reconciler.sweep();

    assert.strictEqual(result.buildOk, false);
    assert.strictEqual(result.fixTasks.length, 1);
    const firstTask = result.fixTasks[0];
    assert.ok(firstTask);
    assert.match(firstTask.description, /Fix compile errors/);
    assert.deepStrictEqual(tokenUsage, [15]);
  });

  it("start and stop toggle running state", () => {
    const monitor = { recordTokenUsage: () => {} };
    const mergeQueue = { getMergeStats: () => ({ totalMerged: 0 }) };
    const reconciler = new Reconciler(
      baseConfig(),
      { intervalMs: 10_000, maxFixTasks: 5 },
      {} as TaskQueue,
      mergeQueue as never,
      monitor as never,
      "system prompt",
      {
        runCommand: makeRunCommandGreen(),
        completeLLM: async () => ({
          content: "[]",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop",
          endpoint: "primary",
          latencyMs: 1,
        }),
      },
    );

    assert.strictEqual(reconciler.isRunning(), false);
    reconciler.start();
    assert.strictEqual(reconciler.isRunning(), true);
    reconciler.stop();
    assert.strictEqual(reconciler.isRunning(), false);
  });

  it("skips expensive sweep checks when repo fingerprint is unchanged after green result", async () => {
    let tscCalls = 0;
    let buildCalls = 0;
    let testCalls = 0;
    let llmCalled = false;

    const runCommand: ReconcilerDeps["runCommand"] = async (cmd, args) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: "abc123\n", stderr: "", code: 0 };
      }
      if (cmd === "git" && args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (cmd === "git" && args[0] === "grep") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (cmd === "git" && args[0] === "log") {
        return { stdout: "abc123 commit", stderr: "", code: 0 };
      }
      if (cmd === "npx") {
        tscCalls++;
        return { stdout: "", stderr: "", code: 0 };
      }
      if (cmd === "npm" && args[0] === "run") {
        buildCalls++;
        return { stdout: "", stderr: "", code: 0 };
      }
      if (cmd === "npm" && args[0] === "test") {
        testCalls++;
        return { stdout: "", stderr: "", code: 0 };
      }

      return { stdout: "", stderr: "", code: 0 };
    };

    const monitor = { recordTokenUsage: () => {} };
    const mergeQueue = { getMergeStats: () => ({ totalMerged: 0 }) };
    const reconciler = new Reconciler(
      baseConfig(),
      { intervalMs: 1_000, maxFixTasks: 5 },
      {} as TaskQueue,
      mergeQueue as never,
      monitor as never,
      "system prompt",
      {
        runCommand,
        completeLLM: async () => {
          llmCalled = true;
          return {
            content: "[]",
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            finishReason: "stop",
            endpoint: "primary",
            latencyMs: 1,
          };
        },
      },
    );

    await reconciler.sweep();
    await reconciler.sweep();

    assert.strictEqual(tscCalls, 1);
    assert.strictEqual(buildCalls, 1);
    assert.strictEqual(testCalls, 1);
    assert.strictEqual(llmCalled, false);
  });
});
