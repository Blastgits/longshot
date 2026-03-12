import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Handoff, Task } from "@longshot/core";
import { parseLLMTaskArray, slugifyForBranch, WeightedRoundRobinSelector } from "../shared.js";
import type { SubplannerConfig } from "../subplanner.js";
import {
  aggregateHandoffs,
  createFailureHandoff,
  DEFAULT_SUBPLANNER_CONFIG,
  shouldDecompose,
} from "../subplanner.js";

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-001",
    description: "Test task",
    scope: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
    acceptance: "Tests pass",
    branch: "worker/task-001",
    status: "pending",
    createdAt: Date.now(),
    priority: 5,
    ...overrides,
  };
}

function makeHandoff(overrides?: Partial<Handoff>): Handoff {
  return {
    taskId: "task-001",
    status: "complete",
    summary: "Done",
    diff: "diff --git a/file.ts",
    filesChanged: ["src/a.ts"],
    concerns: [],
    suggestions: [],
    metrics: {
      linesAdded: 10,
      linesRemoved: 2,
      filesCreated: 1,
      filesModified: 0,
      tokensUsed: 500,
      toolCallCount: 5,
      durationMs: 3000,
    },
    ...overrides,
  };
}

describe("shouldDecompose", () => {
  const config: SubplannerConfig = { ...DEFAULT_SUBPLANNER_CONFIG };

  it("returns true when scope exceeds threshold and depth is within limit", () => {
    const task = makeTask({ scope: ["a.ts", "b.ts", "c.ts", "d.ts"] });
    assert.strictEqual(shouldDecompose(task, config, 0), true);
  });

  it("returns false when scope is below threshold", () => {
    const task = makeTask({ scope: ["a.ts", "b.ts"] });
    assert.strictEqual(shouldDecompose(task, config, 0), false);
  });

  it("returns false when scope equals threshold minus one", () => {
    const task = makeTask({ scope: ["a.ts", "b.ts", "c.ts"] });
    assert.strictEqual(shouldDecompose(task, config, 0), false);
  });

  it("returns false when depth equals maxDepth", () => {
    const task = makeTask({ scope: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] });
    assert.strictEqual(shouldDecompose(task, config, config.maxDepth), false);
  });

  it("returns false when depth exceeds maxDepth", () => {
    const task = makeTask({ scope: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] });
    assert.strictEqual(shouldDecompose(task, config, config.maxDepth + 1), false);
  });

  it("returns true at depth maxDepth - 1 with sufficient scope", () => {
    const task = makeTask({ scope: ["a.ts", "b.ts", "c.ts", "d.ts"] });
    assert.strictEqual(shouldDecompose(task, config, config.maxDepth - 1), true);
  });

  it("returns false for empty scope", () => {
    const task = makeTask({ scope: [] });
    assert.strictEqual(shouldDecompose(task, config, 0), false);
  });

  it("respects custom config thresholds", () => {
    const customConfig: SubplannerConfig = { maxDepth: 1, scopeThreshold: 2, maxSubtasks: 5 };
    const task = makeTask({ scope: ["a.ts", "b.ts"] });
    assert.strictEqual(shouldDecompose(task, customConfig, 0), true);
    assert.strictEqual(shouldDecompose(task, customConfig, 1), false);
  });
});

describe("DEFAULT_SUBPLANNER_CONFIG", () => {
  it("has sensible defaults", () => {
    assert.strictEqual(DEFAULT_SUBPLANNER_CONFIG.maxDepth, 3);
    assert.strictEqual(DEFAULT_SUBPLANNER_CONFIG.scopeThreshold, 4);
    assert.strictEqual(DEFAULT_SUBPLANNER_CONFIG.maxSubtasks, 10);
  });
});

describe("SubplannerConfig", () => {
  it("allows custom configuration", () => {
    const config: SubplannerConfig = {
      maxDepth: 5,
      scopeThreshold: 6,
      maxSubtasks: 15,
    };

    assert.strictEqual(config.maxDepth, 5);
    assert.strictEqual(config.scopeThreshold, 6);
    assert.strictEqual(config.maxSubtasks, 15);
  });
});

