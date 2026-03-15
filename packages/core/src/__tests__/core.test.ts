/**
 * Unit tests for @longshot/core
 * Run: pnpm --filter @longshot/core test
 *
 * Uses Node's built-in node:test + node:assert/strict — no extra dependencies.
 * Git tests spin up real temp repos via execSync and clean up after themselves.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  checkoutBranch,
  createBranch,
  getCurrentBranch,
  getDiffStat,
  getFileTree,
  getRecentCommits,
  hasUncommittedChanges,
  mergeBranch,
} from "../git.js";
import { createLogger, getLogLevel, setLogLevel } from "../logger.js";
import { createTracer, Tracer } from "../tracer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Initialise a fresh git repo in a temp directory and return its path. */
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "longshot-core-test-"));
  // git init — fall back to renaming HEAD when -b flag is unsupported (git < 2.28)
  try {
    execSync("git init -b main", { cwd: dir, stdio: "pipe" });
  } catch {
    execSync("git init", { cwd: dir, stdio: "pipe" });
    execSync("git symbolic-ref HEAD refs/heads/main", { cwd: dir, stdio: "pipe" });
  }
  execSync('git config user.email "test@longshot.test"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Longshot Test"', { cwd: dir, stdio: "pipe" });
  return dir;
}

/** Stage and commit a single file in the given repo. */
function seedCommit(dir: string, filename = "README.md", content = "# test"): void {
  const filePath = join(dir, filename);
  // Create parent directories if needed (e.g. "src/index.ts")
  mkdirSync(join(dir, filename, ".."), { recursive: true });
  writeFileSync(filePath, content);
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync(`git commit -m "add ${filename}"`, { cwd: dir, stdio: "pipe" });
}

/** Remove a temp directory unconditionally. */
function rmDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

describe("Logger — NDJSON format", () => {
  let lines: string[];
  let writeMock: ReturnType<typeof mock.method>;

  beforeEach(() => {
    lines = [];
    writeMock = mock.method(process.stdout, "write", (chunk: string) => {
      lines.push(chunk);
      return true;
    });
    setLogLevel("debug"); // capture every level
  });

  afterEach(() => {
    writeMock.mock.restore();
    setLogLevel("info"); // restore default
  });

  it("emits a single newline-terminated NDJSON line per call", () => {
    const logger = createLogger("agent-1", "worker");
    logger.info("hello world");

    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0]?.endsWith("\n"), "line must end with \\n");
    // Should parse as valid JSON
    const entry = JSON.parse(lines[0] ?? "");
    assert.strictEqual(typeof entry, "object");
  });

  it("includes required fields: timestamp, level, agentId, agentRole, message", () => {
    const logger = createLogger("agent-2", "reconciler");
    logger.info("check fields");

    const entry = JSON.parse(lines[0] ?? "");
    assert.strictEqual(entry.message, "check fields");
    assert.strictEqual(entry.agentId, "agent-2");
    assert.strictEqual(entry.agentRole, "reconciler");
    assert.strictEqual(entry.level, "info");
    assert.ok(typeof entry.timestamp === "number" && entry.timestamp > 0);
  });

  it("serialises optional data object into the entry", () => {
    const logger = createLogger("agent-3", "root-planner");
    logger.warn("with data", { retries: 3, branch: "feat/x" });

    const entry = JSON.parse(lines[0] ?? "");
    assert.deepStrictEqual(entry.data, { retries: 3, branch: "feat/x" });
  });

  it("emits all four log levels when level=debug", () => {
    const logger = createLogger("agent-4", "worker");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    assert.strictEqual(lines.length, 4);
    const levels = lines.map((l) => JSON.parse(l.trim()).level);
    assert.deepStrictEqual(levels, ["debug", "info", "warn", "error"]);
  });

  it("suppresses debug output when level=info", () => {
    setLogLevel("info");
    const logger = createLogger("agent-5", "worker");
    logger.debug("silent");
    logger.info("loud");

    assert.strictEqual(lines.length, 1);
    assert.strictEqual(JSON.parse(lines[0] ?? "").level, "info");
  });

  it("suppresses debug+info output when level=warn", () => {
    setLogLevel("warn");
    const logger = createLogger("agent-6", "worker");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    assert.strictEqual(lines.length, 2);
    const levels = lines.map((l) => JSON.parse(l.trim()).level);
    assert.deepStrictEqual(levels, ["warn", "error"]);
  });

  it("suppresses everything except error when level=error", () => {
    setLogLevel("error");
    const logger = createLogger("agent-7", "worker");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    assert.strictEqual(lines.length, 1);
    assert.strictEqual(JSON.parse(lines[0] ?? "").level, "error");
  });
});

