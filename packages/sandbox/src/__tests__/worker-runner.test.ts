/**
 * Regression tests for worker-runner.ts empty-response handling — issue #27.
 *
 * Existing sandbox.test.ts covers: payload parsing, buildTaskPrompt format,
 * buildHandoff structure, and git diff stats.
 *
 * This file covers the gaps by calling real exported helpers:
 *   - detectEmptyResponse()        — pure empty-response detection
 *   - buildEmptyResponseHandoff()  — real failed handoff construction
 *   - isArtifact() + ARTIFACT_PATTERNS — real artifact filtering
 *   - aggregateNumstat()           — real numstat aggregation with artifact filtering
 *   - buildTaskPrompt()            — real prompt construction
 *   - Safety-net commit logic via real git temp repos
 *
 * Uses node:test + node:assert/strict. No extra dependencies.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ARTIFACT_PATTERNS,
  aggregateNumstat,
  buildEmptyResponseHandoff,
  buildTaskPrompt,
  detectEmptyResponse,
  isArtifact,
} from "../worker-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
};

function git(args: string[], cwd: string): string {
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "init.templateDir=",
      ...args,
    ],
    { cwd, stdio: "pipe", env: GIT_ENV, encoding: "utf-8" },
  ).trim();
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "worker-runner-test-"));
  try {
    git(["init", "-b", "main"], dir);
  } catch {
    git(["init"], dir);
    git(["symbolic-ref", "HEAD", "refs/heads/main"], dir);
  }
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

function rmDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// detectEmptyResponse — real exported function
// ---------------------------------------------------------------------------

describe("worker-runner — detectEmptyResponse", () => {
  it("returns true when both tokensUsed and toolCallCount are zero", () => {
    assert.strictEqual(detectEmptyResponse(0, 0), true);
  });

  it("returns false when tokensUsed > 0 even if toolCallCount = 0", () => {
    assert.strictEqual(detectEmptyResponse(42, 0), false);
  });

  it("returns false when toolCallCount > 0 even if tokensUsed = 0", () => {
    assert.strictEqual(detectEmptyResponse(0, 3), false);
  });

  it("returns false when both are non-zero", () => {
    assert.strictEqual(detectEmptyResponse(100, 5), false);
  });
});

// ---------------------------------------------------------------------------
// buildEmptyResponseHandoff — real exported function
// ---------------------------------------------------------------------------

describe("worker-runner — buildEmptyResponseHandoff", () => {
  it("status is 'failed'", () => {
    const h = buildEmptyResponseHandoff("task-001", 1234);
    assert.strictEqual(h.status, "failed");
  });

  it("taskId is preserved", () => {
    const h = buildEmptyResponseHandoff("task-abc", 0);
    assert.strictEqual(h.taskId, "task-abc");
  });

  it("summary mentions empty response or 0 tokens", () => {
    const h = buildEmptyResponseHandoff("task-001", 0);
    const lower = h.summary.toLowerCase();
    assert.ok(
      lower.includes("empty response") || lower.includes("0 tokens"),
      `summary must mention empty response, got: "${h.summary}"`,
    );
  });

  it("concerns is non-empty and mentions API or empty response", () => {
    const h = buildEmptyResponseHandoff("task-001", 0);
    assert.ok(h.concerns.length > 0, "must have at least one concern");
    const text = h.concerns.join(" ").toLowerCase();
    assert.ok(text.includes("empty") || text.includes("api"), `concern: "${h.concerns[0]}"`);
  });

  it("suggestions mention endpoint or model", () => {
    const h = buildEmptyResponseHandoff("task-001", 0);
    assert.ok(h.suggestions.length >= 2);
    const text = h.suggestions.join(" ").toLowerCase();
    assert.ok(text.includes("endpoint") || text.includes("model"));
  });

  it("filesChanged is empty", () => {
    const h = buildEmptyResponseHandoff("task-001", 0);
    assert.deepStrictEqual(h.filesChanged, []);
  });

  it("all line and file metrics are zero", () => {
    const h = buildEmptyResponseHandoff("task-001", 500);
    assert.strictEqual(h.metrics.linesAdded, 0);
    assert.strictEqual(h.metrics.linesRemoved, 0);
    assert.strictEqual(h.metrics.filesCreated, 0);
    assert.strictEqual(h.metrics.filesModified, 0);
    assert.strictEqual(h.metrics.tokensUsed, 0);
    assert.strictEqual(h.metrics.toolCallCount, 0);
  });

  it("durationMs is preserved in metrics", () => {
    const h = buildEmptyResponseHandoff("task-001", 9876);
    assert.strictEqual(h.metrics.durationMs, 9876);
  });
});

// ---------------------------------------------------------------------------
// isArtifact + ARTIFACT_PATTERNS — real exported values
// ---------------------------------------------------------------------------

describe("worker-runner — isArtifact (real export)", () => {
  const artifactPaths = [
    "node_modules/pkg/index.js",
    "node_modules/@scope/pkg/index.js",
    ".next/server/app.js",
    "dist/index.js",
    "build/output.js",
    "out/static/bundle.js",
    ".turbo/cache.json",
    ".tsbuildinfo",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    ".pnpm-store/v3/pkg.tgz",
  ];

  const sourcePaths = [
    "src/index.ts",
    "src/utils/helper.ts",
    "packages/core/src/types.ts",
    "README.md",
    "tsconfig.json",
    ".env.example",
  ];

  it("ARTIFACT_PATTERNS has at least one entry per known category", () => {
    // Verifies the exported array is populated and not accidentally cleared
    assert.ok(
      ARTIFACT_PATTERNS.length >= 8,
      `expected >= 8 patterns, got ${ARTIFACT_PATTERNS.length}`,
    );
  });

  for (const p of artifactPaths) {
    it(`classifies "${p}" as an artifact`, () => {
      assert.strictEqual(isArtifact(p), true, `"${p}" must be an artifact`);
    });
  }

  for (const p of sourcePaths) {
    it(`does NOT classify "${p}" as an artifact`, () => {
      assert.strictEqual(isArtifact(p), false, `"${p}" must not be an artifact`);
    });
  }
});

// ---------------------------------------------------------------------------
// aggregateNumstat — real exported function
// ---------------------------------------------------------------------------

describe("worker-runner — aggregateNumstat (real export)", () => {
  it("returns zeros for empty string", () => {
    const result = aggregateNumstat("");
    assert.strictEqual(result.linesAdded, 0);
    assert.strictEqual(result.linesRemoved, 0);
    assert.deepStrictEqual(result.filesChanged, []);
  });

  it("counts lines from source files", () => {
    const numstat = "10\t2\tsrc/index.ts\n5\t1\tsrc/utils/helper.ts";
    const result = aggregateNumstat(numstat);
    assert.strictEqual(result.linesAdded, 15);
    assert.strictEqual(result.linesRemoved, 3);
    assert.deepStrictEqual(result.filesChanged, ["src/index.ts", "src/utils/helper.ts"]);
  });

  it("excludes artifact files from counts and filesChanged", () => {
    const numstat =
      "1000\t0\tnode_modules/pkg/index.js\n500\t200\tdist/bundle.js\n300\t0\tpnpm-lock.yaml";
    const result = aggregateNumstat(numstat);
    assert.strictEqual(result.linesAdded, 0, "artifact lines must not count toward linesAdded");
    assert.strictEqual(result.linesRemoved, 0);
    assert.deepStrictEqual(result.filesChanged, []);
  });

  it("counts only source files in a mixed numstat diff", () => {
    const numstat = [
      "10\t2\tsrc/index.ts",
      "1000\t0\tnode_modules/pkg/index.js",
      "5\t1\tsrc/utils/helper.ts",
      "500\t200\tdist/bundle.js",
    ].join("\n");
    const result = aggregateNumstat(numstat);
    assert.strictEqual(result.linesAdded, 15, "only src/ lines should count");
    assert.strictEqual(result.linesRemoved, 3);
    assert.deepStrictEqual(result.filesChanged, ["src/index.ts", "src/utils/helper.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Safety-net commit — skipped on empty response (real git repo)
// ---------------------------------------------------------------------------

describe("worker-runner — safety-net commit logic", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
  });
  afterEach(() => rmDir(dir));

  it("no new commit when isEmptyResponse=true (real git repo)", () => {
    const commitsBefore = git(["rev-list", "--count", "HEAD"], dir);

    // Mirror worker-runner.ts: skip safety-net commit if isEmptyResponse
    const isEmptyResponse = detectEmptyResponse(0, 0);
    if (!isEmptyResponse) {
      git(["add", "-A"], dir);
      const staged = git(["diff", "--cached", "--name-only"], dir);
      if (staged) git(["commit", "-m", "feat: auto-commit"], dir);
    }

    assert.strictEqual(
      git(["rev-list", "--count", "HEAD"], dir),
      commitsBefore,
      "commit count must not change on empty response",
    );
  });

  it("safety-net commit IS created when agent did real work (real git repo)", () => {
    const commitsBefore = parseInt(git(["rev-list", "--count", "HEAD"], dir), 10);
    writeFileSync(join(dir, "src.ts"), "export const x = 1;\n");

    const isEmptyResponse = detectEmptyResponse(100, 5);
    if (!isEmptyResponse) {
      git(["add", "-A"], dir);
      const staged = git(["diff", "--cached", "--name-only"], dir);
      if (staged) git(["commit", "-m", "feat: auto-commit"], dir);
    }

    assert.strictEqual(
      parseInt(git(["rev-list", "--count", "HEAD"], dir), 10),
      commitsBefore + 1,
      "one new commit must be created for real work",
    );
  });

  it("scaffold-only files produce no commit on empty response (real git repo)", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    writeFileSync(join(dir, "AGENTS.md"), "# Worker instructions\n");
    const commitsBefore = git(["rev-list", "--count", "HEAD"], dir);

    const isEmptyResponse = detectEmptyResponse(0, 0);
    if (!isEmptyResponse) {
      git(["add", "-A"], dir);
      const staged = git(["diff", "--cached", "--name-only"], dir);
      if (staged) git(["commit", "-m", "feat: auto-commit"], dir);
    }

    assert.strictEqual(
      git(["rev-list", "--count", "HEAD"], dir),
      commitsBefore,
      "scaffold files must not be committed on empty response",
    );
  });
});

// ---------------------------------------------------------------------------
// buildTaskPrompt — real exported function
// ---------------------------------------------------------------------------

describe("worker-runner — buildTaskPrompt", () => {
  const baseTask = {
    id: "task-042",
    description: "Add authentication middleware",
    scope: ["src/middleware/auth.ts", "src/routes/api.ts"],
    acceptance: "All API routes require a valid JWT token",
    branch: "worker/task-042",
    status: "running" as const,
    createdAt: Date.now(),
    priority: 3,
  };

  it("includes task id as a markdown heading", () => {
    assert.ok(buildTaskPrompt(baseTask).includes("## Task: task-042"));
  });

  it("includes description", () => {
    assert.ok(buildTaskPrompt(baseTask).includes("Add authentication middleware"));
  });

  it("includes all scope files", () => {
    assert.ok(buildTaskPrompt(baseTask).includes("src/middleware/auth.ts, src/routes/api.ts"));
  });

  it("includes acceptance criteria", () => {
    assert.ok(buildTaskPrompt(baseTask).includes("All API routes require a valid JWT token"));
  });

  it("includes branch name", () => {
    assert.ok(buildTaskPrompt(baseTask).includes("worker/task-042"));
  });

  it("ends with completion instruction", () => {
    const prompt = buildTaskPrompt(baseTask);
    assert.ok(prompt.includes("Complete this task") && prompt.includes("Commit your changes"));
  });

  it("handles empty scope without throwing", () => {
    const prompt = buildTaskPrompt({ ...baseTask, scope: [] });
    assert.ok(typeof prompt === "string" && prompt.length > 0);
  });
});