describe("aggregateHandoffs", () => {
  it("all-complete yields complete status", () => {
    const parent = makeTask({ id: "parent-1", description: "Parent" });
    const subtasks = [makeTask({ id: "sub-1" }), makeTask({ id: "sub-2" })];
    const handoffs = [
      makeHandoff({ taskId: "sub-1", status: "complete" }),
      makeHandoff({ taskId: "sub-2", status: "complete" }),
    ];

    const result = aggregateHandoffs(parent, subtasks, handoffs);
    assert.strictEqual(result.status, "complete");
    assert.strictEqual(result.taskId, "parent-1");
  });

  it("all-failed yields failed status", () => {
    const parent = makeTask({ id: "parent-1", description: "Parent" });
    const subtasks = [makeTask({ id: "sub-1" }), makeTask({ id: "sub-2" })];
    const handoffs = [
      makeHandoff({ taskId: "sub-1", status: "failed" }),
      makeHandoff({ taskId: "sub-2", status: "failed" }),
    ];

    const result = aggregateHandoffs(parent, subtasks, handoffs);
    assert.strictEqual(result.status, "failed");
  });

  it("mixed results yield partial status", () => {
    const parent = makeTask({ id: "parent-1", description: "Parent" });
    const subtasks = [makeTask({ id: "sub-1" }), makeTask({ id: "sub-2" })];
    const handoffs = [
      makeHandoff({ taskId: "sub-1", status: "complete" }),
      makeHandoff({ taskId: "sub-2", status: "failed" }),
    ];

    const result = aggregateHandoffs(parent, subtasks, handoffs);
    assert.strictEqual(result.status, "partial");
  });

  it("no-complete-no-failed yields blocked status", () => {
    const parent = makeTask({ id: "parent-1", description: "Parent" });
    const subtasks = [makeTask({ id: "sub-1" }), makeTask({ id: "sub-2" })];
    const handoffs = [
      makeHandoff({ taskId: "sub-1", status: "blocked" }),
      makeHandoff({ taskId: "sub-2", status: "partial" }),
    ];

    const result = aggregateHandoffs(parent, subtasks, handoffs);
    assert.strictEqual(result.status, "blocked");
  });

  it("metrics sum correctly across handoffs", () => {
    const parent = makeTask({ id: "parent-1", description: "Parent" });
    const subtasks = [makeTask({ id: "sub-1" }), makeTask({ id: "sub-2" })];
    const handoffs = [
      makeHandoff({
        taskId: "sub-1",
        metrics: {
          linesAdded: 10,
          linesRemoved: 2,
          filesCreated: 1,
          filesModified: 0,
          tokensUsed: 500,
          toolCallCount: 5,
          durationMs: 3000,
        },
      }),
      makeHandoff({
        taskId: "sub-2",
        metrics: {
          linesAdded: 20,
          linesRemoved: 5,
          filesCreated: 2,
          filesModified: 1,
          tokensUsed: 800,
          toolCallCount: 8,
          durationMs: 5000,
        },
      }),
    ];

    const result = aggregateHandoffs(parent, subtasks, handoffs);
    assert.strictEqual(result.metrics.linesAdded, 30);
    assert.strictEqual(result.metrics.linesRemoved, 7);
    assert.strictEqual(result.metrics.filesCreated, 3);
    assert.strictEqual(result.metrics.filesModified, 1);
    assert.strictEqual(result.metrics.tokensUsed, 1300);
    assert.strictEqual(result.metrics.toolCallCount, 13);
    assert.strictEqual(result.metrics.durationMs, 5000);
  });

  it("filesChanged deduplicates across handoffs", () => {
    const parent = makeTask({ id: "parent-1", description: "Parent" });
    const subtasks = [makeTask({ id: "sub-1" }), makeTask({ id: "sub-2" })];
    const handoffs = [
      makeHandoff({ taskId: "sub-1", filesChanged: ["src/a.ts", "src/b.ts"] }),
      makeHandoff({ taskId: "sub-2", filesChanged: ["src/b.ts", "src/c.ts"] }),
    ];

    const result = aggregateHandoffs(parent, subtasks, handoffs);
    assert.strictEqual(result.filesChanged.length, 3);
    assert.ok(result.filesChanged.includes("src/a.ts"));
    assert.ok(result.filesChanged.includes("src/b.ts"));
    assert.ok(result.filesChanged.includes("src/c.ts"));
  });

  it("concerns and suggestions are prefixed with task IDs", () => {
    const parent = makeTask({ id: "parent-1", description: "Parent" });
    const subtasks = [makeTask({ id: "sub-1" }), makeTask({ id: "sub-2" })];
    const handoffs = [
      makeHandoff({ taskId: "sub-1", concerns: ["concern-A"], suggestions: ["suggestion-X"] }),
      makeHandoff({ taskId: "sub-2", concerns: ["concern-B"], suggestions: [] }),
    ];

    const result = aggregateHandoffs(parent, subtasks, handoffs);
    assert.strictEqual(result.concerns.length, 2);
    assert.strictEqual(result.concerns[0], "[sub-1] concern-A");
    assert.strictEqual(result.concerns[1], "[sub-2] concern-B");
    assert.strictEqual(result.suggestions.length, 1);
    assert.strictEqual(result.suggestions[0], "[sub-1] suggestion-X");
  });
});

