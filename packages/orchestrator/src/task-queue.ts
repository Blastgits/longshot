/** @module Priority min-heap task queue with state machine lifecycle tracking */

import type { Task, TaskStatus } from "@longshot/core";

/**
 * Valid state transitions for tasks
 */
export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["assigned", "cancelled"],
  assigned: ["running", "cancelled"],
  running: ["complete", "failed", "cancelled"],
  complete: [],
  failed: ["pending"],
  cancelled: [],
};

/**
 * Callback type for status change events
 */
type TaskCallback = (task: Task, oldStatus: TaskStatus, newStatus: TaskStatus) => void;

/**
 * Min-heap priority queue for tasks.
 * Lower priority number = higher priority (dequeued first).
 * If priorities are equal, earlier createdAt wins (FIFO).
 */
export class PriorityQueue {
  private heap: Task[] = [];

  /**
   * Insert a task into the priority queue
   */
  enqueue(task: Task): void {
    this.heap.push(task);
    this.bubbleUp(this.heap.length - 1);
  }

  /**
   * Remove and return the highest priority task (lowest priority number)
   */
  dequeue(): Task | undefined {
    if (this.isEmpty()) {
      return undefined;
    }

    const min = this.heap[0];
    if (!min) {
      return undefined;
    }

    const last = this.heap.pop();

    if (this.heap.length > 0 && last !== undefined) {
      this.heap[0] = last;
      this.sinkDown(0);
    }

    return min;
  }

  /**
   * View the highest priority task without removing it
   */
  peek(): Task | undefined {
    return this.heap[0];
  }

  /**
   * Get the number of tasks in the queue
   */
  size(): number {
    return this.heap.length;
  }

  /**
   * Check if the queue is empty
   */
  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * Return all tasks sorted by priority (non-destructive)
   */
  toArray(): Task[] {
    // Create a copy and sort for non-destructive access
    return [...this.heap].sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      // FIFO for same priority (earlier createdAt first)
      return a.createdAt - b.createdAt;
    });
  }

  /**
   * Move a task up the heap to maintain heap property
   */
  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const currentTask = this.heap[index];
      const parentTask = this.heap[parentIndex];
      if (!currentTask || !parentTask) {
        break;
      }

      if (this.compareTasks(currentTask, parentTask) >= 0) {
        break;
      }

      // Swap
      [this.heap[index], this.heap[parentIndex]] = [parentTask, currentTask];
      index = parentIndex;
    }
  }

  /**
   * Move a task down the heap to maintain heap property
   */
  private sinkDown(index: number): void {
    const length = this.heap.length;

    while (true) {
      const leftChildIndex = 2 * index + 1;
      const rightChildIndex = 2 * index + 2;
      let smallestIndex = index;

      const smallestTask = this.heap[smallestIndex];
      const leftTask = this.heap[leftChildIndex];
      if (
        leftChildIndex < length &&
        leftTask &&
        smallestTask &&
        this.compareTasks(leftTask, smallestTask) < 0
      ) {
        smallestIndex = leftChildIndex;
      }

      const rightTask = this.heap[rightChildIndex];
      const nextSmallestTask = this.heap[smallestIndex];
      if (
        rightChildIndex < length &&
        rightTask &&
        nextSmallestTask &&
        this.compareTasks(rightTask, nextSmallestTask) < 0
      ) {
        smallestIndex = rightChildIndex;
      }

      if (smallestIndex === index) {
        break;
      }

      // Swap
      const currentTask = this.heap[index];
      const smallestTaskForSwap = this.heap[smallestIndex];
      if (!currentTask || !smallestTaskForSwap) {
        break;
      }

      [this.heap[index], this.heap[smallestIndex]] = [smallestTaskForSwap, currentTask];
      index = smallestIndex;
    }
  }

  /**
   * Compare two tasks for heap ordering.
   * Returns negative if a has higher priority, positive if b has higher priority, 0 if equal.
   */
  private compareTasks(a: Task, b: Task): number {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    // FIFO for same priority (earlier createdAt first)
    return a.createdAt - b.createdAt;
  }
}

/**
 * Task queue with full lifecycle management and state machine.
 * Manages task status transitions and fires callbacks on status changes.
 */
export class TaskQueue {
  private tasks: Map<string, Task> = new Map();
  private pendingQueue: PriorityQueue = new PriorityQueue();
  private statusCallbacks: TaskCallback[] = [];

