import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Task, TaskStatus } from "@longshot/core";
import { PriorityQueue, TaskQueue } from "../task-queue.js";

/**
 * Helper function to create test tasks
 */
function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    description: "Test task",
    scope: ["src/test.ts"],
    acceptance: "Test passes",
    branch: "worker/test",
    status: "pending",
    createdAt: Date.now(),
    priority: 5,
    ...overrides,
  };
}

describe("PriorityQueue", () => {
  it("enqueue and dequeue single task", () => {
    const queue = new PriorityQueue();
    const task = makeTask({ priority: 1 });

    queue.enqueue(task);
    const result = queue.dequeue();

    assert.strictEqual(result, task, "Dequeue should return the enqueued task");
  });

  it("dequeue returns undefined on empty queue", () => {
    const queue = new PriorityQueue();
    const result = queue.dequeue();

    assert.strictEqual(result, undefined, "Dequeue on empty queue should return undefined");
  });

  it("priority ordering — lower number first", () => {
    const queue = new PriorityQueue();

    queue.enqueue(makeTask({ priority: 5, createdAt: 100 }));
    queue.enqueue(makeTask({ priority: 1, createdAt: 200 }));
    queue.enqueue(makeTask({ priority: 3, createdAt: 300 }));

    const first = queue.dequeue();
    const second = queue.dequeue();
    const third = queue.dequeue();

    assert.strictEqual(first?.priority, 1, "First dequeued should have priority 1");
    assert.strictEqual(second?.priority, 3, "Second dequeued should have priority 3");
    assert.strictEqual(third?.priority, 5, "Third dequeued should have priority 5");
  });

  it("FIFO for same priority", () => {
    const queue = new PriorityQueue();

    const task1 = makeTask({ priority: 5, createdAt: 100 });
    const task2 = makeTask({ priority: 5, createdAt: 200 });
    const task3 = makeTask({ priority: 5, createdAt: 300 });

    queue.enqueue(task3); // Add in reverse order
    queue.enqueue(task1);
    queue.enqueue(task2);

    const first = queue.dequeue();
    const second = queue.dequeue();
    const third = queue.dequeue();

    assert.strictEqual(first?.id, task1.id, "First should be earliest createdAt");
    assert.strictEqual(second?.id, task2.id, "Second should be middle createdAt");
    assert.strictEqual(third?.id, task3.id, "Third should be latest createdAt");
  });

  it("peek returns highest priority without removing", () => {
    const queue = new PriorityQueue();

    const task1 = makeTask({ priority: 1 });
    const task2 = makeTask({ priority: 10 });

    queue.enqueue(task2);
    queue.enqueue(task1);

    const peeked = queue.peek();
    const sizeBefore = queue.size();

    assert.strictEqual(peeked?.id, task1.id, "Peek should return highest priority task");
    assert.strictEqual(queue.size(), sizeBefore, "Size should remain unchanged after peek");
  });

  it("size tracks correctly", () => {
    const queue = new PriorityQueue();

    assert.strictEqual(queue.size(), 0, "Empty queue should have size 0");

    const task1 = makeTask();
    const task2 = makeTask();
    const task3 = makeTask();

    queue.enqueue(task1);
    queue.enqueue(task2);
    queue.enqueue(task3);

    assert.strictEqual(queue.size(), 3, "Queue with 3 tasks should have size 3");

    queue.dequeue();

    assert.strictEqual(queue.size(), 2, "Queue after 1 dequeue should have size 2");
  });

  it("isEmpty", () => {
    const queue = new PriorityQueue();

    assert.strictEqual(queue.isEmpty(), true, "New queue should be empty");

    queue.enqueue(makeTask());

    assert.strictEqual(queue.isEmpty(), false, "Queue with task should not be empty");

    queue.dequeue();

    assert.strictEqual(queue.isEmpty(), true, "Queue after dequeuing all should be empty");
  });

  it("toArray returns sorted copy", () => {
    const queue = new PriorityQueue();

    const task1 = makeTask({ priority: 3, createdAt: 100 });
    const task2 = makeTask({ priority: 1, createdAt: 200 });
    const task3 = makeTask({ priority: 2, createdAt: 300 });

    queue.enqueue(task1);
    queue.enqueue(task2);
    queue.enqueue(task3);

    const arr = queue.toArray();

    assert.strictEqual(arr[0]?.priority, 1, "First element should have priority 1");
    assert.strictEqual(arr[1]?.priority, 2, "Second element should have priority 2");
    assert.strictEqual(arr[2]?.priority, 3, "Third element should have priority 3");
    assert.strictEqual(queue.size(), 3, "Original queue should be unchanged");
  });
});

