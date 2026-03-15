/**
 * Unit tests for @longshot/core — gap coverage only.
 *
 * Existing test files already cover:
 *   git.test.ts    — getDiffStat, getRecentCommits parsing, mergeBranch conflict, createBranch error
 *   logger.test.ts — NDJSON shape, level filtering, file logging, getLogLevel
 *   tracer.test.ts — span events, propagation, LLM detail
 *
 * This file covers the remaining gaps:
 *   git     — getCurrentBranch, checkoutBranch, getFileTree, hasUncommittedChanges,
 *             getRecentCommits (count + ordering), mergeBranch (fast-forward + rebase strategies)
 *   logger  — withTask context tagging, per-level stdout suppression
 *
 * Uses Node's built-in node:test + node:assert/strict (no extra dependencies).
 * Git tests spin up real hermetic temporary repos and clean up after themselves.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  checkoutBranch,
  createBranch,
  getCurrentBranch,
  getFileTree,
  getRecentCommits,
  hasUncommittedChanges,
  mergeBranch,
} from "../git.js";
import { createLogger, setLogLevel } from "../logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Hermetic git environment: isolate from system/global config and supply
 * author identity so tests cannot fail due to host git configuration.
 */
const GIT_HERMETIC_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
  GIT_COMMITTER_NAME: "Longshot Test",
  GIT_COMMITTER_EMAIL: "test@longshot.test",
  GIT_AUTHOR_NAME: "Longshot Test",
  GIT_AUTHOR_EMAIL: "test@longshot.test",
};

/**
 * Run git hermetially: disable signing, hooks, and templates via -c flags.
 * All calls use an argument array — no shell interpolation.
 */
function git(args: string[], cwd: string): void {
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "init.templateDir=",
      ...args,
    ],
    { cwd, stdio: "pipe", env: GIT_HERMETIC_ENV },
  );
}

/** Initialise a fresh git repo in a temp directory and return its path. */
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "longshot-core-gap-"));
  try {
    git(["init", "-b", "main"], dir);
  } catch {
    git(["init"], dir);
    git(["symbolic-ref", "HEAD", "refs/heads/main"], dir);
  }
  git(["config", "user.email", "test@longshot.test"], dir);
  git(["config", "user.name", "Longshot Test"], dir);
  return dir;
}

/**
 * Stage and commit a single file.
 * Uses the hermetic git() helper — no shell interpolation, no signing.
 */
function seedCommit(dir: string, filename = "README.md", content = "# test"): void {
  const filePath = join(dir, filename);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  git(["add", "."], dir);
  git(["commit", "-m", `add ${filename}`], dir);
}

/** Remove a temp directory unconditionally. */
function rmDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// git — getCurrentBranch  (not covered by git.test.ts)
// ---------------------------------------------------------------------------

describe("git — getCurrentBranch", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
    seedCommit(dir);
  });

  afterEach(() => rmDir(dir));

  it("returns 'main' on a freshly initialised repo", async () => {
    assert.strictEqual(await getCurrentBranch(dir), "main");
  });

  it("reflects the active branch after createBranch", async () => {
    await createBranch("feat/test", dir);
    assert.strictEqual(await getCurrentBranch(dir), "feat/test");
  });
});

// ---------------------------------------------------------------------------
// git — checkoutBranch  (not covered by git.test.ts)
// ---------------------------------------------------------------------------

describe("git — checkoutBranch", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
    seedCommit(dir);
  });

  afterEach(() => rmDir(dir));

  it("switches to an existing branch", async () => {
    await createBranch("feature", dir);
    await checkoutBranch("main", dir);
    assert.strictEqual(await getCurrentBranch(dir), "main");
  });

  it("throws a descriptive error on a non-existent branch", async () => {
    await assert.rejects(
      () => checkoutBranch("does-not-exist", dir),
      (err: Error) => {
        assert.ok(err.message.includes("Failed to checkout branch"), err.message);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// git — getFileTree  (not covered by git.test.ts)
// ---------------------------------------------------------------------------

describe("git — getFileTree", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
  });

  afterEach(() => rmDir(dir));

  it("returns [] when no files are tracked", async () => {
    assert.deepStrictEqual(await getFileTree(dir), []);
  });

  it("lists committed files", async () => {
    seedCommit(dir, "hello.txt", "hi");
    assert.ok((await getFileTree(dir)).includes("hello.txt"));
  });

  it("depth=1 excludes nested paths", async () => {
    mkdirSync(join(dir, "src", "utils"), { recursive: true });
    writeFileSync(join(dir, "root.txt"), "root");
    writeFileSync(join(dir, "src", "index.ts"), "idx");
    writeFileSync(join(dir, "src", "utils", "helper.ts"), "help");
    git(["add", "."], dir);
    git(["commit", "-m", "nested"], dir);

    const files = await getFileTree(dir, 1);
    assert.ok(files.includes("root.txt"));
    assert.ok(!files.includes("src/index.ts"));
    assert.ok(!files.includes("src/utils/helper.ts"));
  });

  it("depth=2 includes one level deep but not two", async () => {
    mkdirSync(join(dir, "src", "utils"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "idx");
    writeFileSync(join(dir, "src", "utils", "helper.ts"), "help");
    git(["add", "."], dir);
    git(["commit", "-m", "nested"], dir);

    const files = await getFileTree(dir, 2);
    assert.ok(files.includes("src/index.ts"));
    assert.ok(!files.includes("src/utils/helper.ts"));
  });

  it("no maxDepth returns all files", async () => {
    mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "c", "deep.ts"), "deep");
    git(["add", "."], dir);
    git(["commit", "-m", "deep"], dir);

    assert.ok((await getFileTree(dir)).includes("a/b/c/deep.ts"));
  });
});