describe("createFailureHandoff", () => {
  it("returns a failed handoff with error details", () => {
    const task = makeTask({ id: "task-fail" });
    const error = new Error("Something broke");

    const result = createFailureHandoff(task, error);
    assert.strictEqual(result.taskId, "task-fail");
    assert.strictEqual(result.status, "failed");
    assert.ok(result.summary.includes("Something broke"));
    assert.strictEqual(result.concerns.length, 1);
    assert.strictEqual(result.concerns[0], "Something broke");
    assert.strictEqual(result.filesChanged.length, 0);
    assert.strictEqual(result.metrics.tokensUsed, 0);
  });

  it("includes suggestion for direct worker dispatch", () => {
    const task = makeTask({ id: "task-fail" });
    const error = new Error("timeout");

    const result = createFailureHandoff(task, error);
    assert.strictEqual(result.suggestions.length, 1);
    const firstSuggestion = result.suggestions[0];
    assert.ok(firstSuggestion);
    assert.ok(firstSuggestion.includes("worker"));
  });
});

describe("parseLLMTaskArray", () => {
  it("parses plain JSON array", () => {
    const input = '[{"description": "Do thing", "scope": ["a.ts"]}]';
    const result = parseLLMTaskArray(input);
    assert.strictEqual(result.length, 1);
    const firstTask = result[0];
    assert.ok(firstTask);
    assert.strictEqual(firstTask.description, "Do thing");
    assert.deepStrictEqual(firstTask.scope, ["a.ts"]);
  });

  it("parses JSON wrapped in markdown code block", () => {
    const input = '```json\n[{"description": "Do thing"}]\n```';
    const result = parseLLMTaskArray(input);
    assert.strictEqual(result.length, 1);
    const firstTask = result[0];
    assert.ok(firstTask);
    assert.strictEqual(firstTask.description, "Do thing");
  });

  it("parses JSON with surrounding text", () => {
    const input = 'Here are the tasks:\n[{"description": "Do thing"}]\nDone!';
    const result = parseLLMTaskArray(input);
    assert.strictEqual(result.length, 1);
    const firstTask = result[0];
    assert.ok(firstTask);
    assert.strictEqual(firstTask.description, "Do thing");
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseLLMTaskArray("not json at all"), {
      message: /Failed to parse LLM task decomposition/,
    });
  });

  it("throws on non-array JSON", () => {
    assert.throws(() => parseLLMTaskArray('{"description": "single object"}'), {
      message: /Failed to parse LLM task decomposition/,
    });
  });

  it("parses empty array", () => {
    const result = parseLLMTaskArray("[]");
    assert.strictEqual(result.length, 0);
  });
});