describe("TaskQueue", () => {
  it("enqueue adds pending task", () => {
    const taskQueue = new TaskQueue();
    const task = makeTask({ status: "pending" });

    taskQueue.enqueue(task);

    assert.strictEqual(taskQueue.getTotalCount(), 1, "Total count should be 1");
    assert.strictEqual(taskQueue.getByStatus("pending").length, 1, "Should have 1 pending task");
  });

  it("enqueue rejects non-pending task", () => {
    const taskQueue = new TaskQueue();
    const task = makeTask({ status: "running" });

    assert.throws(
      () => taskQueue.enqueue(task),
      /Only pending tasks can be enqueued/,
      "Should throw when enqueuing non-pending task",
    );
  });

  it("enqueue rejects duplicate task IDs", () => {
    const taskQueue = new TaskQueue();
    const taskId = "task-duplicate";
    const first = makeTask({ id: taskId, description: "first" });
    const second = makeTask({ id: taskId, description: "second" });

    taskQueue.enqueue(first);

    assert.throws(() => taskQueue.enqueue(second), /already exists/);
    assert.strictEqual(taskQueue.getTotalCount(), 1);
    assert.strictEqual(taskQueue.getById(taskId)?.description, "first");
  });

  it("getNextPending returns highest priority", () => {
    const taskQueue = new TaskQueue();

    const lowPriority = makeTask({ priority: 10, createdAt: 100 });
    const highPriority = makeTask({ priority: 1, createdAt: 200 });
    const mediumPriority = makeTask({ priority: 5, createdAt: 300 });

    taskQueue.enqueue(lowPriority);
    taskQueue.enqueue(highPriority);
    taskQueue.enqueue(mediumPriority);

    const next = taskQueue.getNextPending();

    assert.strictEqual(next?.id, highPriority.id, "Should return highest priority task");
  });

  it("getById returns task", () => {
    const taskQueue = new TaskQueue();
    const task = makeTask();

    taskQueue.enqueue(task);

    const found = taskQueue.getById(task.id);

    assert.strictEqual(found?.id, task.id, "Should find the enqueued task");
  });

  it("getById returns undefined for missing", () => {
    const taskQueue = new TaskQueue();

    const found = taskQueue.getById("nonexistent");

    assert.strictEqual(found, undefined, "Should return undefined for missing task");
  });

  it("assignTask transitions pending → assigned", () => {
    const taskQueue = new TaskQueue();
    const task = makeTask();
    const sandboxId = "sandbox-123";

    taskQueue.enqueue(task);
    taskQueue.assignTask(task.id, sandboxId);

    const assignedTasks = taskQueue.getByStatus("assigned");
    assert.strictEqual(assignedTasks.length, 1, "Should have 1 assigned task");

    const found = taskQueue.getById(task.id);
    assert.strictEqual(found?.assignedTo, sandboxId, "Task should be assigned to sandbox");
    assert.strictEqual(found?.status, "assigned", "Task status should be assigned");
  });

  it("startTask transitions assigned → running", () => {
    const taskQueue = new TaskQueue();
    const task = makeTask();

    taskQueue.enqueue(task);
    taskQueue.assignTask(task.id, "sandbox-123");
    taskQueue.startTask(task.id);

    const found = taskQueue.getById(task.id);
    assert.ok(found?.startedAt, "Task should have startedAt set");
    assert.strictEqual(found?.status, "running", "Task status should be running");
  });

  it("completeTask transitions running → complete", () => {
    const taskQueue = new TaskQueue();
    const task = makeTask();

    taskQueue.enqueue(task);
    taskQueue.assignTask(task.id, "sandbox-123");
    taskQueue.startTask(task.id);
    taskQueue.completeTask(task.id);

    const found = taskQueue.getById(task.id);
    assert.ok(found?.completedAt, "Task should have completedAt set");
    assert.strictEqual(found?.status, "complete", "Task status should be complete");
  });

  it("failTask transitions running → failed", () => {
    const taskQueue = new TaskQueue();
    const task = makeTask();

    taskQueue.enqueue(task);
    taskQueue.assignTask(task.id, "sandbox-123");
    taskQueue.startTask(task.id);
    taskQueue.failTask(task.id);

    const found = taskQueue.getById(task.id);
    assert.ok(found?.completedAt, "Task should have completedAt set");
    assert.strictEqual(found?.status, "failed", "Task status should be failed");
  });

  it("cancelTask works from any active state", () => {
    const taskQueue = new TaskQueue();

    // Cancel from pending
    const pendingTask = makeTask({ id: "task-pending" });
    taskQueue.enqueue(pendingTask);
    taskQueue.cancelTask(pendingTask.id);
    assert.strictEqual(
      taskQueue.getById(pendingTask.id)?.status,
      "cancelled",
      "Pending task should be cancelled",
    );

    // Cancel from assigned
    const assignedTask = makeTask({ id: "task-assigned" });
    taskQueue.enqueue(assignedTask);
    taskQueue.assignTask(assignedTask.id, "sandbox-1");
    taskQueue.cancelTask(assignedTask.id);
    assert.strictEqual(
      taskQueue.getById(assignedTask.id)?.status,
      "cancelled",
      "Assigned task should be cancelled",
    );

    // Cancel from running
    const runningTask = makeTask({ id: "task-running" });
    taskQueue.enqueue(runningTask);
    taskQueue.assignTask(runningTask.id, "sandbox-2");
    taskQueue.startTask(runningTask.id);
    taskQueue.cancelTask(runningTask.id);
    assert.strictEqual(
      taskQueue.getById(runningTask.id)?.status,
      "cancelled",
      "Running task should be cancelled",
    );
  });

  it("invalid transition throws", () => {
    const taskQueue = new TaskQueue();
    const task = makeTask({ status: "pending" });

    taskQueue.enqueue(task);

    assert.throws(
      () => taskQueue.updateStatus(task.id, "running"),
      /Invalid transition/,
      "Should throw on invalid transition from pending to running",
    );
  });

  it("status callbacks fire on transitions", () => {
    const taskQueue = new TaskQueue();
    const task = makeTask();

    let callbackCalled = false;
    let capturedTask: Task | undefined;
    let capturedOldStatus: TaskStatus | undefined;
    let capturedNewStatus: TaskStatus | undefined;

    const callback: (t: Task, oldStatus: TaskStatus, newStatus: TaskStatus) => void = (
      t,
      oldStatus,
      newStatus,
    ) => {
      callbackCalled = true;
      capturedTask = t;
      capturedOldStatus = oldStatus;
      capturedNewStatus = newStatus;
    };

    taskQueue.onStatusChange(callback);
    taskQueue.enqueue(task);
    taskQueue.assignTask(task.id, "sandbox-1");

    assert.strictEqual(callbackCalled, true, "Callback should have been called");
    assert.strictEqual(capturedTask?.id, task.id, "Callback should receive correct task");
    assert.strictEqual(capturedOldStatus, "pending", "Callback should receive old status");
    assert.strictEqual(capturedNewStatus, "assigned", "Callback should receive new status");
  });

  it("removeStatusCallback stops notifications", () => {
    const taskQueue = new TaskQueue();
    const task = makeTask();

    let callbackCalled = false;

    const callback: (t: Task, oldStatus: TaskStatus, newStatus: TaskStatus) => void = () => {
      callbackCalled = true;
    };

    taskQueue.onStatusChange(callback);
    taskQueue.enqueue(task);

    // Remove the callback before the transition
    taskQueue.removeStatusCallback(callback);
    taskQueue.assignTask(task.id, "sandbox-1");

    assert.strictEqual(callbackCalled, false, "Callback should not be called after removal");
  });

  it("count methods are accurate", () => {
    const taskQueue = new TaskQueue();

    // Enqueue 5 tasks
    for (let i = 0; i < 5; i++) {
      taskQueue.enqueue(makeTask({ id: `task-${i}` }));
    }

    assert.strictEqual(taskQueue.getTotalCount(), 5, "Total should be 5");
    assert.strictEqual(taskQueue.getPendingCount(), 5, "Pending should be 5");

    // Assign 3 tasks
    taskQueue.assignTask("task-0", "sandbox-0");
    taskQueue.assignTask("task-1", "sandbox-1");
    taskQueue.assignTask("task-2", "sandbox-2");

    assert.strictEqual(taskQueue.getPendingCount(), 2, "Pending should be 2");
    assert.strictEqual(taskQueue.getRunningCount(), 0, "Running should be 0");

    // Start and complete 2 tasks
    taskQueue.startTask("task-0");
    taskQueue.completeTask("task-0");
    taskQueue.startTask("task-1");
    taskQueue.completeTask("task-1");

    assert.strictEqual(taskQueue.getCompletedCount(), 2, "Completed should be 2");

    // Start and fail 1 task
    taskQueue.startTask("task-2");
    taskQueue.failTask("task-2");

    assert.strictEqual(taskQueue.getFailedCount(), 1, "Failed should be 1");

    // Verify counts
    assert.strictEqual(taskQueue.getTotalCount(), 5, "Total should still be 5");
    assert.strictEqual(taskQueue.getRunningCount(), 0, "Running should be 0");
  });

  describe("retryTask", () => {
    it("retries a failed task — resets to pending and re-enqueues", () => {
      const taskQueue = new TaskQueue();
      const task = makeTask({ id: "retry-1" });

      taskQueue.enqueue(task);
      taskQueue.assignTask("retry-1", "sandbox-1");
      taskQueue.startTask("retry-1");
      taskQueue.failTask("retry-1");

      const result = taskQueue.retryTask("retry-1");
      assert.strictEqual(result, true, "retryTask should return true for failed task");

      const retried = taskQueue.getById("retry-1");
      assert.strictEqual(retried?.status, "pending", "Status should be pending after retry");
      assert.strictEqual(retried?.retryCount, 1, "retryCount should be 1");
      assert.strictEqual(retried?.assignedTo, undefined, "assignedTo should be cleared");
      assert.strictEqual(retried?.startedAt, undefined, "startedAt should be cleared");
      assert.strictEqual(retried?.completedAt, undefined, "completedAt should be cleared");
    });

    it("returns false for non-failed tasks", () => {
      const taskQueue = new TaskQueue();
      const task = makeTask({ id: "retry-2" });

      taskQueue.enqueue(task);
      assert.strictEqual(
        taskQueue.retryTask("retry-2"),
        false,
        "retryTask should return false for pending task",
      );
    });

    it("returns false for non-existent tasks", () => {
      const taskQueue = new TaskQueue();
      assert.strictEqual(
        taskQueue.retryTask("nonexistent"),
        false,
        "retryTask should return false for missing task",
      );
    });

    it("increments retryCount on successive retries", () => {
      const taskQueue = new TaskQueue();
      const task = makeTask({ id: "retry-3" });

      taskQueue.enqueue(task);
      taskQueue.assignTask("retry-3", "s1");
      taskQueue.startTask("retry-3");
      taskQueue.failTask("retry-3");
      taskQueue.retryTask("retry-3");
      assert.strictEqual(
        taskQueue.getById("retry-3")?.retryCount,
        1,
        "retryCount should be 1 after first retry",
      );

      taskQueue.assignTask("retry-3", "s2");
      taskQueue.startTask("retry-3");
      taskQueue.failTask("retry-3");
      taskQueue.retryTask("retry-3");
      assert.strictEqual(
        taskQueue.getById("retry-3")?.retryCount,
        2,
        "retryCount should be 2 after second retry",
      );
    });

    it("fires status change callback on retry", () => {
      const taskQueue = new TaskQueue();
      const changes: string[] = [];
      taskQueue.onStatusChange((_task, old, next) => changes.push(`${old}->${next}`));

      const task = makeTask({ id: "retry-4" });
      taskQueue.enqueue(task);
      taskQueue.assignTask("retry-4", "s1");
      taskQueue.startTask("retry-4");
      taskQueue.failTask("retry-4");
      changes.length = 0;

      taskQueue.retryTask("retry-4");
      assert.deepStrictEqual(changes, ["failed->pending"], "Should fire failed->pending callback");
    });
  });
});