describe("Logger — getLogLevel / setLogLevel", () => {
  afterEach(() => setLogLevel("info"));

  it("getLogLevel returns the value set by setLogLevel", () => {
    setLogLevel("debug");
    assert.strictEqual(getLogLevel(), "debug");

    setLogLevel("error");
    assert.strictEqual(getLogLevel(), "error");
  });
});

describe("Logger — withTask context tagging", () => {
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

  it("withTask attaches taskId to every subsequent entry", () => {
    const logger = createLogger("agent-8", "worker").withTask("task-abc-123");
    logger.info("tagged entry");

    const entry = JSON.parse(lines[0] ?? "");
    assert.strictEqual(entry.taskId, "task-abc-123");
  });

  it("base logger without withTask has no taskId", () => {
    const logger = createLogger("agent-9", "subplanner");
    logger.info("no task");

    const entry = JSON.parse(lines[0] ?? "");
    assert.strictEqual(entry.taskId, undefined);
  });

  it("withTask returns a new Logger — original is unaffected", () => {
    const base = createLogger("agent-10", "worker");
    const tagged = base.withTask("task-xyz");

    base.info("base log");
    tagged.info("tagged log");

    const baseEntry = JSON.parse(lines[0] ?? "");
    const taggedEntry = JSON.parse(lines[1] ?? "");

    assert.strictEqual(baseEntry.taskId, undefined);
    assert.strictEqual(taggedEntry.taskId, "task-xyz");
  });

  it("all role variants are emitted correctly", () => {
    const roles = ["root-planner", "subplanner", "worker", "reconciler"] as const;
    for (const role of roles) {
      createLogger("r", role).info("role check");
    }
    const emitted = lines.map((l) => JSON.parse(l.trim()).agentRole);
    assert.deepStrictEqual(emitted, roles);
  });
});

// ---------------------------------------------------------------------------
// git — getCurrentBranch
// ---------------------------------------------------------------------------

describe("git — getCurrentBranch", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
    seedCommit(dir); // need at least one commit for HEAD to resolve
  });

  afterEach(() => rmDir(dir));

  it("returns 'main' on a freshly initialised repo", async () => {
    const branch = await getCurrentBranch(dir);
    assert.strictEqual(branch, "main");
  });
});

// ---------------------------------------------------------------------------
// git — createBranch / checkoutBranch
// ---------------------------------------------------------------------------

