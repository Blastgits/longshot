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

function createTimerHarness() {
  let nextId = 1;
  const pending = new Map<number, { ms: number; callback: () => unknown }>();

  return {
    setTimeout: ((callback: () => unknown, ms?: number) => {
      const id = nextId++;
      pending.set(id, { ms: ms ?? 0, callback: () => callback() });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: ((handle: ReturnType<typeof setTimeout>) => {
      pending.delete(handle as unknown as number);
    }) as typeof clearTimeout,
    getPendingCount(): number {
      return pending.size;
    },
    getOnlyPendingDelay(): number | undefined {
      const [timer] = pending.values();
      return timer?.ms;
    },
    async fireNext(): Promise<void> {
      const entries = [...pending.entries()];
      assert.strictEqual(
        entries.length,
        1,
        `Expected exactly one pending timer, found ${entries.length}`,
      );
      const [id, timer] = entries[0] ?? [];
      assert.ok(id !== undefined);
      assert.ok(timer);
      pending.delete(id);
      await timer.callback();
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

  it("adapts the scheduled interval after failures and sustained recovery", async () => {
    const monitor = { recordTokenUsage: () => {} };
    const mergeQueue = { getMergeStats: () => ({ totalMerged: 0 }) };
    const timers = createTimerHarness();
    const sweepModes = ["fail", "green", "green", "green"] as const;
    let sweepIndex = -1;
    let currentMode: (typeof sweepModes)[number] = "green";

    const runCommand: ReconcilerDeps["runCommand"] = async (cmd, args) => {
      if (cmd === "npx") {
        sweepIndex++;
        currentMode = sweepModes[sweepIndex] ?? "green";
        if (currentMode === "fail") {
          return { stdout: "", stderr: "error TS2345", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
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
      { intervalMs: 120_000, maxFixTasks: 5 },
      {} as TaskQueue,
      mergeQueue as never,
      monitor as never,
      "system prompt",
      {
        runCommand,
        completeLLM: async () => ({
          content: "[]",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop",
          endpoint: "primary",
          latencyMs: 1,
        }),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
      },
    );

    reconciler.start();
    assert.strictEqual(timers.getOnlyPendingDelay(), 120_000);

    await timers.fireNext();
    assert.strictEqual(reconciler.getCurrentIntervalMs(), 60_000);
    assert.strictEqual(timers.getOnlyPendingDelay(), 60_000);

    await timers.fireNext();
    assert.strictEqual(reconciler.getCurrentIntervalMs(), 60_000);
    assert.strictEqual(timers.getOnlyPendingDelay(), 60_000);

    await timers.fireNext();
    assert.strictEqual(reconciler.getCurrentIntervalMs(), 60_000);
    assert.strictEqual(timers.getOnlyPendingDelay(), 60_000);

    await timers.fireNext();
    assert.strictEqual(reconciler.getCurrentIntervalMs(), 120_000);
    assert.strictEqual(timers.getOnlyPendingDelay(), 120_000);

    reconciler.stop();
    assert.strictEqual(timers.getPendingCount(), 0);
  });

  it("waits for an in-flight sweep to finish before scheduling the next one", async () => {
    const monitor = { recordTokenUsage: () => {} };
    const mergeQueue = { getMergeStats: () => ({ totalMerged: 0 }) };
    const timers = createTimerHarness();
    const firstBuildCheck = createDeferred<{
      stdout: string;
      stderr: string;
      code: number | null;
    }>();
    let buildChecks = 0;

    const runCommand: ReconcilerDeps["runCommand"] = async (cmd, args) => {
      if (cmd === "npx") {
        buildChecks++;
        if (buildChecks === 1) {
          return firstBuildCheck.promise;
        }
        return { stdout: "", stderr: "", code: 0 };
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
      { intervalMs: 120_000, maxFixTasks: 5 },
      {} as TaskQueue,
      mergeQueue as never,
      monitor as never,
      "system prompt",
      {
        runCommand,
        completeLLM: async () => ({
          content: "[]",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop",
          endpoint: "primary",
          latencyMs: 1,
        }),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
      },
    );

    reconciler.start();
    const pendingSweep = timers.fireNext();

    assert.strictEqual(timers.getPendingCount(), 0);

    firstBuildCheck.resolve({ stdout: "", stderr: "", code: 0 });
    await pendingSweep;

    assert.strictEqual(timers.getPendingCount(), 1);
    assert.strictEqual(timers.getOnlyPendingDelay(), 120_000);

    reconciler.stop();
    assert.strictEqual(timers.getPendingCount(), 0);
  });
});