// ---------------------------------------------------------------------------
// git — hasUncommittedChanges  (not covered by git.test.ts)
// ---------------------------------------------------------------------------

describe("git — hasUncommittedChanges", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
    seedCommit(dir);
  });

  afterEach(() => rmDir(dir));

  it("returns false on a clean working tree", async () => {
    assert.strictEqual(await hasUncommittedChanges(dir), false);
  });

  it("returns true after modifying a tracked file", async () => {
    writeFileSync(join(dir, "README.md"), "changed");
    assert.strictEqual(await hasUncommittedChanges(dir), true);
  });

  it("returns true after staging a new file", async () => {
    writeFileSync(join(dir, "new.txt"), "new");
    git(["add", "new.txt"], dir);
    assert.strictEqual(await hasUncommittedChanges(dir), true);
  });

  it("returns false after committing the change", async () => {
    writeFileSync(join(dir, "README.md"), "updated");
    git(["add", "."], dir);
    git(["commit", "-m", "update"], dir);
    assert.strictEqual(await hasUncommittedChanges(dir), false);
  });
});

// ---------------------------------------------------------------------------
// git — getRecentCommits: count + ordering  (git.test.ts only tests parsing)
// ---------------------------------------------------------------------------

describe("git — getRecentCommits (count and ordering)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
  });

  afterEach(() => rmDir(dir));

  it("throws when the branch has no commits yet", async () => {
    await assert.rejects(
      () => getRecentCommits(5, dir),
      (err: Error) => {
        assert.ok(err.message.includes("Failed to get recent commits"), err.message);
        return true;
      },
    );
  });

  it("returns the requested number of commits", async () => {
    seedCommit(dir, "a.txt", "a");
    seedCommit(dir, "b.txt", "b");
    seedCommit(dir, "c.txt", "c");

    assert.strictEqual((await getRecentCommits(3, dir)).length, 3);
    assert.strictEqual((await getRecentCommits(1, dir)).length, 1);
  });

  it("returns commits in reverse-chronological order", async () => {
    seedCommit(dir, "first.txt", "1");
    seedCommit(dir, "second.txt", "2");
    seedCommit(dir, "third.txt", "3");

    const commits = await getRecentCommits(3, dir);
    assert.match(commits[0]?.message ?? "", /add third/);
    assert.match(commits[1]?.message ?? "", /add second/);
    assert.match(commits[2]?.message ?? "", /add first/);
  });

  it("each commit has a non-empty hex hash, message, author, and ms timestamp", async () => {
    seedCommit(dir);
    const [c] = await getRecentCommits(1, dir);
    assert.ok(c, "expected at least one commit");

    // Accept SHA-1 (40 chars) or SHA-256 (64 chars)
    assert.match(c.hash, /^[0-9a-f]{40,64}$/, "hash must be a non-empty hex string");
    assert.ok(c.message.length > 0, "message must not be empty");
    assert.strictEqual(c.author, "Longshot Test");
    assert.ok(c.date > 1_000_000_000_000, "date should be in milliseconds");
  });
});

// ---------------------------------------------------------------------------
// git — mergeBranch: fast-forward + rebase  (git.test.ts only tests merge-commit conflict)
// ---------------------------------------------------------------------------