describe("git — createBranch / checkoutBranch", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
    seedCommit(dir);
  });

  afterEach(() => rmDir(dir));

  it("creates a new branch and HEAD moves to it", async () => {
    await createBranch("feat/hello", dir);
    assert.strictEqual(await getCurrentBranch(dir), "feat/hello");
  });

  it("throws a descriptive error when branch already exists", async () => {
    await createBranch("duplicate", dir);
    await checkoutBranch("main", dir);

    await assert.rejects(
      () => createBranch("duplicate", dir),
      (err: Error) => {
        assert.ok(err.message.includes("Failed to create branch"), err.message);
        return true;
      },
    );
  });

  it("checkoutBranch switches back to an existing branch", async () => {
    await createBranch("feature", dir);
    assert.strictEqual(await getCurrentBranch(dir), "feature");

    await checkoutBranch("main", dir);
    assert.strictEqual(await getCurrentBranch(dir), "main");
  });

  it("checkoutBranch throws on a non-existent branch", async () => {
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
// git — getDiffStat
// ---------------------------------------------------------------------------

describe("git — getDiffStat", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
    seedCommit(dir); // tracked file: README.md
  });

  afterEach(() => rmDir(dir));

  it("returns all-zero stat on a clean working tree", async () => {
    const stat = await getDiffStat(dir);
    assert.deepStrictEqual(stat, { filesChanged: 0, linesAdded: 0, linesRemoved: 0 });
  });

  it("reports added lines when a tracked file is modified", async () => {
    writeFileSync(join(dir, "README.md"), "# test\nnew line\nanother line\n");
    const stat = await getDiffStat(dir);
    assert.ok(stat.filesChanged >= 1, "filesChanged should be >= 1");
    assert.ok(stat.linesAdded >= 2, "linesAdded should reflect appended lines");
  });

  it("reports removed lines when content is deleted", async () => {
    // The original file has one line: "# test"
    writeFileSync(join(dir, "README.md"), "");
    const stat = await getDiffStat(dir);
    assert.ok(stat.linesRemoved >= 1, "linesRemoved should be >= 1");
  });
});

// ---------------------------------------------------------------------------
// git — getRecentCommits
// ---------------------------------------------------------------------------

describe("git — getRecentCommits", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
  });

  afterEach(() => rmDir(dir));

  it("throws a descriptive error when there are no commits", async () => {
    await assert.rejects(
      () => getRecentCommits(5, dir),
      (err: Error) => {
        assert.ok(err.message.includes("Failed to get recent commits"), err.message);
        return true;
      },
    );
  });

  it("returns the correct number of commits", async () => {
    seedCommit(dir, "a.txt", "a");
    seedCommit(dir, "b.txt", "b");
    seedCommit(dir, "c.txt", "c");

    const three = await getRecentCommits(3, dir);
    assert.strictEqual(three.length, 3);

    const one = await getRecentCommits(1, dir);
    assert.strictEqual(one.length, 1);
  });

  it("returns commits in reverse-chronological order (newest first)", async () => {
    seedCommit(dir, "first.txt", "1");
    seedCommit(dir, "second.txt", "2");
    seedCommit(dir, "third.txt", "3");

    const commits = await getRecentCommits(3, dir);
    assert.match(commits[0]?.message ?? "", /add third/);
    assert.match(commits[1]?.message ?? "", /add second/);
    assert.match(commits[2]?.message ?? "", /add first/);
  });

  it("each commit has hash (40 chars), message, author, and ms timestamp", async () => {
    seedCommit(dir);
    const [c] = await getRecentCommits(1, dir);

    assert.strictEqual((c?.hash ?? "").length, 40, "hash should be full SHA-1");
    assert.ok((c?.message ?? "").length > 0, "message must not be empty");
    assert.strictEqual(c?.author ?? "", "Longshot Test");
    assert.ok((c?.date ?? 0) > 1_000_000_000_000, "date should be in milliseconds");
  });
});

// ---------------------------------------------------------------------------
// git — getFileTree
// ---------------------------------------------------------------------------

