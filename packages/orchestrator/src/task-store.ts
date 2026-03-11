import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger } from "@longshot/core";

const logger = createLogger("task-store", "root-planner");
const SNAPSHOT_VERSION = 1;
const DEFAULT_SNAPSHOT_EVERY_EVENTS = 100;

export type StoredTaskStatus = "active" | "complete" | "failed" | "cancelled";

export interface StoredTaskRecord {
  runId: string;
  taskId: string;
  branch: string;
  status: StoredTaskStatus;
  retryCount: number;
  updatedAt: number;
}

interface TaskStoreEvent {
  type: "upsert";
  record: StoredTaskRecord;
}

interface TaskStoreSnapshot {
  version: typeof SNAPSHOT_VERSION;
  records: StoredTaskRecord[];
}

export interface TaskStore {
  hasTask(taskId: string): boolean;
  isActive(taskId: string): boolean;
  markActive(taskId: string, branch: string, retryCount: number): void;
  markStatus(taskId: string, status: StoredTaskStatus, retryCount?: number): void;
  reapStaleActive(maxAgeMs: number): string[];
  getActiveTaskIds(): string[];
  getActiveCount(): number;
  getTaskCount(): number;
  getAllBranches(): string[];
}

function isStoredTaskStatus(value: unknown): value is StoredTaskStatus {
  return value === "active" || value === "complete" || value === "failed" || value === "cancelled";
}

function isStoredTaskRecord(value: unknown): value is StoredTaskRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (
    !("runId" in value) ||
    !("taskId" in value) ||
    !("branch" in value) ||
    !("status" in value) ||
    !("retryCount" in value) ||
    !("updatedAt" in value)
  ) {
    return false;
  }

  return (
    typeof value.runId === "string" &&
    typeof value.taskId === "string" &&
    typeof value.branch === "string" &&
    isStoredTaskStatus(value.status) &&
    typeof value.retryCount === "number" &&
    typeof value.updatedAt === "number"
  );
}

function isTaskStoreEvent(value: unknown): value is TaskStoreEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("type" in value) || value.type !== "upsert" || !("record" in value)) {
    return false;
  }

  return isStoredTaskRecord(value.record);
}

export class InMemoryTaskStore implements TaskStore {
  private records = new Map<string, StoredTaskRecord>();
  private now: () => number;
  private runId: string;

  constructor(runId: string = "in-memory", now: () => number = () => Date.now()) {
    this.runId = runId;
    this.now = now;
  }

  hasTask(taskId: string): boolean {
    return this.records.has(taskId);
  }

  isActive(taskId: string): boolean {
    const record = this.records.get(taskId);
    return record?.status === "active";
  }

  markActive(taskId: string, branch: string, retryCount: number): void {
    this.records.set(taskId, {
      runId: this.runId,
      taskId,
      branch,
      status: "active",
      retryCount,
      updatedAt: this.now(),
    });
  }

  markStatus(taskId: string, status: StoredTaskStatus, retryCount?: number): void {
    const record = this.records.get(taskId);
    if (!record) {
      throw new Error(`TaskStore record not found for task ${taskId}`);
    }

    this.records.set(taskId, {
      ...record,
      status,
      retryCount: retryCount ?? record.retryCount,
      updatedAt: this.now(),
    });
  }

  reapStaleActive(maxAgeMs: number): string[] {
    const now = this.now();
    const staleIds: string[] = [];

    for (const record of this.records.values()) {
      if (record.status !== "active") {
        continue;
      }

      if (now - record.updatedAt > maxAgeMs) {
        staleIds.push(record.taskId);
      }
    }

    for (const taskId of staleIds) {
      const record = this.records.get(taskId);
      if (!record) {
        continue;
      }

      this.records.set(taskId, {
        ...record,
        status: "failed",
        updatedAt: now,
      });
    }

    return staleIds;
  }

  getActiveTaskIds(): string[] {
    const ids: string[] = [];
    for (const record of this.records.values()) {
      if (record.status === "active") {
        ids.push(record.taskId);
      }
    }
    return ids;
  }

  getActiveCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === "active") {
        count++;
      }
    }
    return count;
  }

  getTaskCount(): number {
    return this.records.size;
  }

  getAllBranches(): string[] {
    const branches = new Set<string>();
    for (const record of this.records.values()) {
      branches.add(record.branch);
    }
    return [...branches];
  }
}

export interface JournalTaskStoreOptions {
  stateDir: string;
  runId: string;
  snapshotFileName?: string;
  journalFileName?: string;
  snapshotEveryEvents?: number;
  now?: () => number;
}

export class JournalTaskStore implements TaskStore {
  private records = new Map<string, StoredTaskRecord>();
  private now: () => number;
  private runId: string;
  private snapshotPath: string;
  private journalPath: string;
  private snapshotEveryEvents: number;
  private eventsSinceSnapshot = 0;