describe("git — mergeBranch (fast-forward)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
    seedCommit(dir);
  });

  afterEach(() => rmDir(dir));

  it("succeeds and mentions fast-forward in the message", async () => {
    await createBranch("feat/ff", dir);
    seedCommit(dir, "feature.txt", "feature");

    const result = await mergeBranch("feat/ff", "main", "fast-forward", dir);
    assert.strictEqual(result.success, true);
    assert.match(result.message, /fast-forward/i);
  });

  it("makes the feature file available on main after merge", async () => {
    await createBranch("feat/ff2", dir);
    seedCommit(dir, "ff2.txt", "ff2");

    await mergeBranch("feat/ff2", "main", "fast-forward", dir);
    await checkoutBranch("main", dir);
    assert.ok((await getFileTree(dir)).includes("ff2.txt"));
  });
});

describe("git — mergeBranch (rebase)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
    seedCommit(dir);
  });

  afterEach(() => rmDir(dir));

  it("succeeds and the rebased file is present on main afterward", async () => {
    await createBranch("feat/rb", dir);
    seedCommit(dir, "rb.txt", "rebased content");

    const result = await mergeBranch("feat/rb", "main", "rebase", dir);
    assert.strictEqual(result.success, true);

    // Verify repository state: rb.txt must be present on main after the rebase
    await checkoutBranch("main", dir);
    const files = await getFileTree(dir);
    assert.ok(files.includes("rb.txt"), "rebased file must be present on main after rebase");
  });

  it("returns success=false for a non-existent source branch", async () => {
    const result = await mergeBranch("no-such-branch", "main", "rebase", dir);
    assert.strictEqual(result.success, false);
    assert.ok(result.message.length > 0);
  });
});

// ---------------------------------------------------------------------------
// logger — withTask context tagging  (not covered by logger.test.ts)
// ---------------------------------------------------------------------------

describe("logger — withTask context tagging", () => {
  let lines: string[];
  let writeMock: ReturnType<typeof mock.method>;

  beforeEach(() => {
    lines = [];
    writeMock = mock.method(process.stdout, "write", (chunk: string) => {
      lines.push(chunk);
      return true;
    });
    setLogLevel("debug");
  });

  afterEach(() => {
    writeMock.mock.restore();
    setLogLevel("info");
  });

  it("withTask attaches taskId to subsequent entries", () => {
    const logger = createLogger("agent-a", "worker").withTask("task-abc");
    logger.info("tagged");
    const entry = JSON.parse(lines[0] ?? "") as { taskId?: unknown };
    assert.strictEqual(entry.taskId, "task-abc");
  });

  it("base logger without withTask has no taskId", () => {
    createLogger("agent-b", "subplanner").info("no task");
    const entry = JSON.parse(lines[0] ?? "") as { taskId?: unknown };
    assert.strictEqual(entry.taskId, undefined);
  });

  it("withTask returns a new Logger — original is unaffected", () => {
    const base = createLogger("agent-c", "worker");
    const tagged = base.withTask("task-xyz");

    base.info("base");
    tagged.info("tagged");

    const baseEntry = JSON.parse(lines[0] ?? "") as { taskId?: unknown };
    const taggedEntry = JSON.parse(lines[1] ?? "") as { taskId?: unknown };
    assert.strictEqual(baseEntry.taskId, undefined);
    assert.strictEqual(taggedEntry.taskId, "task-xyz");
  });
});

// ---------------------------------------------------------------------------
// logger — per-level stdout suppression  (logger.test.ts only tests warn+error filter)
// ---------------------------------------------------------------------------

describe("logger — stdout level suppression", () => {
  let lines: string[];
  let writeMock: ReturnType<typeof mock.method>;

  beforeEach(() => {
    lines = [];
    writeMock = mock.method(process.stdout, "write", (chunk: string) => {
      lines.push(chunk);
      return true;
    });
  });

  afterEach(() => {
    writeMock.mock.restore();
    setLogLevel("info");
  });

  it("level=debug emits all four levels", () => {
    setLogLevel("debug");
    const logger = createLogger("ag", "worker");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    assert.strictEqual(lines.length, 4);
    const levels = lines.map((l) => (JSON.parse(l) as { level: string }).level);
    assert.deepStrictEqual(levels, ["debug", "info", "warn", "error"]);
  });

  it("level=info suppresses debug only", () => {
    setLogLevel("info");
    const logger = createLogger("ag", "worker");
    logger.debug("silent");
    logger.info("loud");

    assert.strictEqual(lines.length, 1);
    assert.strictEqual((JSON.parse(lines[0] ?? "") as { level: string }).level, "info");
  });

  it("level=error suppresses debug, info, and warn", () => {
    setLogLevel("error");
    const logger = createLogger("ag", "worker");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    assert.strictEqual(lines.length, 1);
    assert.strictEqual((JSON.parse(lines[0] ?? "") as { level: string }).level, "error");
  });
});
