import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { InMemoryTaskStore, JournalTaskStore } from "../task-store.js";

describe("TaskStore", () => {
  it("InMemoryTaskStore tracks active + terminal state", () => {
    const store = new InMemoryTaskStore("test-run", () => 1_000);

    store.markActive("task-1", "worker/task-1", 0);
    assert.equal(store.hasTask("task-1"), true);
    assert.equal(store.isActive("task-1"), true);
    assert.equal(store.getActiveCount(), 1);

    store.markStatus("task-1", "complete", 0);
    assert.equal(store.isActive("task-1"), false);
    assert.equal(store.getActiveCount(), 0);
    assert.deepEqual(store.getAllBranches(), ["worker/task-1"]);
  });

  it("JournalTaskStore persists records across re-instantiation for same run", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "longshot-taskstore-"));
    try {
      const now = (() => {
        let t = 1_000;
        return () => {
          t += 1;
          return t;
        };
      })();

      const first = new JournalTaskStore({ stateDir, runId: "run-a", now, snapshotEveryEvents: 2 });
      first.markActive("task-1", "worker/task-1", 0);
      first.markStatus("task-1", "complete", 0);

      const second = new JournalTaskStore({ stateDir, runId: "run-a", now });
      assert.equal(second.hasTask("task-1"), true);
      assert.equal(second.getActiveCount(), 0);
      assert.deepEqual(second.getAllBranches(), ["worker/task-1"]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("JournalTaskStore isolates records by runId namespace", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "longshot-taskstore-"));
    try {
      const storeA = new JournalTaskStore({ stateDir, runId: "run-a", now: () => 1_000 });
      storeA.markActive("task-1", "worker/task-1", 0);

      const storeB = new JournalTaskStore({ stateDir, runId: "run-b", now: () => 2_000 });
      assert.equal(storeB.hasTask("task-1"), false);
      assert.equal(storeB.getActiveCount(), 0);
      assert.deepEqual(storeB.getAllBranches(), []);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reapStaleActive marks only expired active records as failed", () => {
    const now = (() => {
      let t = 1_000;
      return () => {
        t += 10;
        return t;
      };
    })();

    const store = new InMemoryTaskStore("test-run", now);
    store.markActive("task-old", "worker/task-old", 0);
    store.markActive("task-fresh", "worker/task-fresh", 0);

    const stale = store.reapStaleActive(15);
    assert.deepEqual(stale, ["task-old"]);
    assert.equal(store.isActive("task-old"), false);
    assert.equal(store.isActive("task-fresh"), true);
  });
});