describe("git — getFileTree", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
  });

  afterEach(() => rmDir(dir));

  it("returns [] when no files are tracked", async () => {
    const files = await getFileTree(dir);
    assert.deepStrictEqual(files, []);
  });

  it("lists committed files", async () => {
    seedCommit(dir, "hello.txt", "hi");
    const files = await getFileTree(dir);
    assert.ok(files.includes("hello.txt"));
  });

  it("depth=1 only returns root-level files", async () => {
    // Create a nested structure manually
    mkdirSync(join(dir, "src", "utils"), { recursive: true });
    writeFileSync(join(dir, "root.txt"), "root");
    writeFileSync(join(dir, "src", "index.ts"), "idx");
    writeFileSync(join(dir, "src", "utils", "helper.ts"), "help");
    execSync("git add .", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "nested"', { cwd: dir, stdio: "pipe" });

    const depth1 = await getFileTree(dir, 1);
    assert.ok(depth1.includes("root.txt"), "root.txt should appear at depth=1");
    assert.ok(!depth1.includes("src/index.ts"), "src/index.ts should NOT appear at depth=1");
    assert.ok(!depth1.includes("src/utils/helper.ts"), "nested file must be excluded at depth=1");
  });

  it("depth=2 includes one-level-deep paths but not two-level-deep", async () => {
    mkdirSync(join(dir, "src", "utils"), { recursive: true });
    writeFileSync(join(dir, "root.txt"), "root");
    writeFileSync(join(dir, "src", "index.ts"), "idx");
    writeFileSync(join(dir, "src", "utils", "helper.ts"), "help");
    execSync("git add .", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "nested"', { cwd: dir, stdio: "pipe" });

    const depth2 = await getFileTree(dir, 2);
    assert.ok(depth2.includes("src/index.ts"), "src/index.ts should appear at depth=2");
    assert.ok(!depth2.includes("src/utils/helper.ts"), "nested file must be excluded at depth=2");
  });

  it("no maxDepth returns all files regardless of nesting", async () => {
    mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "c", "deep.ts"), "deep");
    execSync("git add .", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "deep"', { cwd: dir, stdio: "pipe" });

    const all = await getFileTree(dir);
    assert.ok(all.includes("a/b/c/deep.ts"), "deep file should appear without maxDepth");
  });
});

// ---------------------------------------------------------------------------
// git — hasUncommittedChanges
// ---------------------------------------------------------------------------

describe("git — hasUncommittedChanges", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
    seedCommit(dir); // tracked file: README.md
  });

  afterEach(() => rmDir(dir));

  it("returns false on a clean working tree", async () => {
    assert.strictEqual(await hasUncommittedChanges(dir), false);
  });

  it("returns true after modifying a tracked file", async () => {
    writeFileSync(join(dir, "README.md"), "changed content");
    assert.strictEqual(await hasUncommittedChanges(dir), true);
  });

  it("returns true after staging a new file", async () => {
    writeFileSync(join(dir, "new-file.txt"), "brand new");
    execSync("git add new-file.txt", { cwd: dir, stdio: "pipe" });
    assert.strictEqual(await hasUncommittedChanges(dir), true);
  });

  it("returns false after staging AND committing the change", async () => {
    writeFileSync(join(dir, "README.md"), "updated");
    execSync("git add .", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "update readme"', { cwd: dir, stdio: "pipe" });
    assert.strictEqual(await hasUncommittedChanges(dir), false);
  });
});

// ---------------------------------------------------------------------------
// git — mergeBranch
// ---------------------------------------------------------------------------

describe("git — mergeBranch (fast-forward)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
    seedCommit(dir); // initial commit on main
  });

  afterEach(() => rmDir(dir));

  it("succeeds and reports fast-forward in the message", async () => {
    await createBranch("feat/ff", dir);
    seedCommit(dir, "feature.txt", "feature content");

    const result = await mergeBranch("feat/ff", "main", "fast-forward", dir);
    assert.strictEqual(result.success, true);
    assert.match(result.message, /fast-forward/i);
  });

  it("leaves main on the feature commit after merge", async () => {
    await createBranch("feat/ff2", dir);
    seedCommit(dir, "ff2.txt", "ff2");

    await mergeBranch("feat/ff2", "main", "fast-forward", dir);
    await checkoutBranch("main", dir);

    // The newly added file should now be present on main
    const files = await getFileTree(dir);
    assert.ok(files.includes("ff2.txt"));
  });
});