describe("WeightedRoundRobinSelector", () => {
  it("distributes selections smoothly according to weight", () => {
    const selector = new WeightedRoundRobinSelector([
      { name: "primary", weight: 3 },
      { name: "backup", weight: 1 },
    ]);

    const picks = Array.from({ length: 8 }, () => selector.next().name);
    assert.deepStrictEqual(picks, [
      "primary",
      "primary",
      "backup",
      "primary",
      "primary",
      "primary",
      "backup",
      "primary",
    ]);
  });

  it("rejects empty selector inputs", () => {
    assert.throws(() => new WeightedRoundRobinSelector([]), {
      message: /requires at least one item/,
    });
  });
});

describe("scope validation logic", () => {
  it("detects files outside parent scope", () => {
    const parentScope = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const subtaskScope = ["src/a.ts", "src/d.ts"];

    const invalidFiles = subtaskScope.filter((f) => !parentScope.includes(f));
    assert.deepStrictEqual(invalidFiles, ["src/d.ts"]);
  });

  it("filters to only valid files", () => {
    const parentScope = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const subtaskScope = ["src/a.ts", "src/d.ts", "src/e.ts"];

    const validScope = subtaskScope.filter((f) => parentScope.includes(f));
    assert.deepStrictEqual(validScope, ["src/a.ts"]);
  });

  it("accepts fully contained scope", () => {
    const parentScope = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const subtaskScope = ["src/a.ts", "src/b.ts"];

    const invalidFiles = subtaskScope.filter((f) => !parentScope.includes(f));
    assert.strictEqual(invalidFiles.length, 0);
  });

  it("detects fully invalid scope", () => {
    const parentScope = ["src/a.ts", "src/b.ts"];
    const subtaskScope = ["src/x.ts", "src/y.ts"];

    const validScope = subtaskScope.filter((f) => parentScope.includes(f));
    assert.strictEqual(validScope.length, 0);
  });
});

describe("Task parent-child relationships", () => {
  it("subtask inherits parentId", () => {
    const parentTask = makeTask({ id: "task-001" });
    const subtask: Task = {
      ...makeTask({ id: "task-001-sub-1", scope: ["src/a.ts"] }),
      parentId: parentTask.id,
    };

    assert.strictEqual(subtask.parentId, "task-001");
  });

  it("subtask id follows naming convention", () => {
    const parentId = "task-042";
    const subtaskId = `${parentId}-sub-1`;

    assert.strictEqual(subtaskId, "task-042-sub-1");
    assert.ok(subtaskId.startsWith(parentId));
  });

  it("subtask branch follows naming convention", () => {
    const branchPrefix = "worker/";
    const subtaskId = "task-042-sub-3";
    const description = "Implement greedy meshing for the voxel engine";
    const branch = `${branchPrefix}${subtaskId}-${slugifyForBranch(description)}`;

    assert.strictEqual(
      branch,
      "worker/task-042-sub-3-implement-greedy-meshing-for-the-voxel-engine",
    );
  });
});

describe("slugifyForBranch", () => {
  it("lowercases and hyphenates", () => {
    assert.strictEqual(slugifyForBranch("Implement JWT Auth"), "implement-jwt-auth");
  });

  it("strips non-alphanumeric characters", () => {
    assert.strictEqual(
      slugifyForBranch("Fix bug in src/auth.ts (urgent!)"),
      "fix-bug-in-src-auth-ts-urgent",
    );
  });

  it("collapses consecutive hyphens", () => {
    assert.strictEqual(slugifyForBranch("hello   ---   world"), "hello-world");
  });

  it("truncates to max length without trailing hyphen", () => {
    const long = "a]".repeat(100);
    const result = slugifyForBranch(long);
    assert.ok(result.length <= 50);
    assert.ok(!result.endsWith("-"));
  });

  it("handles empty string", () => {
    assert.strictEqual(slugifyForBranch(""), "");
  });
});