  constructor(options: JournalTaskStoreOptions) {
    this.now = options.now ?? (() => Date.now());
    this.runId = options.runId;
    this.snapshotPath = join(
      options.stateDir,
      options.snapshotFileName ?? "task-store.snapshot.json",
    );
    this.journalPath = join(
      options.stateDir,
      options.journalFileName ?? "task-store.journal.ndjson",
    );
    this.snapshotEveryEvents = options.snapshotEveryEvents ?? DEFAULT_SNAPSHOT_EVERY_EVENTS;

    mkdirSync(options.stateDir, { recursive: true });
    this.loadSnapshot();
    this.replayJournal();
  }

  hasTask(taskId: string): boolean {
    return this.records.has(this.keyFor(taskId, this.runId));
  }

  isActive(taskId: string): boolean {
    const record = this.records.get(this.keyFor(taskId, this.runId));
    return record?.status === "active";
  }

  markActive(taskId: string, branch: string, retryCount: number): void {
    this.upsert({
      runId: this.runId,
      taskId,
      branch,
      status: "active",
      retryCount,
      updatedAt: this.now(),
    });
  }

  markStatus(taskId: string, status: StoredTaskStatus, retryCount?: number): void {
    const key = this.keyFor(taskId, this.runId);
    const existing = this.records.get(key);
    if (!existing) {
      throw new Error(`TaskStore record not found for task ${taskId} in run ${this.runId}`);
    }

    this.upsert({
      ...existing,
      status,
      retryCount: retryCount ?? existing.retryCount,
      updatedAt: this.now(),
    });
  }

  reapStaleActive(maxAgeMs: number): string[] {
    const now = this.now();
    const stale: StoredTaskRecord[] = [];

    for (const record of this.records.values()) {
      if (record.runId !== this.runId || record.status !== "active") {
        continue;
      }

      if (now - record.updatedAt > maxAgeMs) {
        stale.push(record);
      }
    }

    for (const record of stale) {
      this.upsert({
        ...record,
        status: "failed",
        updatedAt: now,
      });
    }

    return stale.map((r) => r.taskId);
  }

  getActiveTaskIds(): string[] {
    const ids: string[] = [];
    for (const record of this.records.values()) {
      if (record.runId === this.runId && record.status === "active") {
        ids.push(record.taskId);
      }
    }
    return ids;
  }

  getActiveCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.runId === this.runId && record.status === "active") {
        count++;
      }
    }
    return count;
  }

  getTaskCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.runId === this.runId) {
        count++;
      }
    }
    return count;
  }

  getAllBranches(): string[] {
    const branches = new Set<string>();
    for (const record of this.records.values()) {
      if (record.runId === this.runId) {
        branches.add(record.branch);
      }
    }
    return [...branches];
  }

  private keyFor(taskId: string, runId: string): string {
    return `${runId}:${taskId}`;
  }

  private upsert(record: StoredTaskRecord): void {
    this.records.set(this.keyFor(record.taskId, record.runId), record);
    this.appendEvent({ type: "upsert", record });
    this.eventsSinceSnapshot++;

    if (this.eventsSinceSnapshot >= this.snapshotEveryEvents) {
      this.writeSnapshot();
    }
  }

  private appendEvent(event: TaskStoreEvent): void {
    try {
      appendFileSync(this.journalPath, `${JSON.stringify(event)}\n`, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to append task-store journal event: ${message}`);
    }
  }

  private loadSnapshot(): void {
    if (!existsSync(this.snapshotPath)) {
      return;
    }

    try {
      const raw = readFileSync(this.snapshotPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("version" in parsed) ||
        !("records" in parsed) ||
        parsed.version !== SNAPSHOT_VERSION ||
        !Array.isArray(parsed.records)
      ) {
        logger.warn("Ignoring invalid task-store snapshot schema", {
          snapshotPath: this.snapshotPath,
        });
        return;
      }

      const snapshot = parsed as TaskStoreSnapshot;
      for (const record of snapshot.records) {
        if (!isStoredTaskRecord(record)) {
          continue;
        }
        this.records.set(this.keyFor(record.taskId, record.runId), record);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Failed to load task-store snapshot; continuing with empty store", {
        snapshotPath: this.snapshotPath,
        error: message,
      });
    }
  }

  private replayJournal(): void {
    if (!existsSync(this.journalPath)) {
      return;
    }

    try {
      const raw = readFileSync(this.journalPath, "utf-8");
      if (!raw.trim()) {
        return;
      }

      const lines = raw.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (!isTaskStoreEvent(parsed)) {
          continue;
        }

        this.records.set(this.keyFor(parsed.record.taskId, parsed.record.runId), parsed.record);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Failed to replay task-store journal", {
        journalPath: this.journalPath,
        error: message,
      });
    }
  }

  private writeSnapshot(): void {
    const snapshot: TaskStoreSnapshot = {
      version: SNAPSHOT_VERSION,
      records: [...this.records.values()],
    };

    const tmpPath = `${this.snapshotPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(snapshot), "utf-8");
    renameSync(tmpPath, this.snapshotPath);
    writeFileSync(this.journalPath, "", "utf-8");
    this.eventsSinceSnapshot = 0;
  }
}