describe("git — mergeBranch (merge-commit)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
    seedCommit(dir);
  });

  afterEach(() => rmDir(dir));

  it("succeeds with merge-commit strategy", async () => {
    await createBranch("feat/mc", dir);
    seedCommit(dir, "mc.txt", "merge commit");

    const result = await mergeBranch("feat/mc", "main", "merge-commit", dir);
    assert.strictEqual(result.success, true);
  });
});

describe("git — mergeBranch (rebase)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
    seedCommit(dir);
  });

  afterEach(() => rmDir(dir));

  it("succeeds and replays commits onto main", async () => {
    await createBranch("feat/rb", dir);
    seedCommit(dir, "rb.txt", "rebased content");

    const result = await mergeBranch("feat/rb", "main", "rebase", dir);
    assert.strictEqual(result.success, true);
  });

  it("returns success=false for a non-existent source branch", async () => {
    const result = await mergeBranch("no-such-branch", "main", "rebase", dir);
    assert.strictEqual(result.success, false);
    assert.ok(result.message.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

describe("Tracer — createTracer", () => {
  it("returns a Tracer with a non-empty traceId", () => {
    const tracer = createTracer();
    assert.ok(tracer.getTraceId().length > 0);
  });

  it("accepts a caller-supplied traceId", () => {
    const tracer = createTracer("fixed-trace-id");
    assert.strictEqual(tracer.getTraceId(), "fixed-trace-id");
  });

  it("two tracers created without an id have distinct traceIds", () => {
    const a = createTracer();
    const b = createTracer();
    assert.notStrictEqual(a.getTraceId(), b.getTraceId());
  });
});

describe("Tracer — spans", () => {
  it("startSpan returns a Span with a non-empty spanId", () => {
    const tracer = createTracer();
    const span = tracer.startSpan("op");
    assert.ok(span.spanId.length > 0);
    span.end();
  });

  it("span.context() carries the correct traceId and spanId", () => {
    const tracer = createTracer();
    const span = tracer.startSpan("ctx-check");
    const ctx = span.context();
    assert.strictEqual(ctx.traceId, tracer.getTraceId());
    assert.strictEqual(ctx.spanId, span.spanId);
    assert.strictEqual(ctx.parentSpanId, undefined);
    span.end();
  });

  it("child span has parentSpanId equal to parent spanId", () => {
    const tracer = createTracer();
    const parent = tracer.startSpan("parent");
    const child = parent.child("child");
    assert.strictEqual(child.context().parentSpanId, parent.spanId);
    child.end();
    parent.end();
  });

  it("nested children carry the correct grandparent chain", () => {
    const tracer = createTracer();
    const root = tracer.startSpan("root");
    const mid = root.child("mid");
    const leaf = mid.child("leaf");

    assert.strictEqual(mid.context().parentSpanId, root.spanId);
    assert.strictEqual(leaf.context().parentSpanId, mid.spanId);

    leaf.end();
    mid.end();
    root.end();
  });

  it("span.end() is idempotent — calling twice does not throw", () => {
    const tracer = createTracer();
    const span = tracer.startSpan("idempotent");
    assert.doesNotThrow(() => {
      span.end();
      span.end(); // second call should not throw
    });
  });
});

describe("Tracer — propagation", () => {
  it("propagationContext returns the tracer's traceId and span's spanId", () => {
    const tracer = createTracer();
    const span = tracer.startSpan("propagate");
    const ctx = tracer.propagationContext(span);
    assert.strictEqual(ctx.traceId, tracer.getTraceId());
    assert.strictEqual(ctx.parentSpanId, span.spanId);
    span.end();
  });

  it("Tracer.fromPropagated restores the original traceId", () => {
    const original = createTracer();
    const span = original.startSpan("root");
    const propagated = Tracer.fromPropagated(original.propagationContext(span));
    assert.strictEqual(propagated.getTraceId(), original.getTraceId());
    span.end();
  });
});