  /**
   * Add a task to the queue (must have status "pending")
   */
  enqueue(task: Task): void {
    if (task.status !== "pending") {
      throw new Error(
        `Only pending tasks can be enqueued. Task ${task.id} has status "${task.status}"`,
      );
    }

    if (this.tasks.has(task.id)) {
      throw new Error(`Task ${task.id} already exists`);
    }

    this.tasks.set(task.id, task);
    this.pendingQueue.enqueue(task);
  }

  /**
   * Get the next pending task (dequeues from pending queue)
   */
  getNextPending(): Task | undefined {
    const task = this.pendingQueue.dequeue();
    return task;
  }

  /**
   * Update task status with validation and callbacks
   */
  updateStatus(taskId: string, newStatus: TaskStatus): void {
    const task = this.tasks.get(taskId);

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const oldStatus = task.status;

    // Validate transition
    const validTransitions = VALID_TRANSITIONS[oldStatus];
    if (!validTransitions.includes(newStatus)) {
      throw new Error(`Invalid transition: ${oldStatus} → ${newStatus} for task ${taskId}`);
    }

    // Update status
    task.status = newStatus;

    // Fire callbacks
    this.fireStatusCallbacks(task, oldStatus, newStatus);
  }

  /**
   * Get all tasks with a specific status
   */
  getByStatus(status: TaskStatus): Task[] {
    const result: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === status) {
        result.push(task);
      }
    }
    return result;
  }

  /**
   * Get a task by ID
   */
  getById(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks
   */
  getAll(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Assign a task to a sandbox (pending → assigned)
   */
  assignTask(taskId: string, sandboxId: string): void {
    const task = this.tasks.get(taskId);

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.assignedTo = sandboxId;
    this.updateStatus(taskId, "assigned");
  }

  /**
   * Start a task (assigned → running)
   */
  startTask(taskId: string): void {
    const task = this.tasks.get(taskId);

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.startedAt = Date.now();
    this.updateStatus(taskId, "running");
  }

  /**
   * Complete a task (running → complete)
   */
  completeTask(taskId: string): void {
    const task = this.tasks.get(taskId);

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.completedAt = Date.now();
    this.updateStatus(taskId, "complete");
  }

  /**
   * Fail a task (running → failed)
   */
  failTask(taskId: string): void {
    const task = this.tasks.get(taskId);

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.completedAt = Date.now();
    this.updateStatus(taskId, "failed");
  }

  /**
   * Retry a failed task — resets to pending and re-enqueues.
   * Increments retryCount on the task. Returns false if task is not in failed state.
   */
  retryTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status !== "failed") return false;

    task.retryCount = (task.retryCount ?? 0) + 1;
    task.assignedTo = undefined;
    task.startedAt = undefined;
    task.completedAt = undefined;

    this.updateStatus(taskId, "pending");
    this.pendingQueue.enqueue(task);
    return true;
  }

  /**
   * Cancel a task (any → cancelled)
   */
  cancelTask(taskId: string): void {
    const task = this.tasks.get(taskId);

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.completedAt = Date.now();
    this.updateStatus(taskId, "cancelled");
  }

  /**
   * Get count of pending tasks
   */
  getPendingCount(): number {
    return this.getByStatus("pending").length;
  }

  /**
   * Get count of running tasks
   */
  getRunningCount(): number {
    return this.getByStatus("running").length;
  }

  /**
   * Get count of completed tasks
   */
  getCompletedCount(): number {
    return this.getByStatus("complete").length;
  }

  /**
   * Get count of failed tasks
   */
  getFailedCount(): number {
    return this.getByStatus("failed").length;
  }

  /**
   * Get total count of all tasks
   */
  getTotalCount(): number {
    return this.tasks.size;
  }

  /**
   * Register a callback for status changes
   */
  onStatusChange(callback: TaskCallback): void {
    this.statusCallbacks.push(callback);
  }

  /**
   * Remove a status change callback
   */
  removeStatusCallback(callback: TaskCallback): void {
    const index = this.statusCallbacks.indexOf(callback);
    if (index !== -1) {
      this.statusCallbacks.splice(index, 1);
    }
  }

  /**
   * Fire all registered status change callbacks
   */
  private fireStatusCallbacks(task: Task, oldStatus: TaskStatus, newStatus: TaskStatus): void {
    for (const callback of this.statusCallbacks) {
      callback(task, oldStatus, newStatus);
    }
  }
}
