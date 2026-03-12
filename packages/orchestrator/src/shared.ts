/** @module Shared utilities — repository state reader, response parser, concurrency limiter, and git mutex */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, getFileTree, getRecentCommits } from "@longshot/core";
import type { AgentSession, BashOperations } from "@mariozechner/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  createBashTool,
  createReadOnlyTools,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { LLMConfig } from "./config.js";

const logger = createLogger("shared", "root-planner");

export interface RepoState {
  fileTree: string[];
  recentCommits: string[];
  featuresJson: string | null;
  specMd: string | null;
  agentsMd: string | null;
  decisionsMd: string | null;
}

export interface RawTaskInput {
  id?: string;
  description: string;
  scope?: string[];
  acceptance?: string;
  branch?: string;
  priority?: number;
}

function isRawTaskInput(value: unknown): value is RawTaskInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "description" in value &&
    typeof value.description === "string"
  );
}

const MAX_FILE_TREE_ENTRIES = 300;
const MAX_FEATURES_JSON_CHARS = 20_000;

export class WeightedRoundRobinSelector<T extends { weight: number }> {
  private readonly states: Array<{ item: T; currentWeight: number }>;
  private readonly totalWeight: number;

  constructor(items: T[]) {
    if (items.length === 0) {
      throw new Error("WeightedRoundRobinSelector requires at least one item");
    }

    for (const item of items) {
      if (!Number.isFinite(item.weight) || item.weight <= 0) {
        throw new Error("WeightedRoundRobinSelector items must have a positive weight");
      }
    }

    this.states = items.map((item) => ({ item, currentWeight: 0 }));
    this.totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  }

  next(): T {
    let selected = this.states[0];
    if (!selected) {
      throw new Error("WeightedRoundRobinSelector has no items");
    }

    for (const state of this.states) {
      state.currentWeight += state.item.weight;
      if (state.currentWeight > selected.currentWeight) {
        selected = state;
      }
    }

    selected.currentWeight -= this.totalWeight;
    return selected.item;
  }
}

export async function readRepoState(targetRepoPath: string): Promise<RepoState> {
  const cwd = targetRepoPath;

  let fileTree = await getFileTree(cwd);
  if (fileTree.length > MAX_FILE_TREE_ENTRIES) {
    const truncated = fileTree.length - MAX_FILE_TREE_ENTRIES;
    fileTree = [...fileTree.slice(0, MAX_FILE_TREE_ENTRIES), `... (${truncated} more files)`];
  }

  const commits = await getRecentCommits(40, cwd);
  const recentCommits = commits.map((c) => `${c.hash.slice(0, 8)} ${c.message} (${c.author})`);

  let featuresJson: string | null = null;
  try {
    const raw = await readFile(join(cwd, "FEATURES.json"), "utf-8");
    featuresJson =
      raw.length > MAX_FEATURES_JSON_CHARS
        ? `${raw.slice(0, MAX_FEATURES_JSON_CHARS)}\n... (truncated)`
        : raw;
  } catch {
    // FEATURES.json may not exist yet
  }

  const readOptionalFile = async (filename: string, maxChars: number): Promise<string | null> => {
    try {
      const raw = await readFile(join(cwd, filename), "utf-8");
      return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n... (truncated)` : raw;
    } catch {
      return null;
    }
  };

  const [specMd, agentsMd, decisionsMd] = await Promise.all([
    readOptionalFile("SPEC.md", 20_000),
    readOptionalFile("AGENTS.md", 10_000),
    readOptionalFile("DECISIONS.md", 10_000),
  ]);

  logger.debug("Repo state loaded", {
    fileTreeSize: fileTree.length,
    commitsCount: recentCommits.length,
    featuresJsonSize: featuresJson?.length ?? 0,
    specMdSize: specMd?.length ?? 0,
    agentsMdSize: agentsMd?.length ?? 0,
    decisionsMdSize: decisionsMd?.length ?? 0,
  });
  return { fileTree, recentCommits, featuresJson, specMd, agentsMd, decisionsMd };
}

/**
 * Counting semaphore for bounding concurrent async operations.
 * Replaces the old serial dispatchLock mutex.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private waitQueue: (() => void)[] = [];

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) throw new Error("maxConcurrent must be >= 1");
  }

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  getActive(): number {
    return this.active;
  }

  getQueueLength(): number {
    return this.waitQueue.length;
  }
}

/**
 * Serializes local git operations to prevent index.lock contention
 * when multiple concurrent tasks touch the same repository.
 */
export class GitMutex extends ConcurrencyLimiter {
  constructor() {
    super(1);
  }

  isLocked(): boolean {
    return this.getActive() > 0;
  }
}

const BRANCH_SLUG_MAX_LENGTH = 50;

/**
 * Convert a task description into a branch-safe slug.
 * e.g. "Implement JWT token generation in src/auth" → "implement-jwt-token-generation-in-src-auth"
 */
export function slugifyForBranch(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumeric → hyphens
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .replace(/-{2,}/g, "-") // collapse consecutive hyphens
    .slice(0, BRANCH_SLUG_MAX_LENGTH)
    .replace(/-+$/, ""); // trim trailing hyphen after truncation
}

const GIT_READONLY_SUBCOMMANDS = new Set([
  "log",
  "diff",
  "show",
  "status",
  "branch",
  "rev-parse",
  "shortlog",
  "blame",
  "tag",
  "ls-files",
  "ls-tree",
  "cat-file",
  "name-rev",
  "describe",
]);

function isReadOnlyGitCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed.startsWith("git ") && trimmed !== "git") return false;
  const parts = trimmed.split(/\s+/);
  const subcommand = parts[1];
  if (!subcommand) return false;
  return GIT_READONLY_SUBCOMMANDS.has(subcommand);
}

/**
 * Bash tool restricted to read-only git commands via allowlist-based validation.
 * Security: non-git and mutating git commands are rejected before reaching the shell.
 */
export function createGitReadOnlyBashTool(cwd: string): ReturnType<typeof createBashTool> {
  type BashExecOptions = {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onData: (data: Buffer) => void;
    timeout?: number;
  };

  const operations: BashOperations = {
    exec: async (command: string, execCwd: string, options: BashExecOptions) => {
      if (!isReadOnlyGitCommand(command)) {
        const msg = `[blocked] Only read-only git commands are allowed. Allowed subcommands: ${[...GIT_READONLY_SUBCOMMANDS].join(", ")}. Got: "${command.slice(0, 120)}"`;
        options.onData(Buffer.from(`${msg}\n`));
        return { exitCode: 1 };
      }

      return new Promise<{ exitCode: number | null }>((resolve) => {
        const proc = spawn("bash", ["-c", command], {
          cwd: execCwd,
          env: options.env,
          signal: options.signal,
        });
        proc.stdout.on("data", (data: Buffer) => options.onData(data));
        proc.stderr.on("data", (data: Buffer) => options.onData(data));
        proc.on("close", (code) => resolve({ exitCode: code }));
        proc.on("error", (err: Error) => {
          options.onData(Buffer.from(`Error: ${err.message}\n`));
          resolve({ exitCode: 1 });
        });
        if (options.timeout) {
          setTimeout(() => {
            proc.kill("SIGKILL");
            resolve({ exitCode: 1 });
          }, options.timeout);
        }
      });
    },
  };

  return createBashTool(cwd, { operations });
}

export interface PlannerResponseResult {
  scratchpad: string;
  tasks: RawTaskInput[];
}

function salvageTruncatedResponse(content: string): PlannerResponseResult {
  let scratchpad = "";
  const tasks: RawTaskInput[] = [];

  const scratchpadMatch = content.match(/"scratchpad"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (scratchpadMatch) {
    try {
      scratchpad = JSON.parse(`"${scratchpadMatch[1]}"`);
    } catch {
      scratchpad = scratchpadMatch[1] ?? "";
    }
  }

  const tasksKeyMatch = content.match(/"tasks"\s*:\s*\[/);
  if (!tasksKeyMatch || tasksKeyMatch.index === undefined) {
    return { scratchpad, tasks };
  }

  const tasksArrayStart = tasksKeyMatch.index + tasksKeyMatch[0].length;
  const remainder = content.slice(tasksArrayStart);

  let depth = 0;
  let objStart = -1;

  for (let i = 0; i < remainder.length; i++) {
    const ch = remainder[i];

    if (ch === '"') {
      i++;
      while (i < remainder.length) {
        if (remainder[i] === "\\") {
          i++;
        } else if (remainder[i] === '"') {
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const objStr = remainder.slice(objStart, i + 1);
        try {
          const parsedTask: unknown = JSON.parse(objStr);
          if (isRawTaskInput(parsedTask) && parsedTask.description) {
            const task = parsedTask;
            tasks.push(task);
          }
        } catch {
          // skip malformed
        }
        objStart = -1;
      }
    }
  }

  return { scratchpad, tasks };
}

export function parsePlannerResponse(content: string): PlannerResponseResult {
  try {
    let cleaned = content.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    const fencedContent = fenceMatch?.[1];
    if (fencedContent) {
      cleaned = fencedContent.trim();
    }

    const objStart = cleaned.indexOf("{");
    const objEnd = cleaned.lastIndexOf("}");
    if (objStart !== -1 && objEnd > objStart) {
      const candidate = cleaned.slice(objStart, objEnd + 1);
      const parsed = JSON.parse(candidate);

      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Array.isArray(parsed.tasks)
      ) {
        return {
          scratchpad: typeof parsed.scratchpad === "string" ? parsed.scratchpad : "",
          tasks: parsed.tasks,
        };
      }
    }
  } catch {
    const salvaged = salvageTruncatedResponse(content);
    if (salvaged.tasks.length > 0) {
      logger.warn("Salvaged tasks from truncated LLM response", {
        tasksRecovered: salvaged.tasks.length,
        contentLength: content.length,
      });
      return salvaged;
    }
  }

  try {
    const tasks = parseLLMTaskArray(content);
    return { scratchpad: "", tasks };
  } catch {
    logger.warn("Failed to parse planner response", { contentPreview: content.slice(0, 300) });
    return { scratchpad: "", tasks: [] };
  }
}

export function parseLLMTaskArray(content: string): RawTaskInput[] {
  let cleaned = content.trim();

  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    const lastBackticks = cleaned.lastIndexOf("```");
    if (firstNewline !== -1 && lastBackticks > firstNewline) {
      cleaned = cleaned.slice(firstNewline + 1, lastBackticks).trim();
    }
  }

  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    cleaned = cleaned.slice(arrayStart, arrayEnd + 1);
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      throw new Error("LLM response is not an array");
    }
    logger.debug("Parsed LLM task array", {
      taskCount: parsed.length,
      contentLength: content.length,
    });
    return parsed;
  } catch (error) {
    logger.error("Failed to parse LLM response as tasks", {
      content: content.slice(0, 500),
    });
    throw new Error(
      `Failed to parse LLM task decomposition: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface PiSessionOptions {
  systemPrompt: string;
  targetRepoPath: string;
  llmConfig: LLMConfig;
  llmEndpoint?: LLMConfig["endpoints"][number];
}

export interface PiSessionResult {
  session: AgentSession;
  tempDir: string;
}

function registerPiModel(llmConfig: LLMConfig, endpointOverride?: LLMConfig["endpoints"][number]) {
  const authStorage = Reflect.construct(AuthStorage, []) as AuthStorage;
  const modelRegistry = new ModelRegistry(authStorage);

  // Pi doesn't support multi-endpoint failover within a single session, so we
  // bind each session to one selected endpoint up front.
  const endpoint = endpointOverride ?? llmConfig.endpoints[0];
  if (!endpoint) {
    throw new Error("No LLM endpoints configured for Pi session");
  }

  modelRegistry.registerProvider("longshot", {
    baseUrl: `${endpoint.endpoint}/v1`,
    apiKey: endpoint.apiKey || "no-key-needed",
    api: "openai-completions",
    models: [
      {
        id: llmConfig.model,
        name: llmConfig.model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: llmConfig.maxTokens,
        compat: {
          maxTokensField: "max_tokens",
          supportsUsageInStreaming: true,
        },
      },
    ],
  });

  const model = modelRegistry.find("longshot", llmConfig.model);
  if (!model) {
    throw new Error(`Model "${llmConfig.model}" not found in registry after registration`);
  }

  return { model, authStorage, modelRegistry };
}

export async function createPlannerPiSession(options: PiSessionOptions): Promise<PiSessionResult> {
  const { systemPrompt, targetRepoPath, llmConfig, llmEndpoint } = options;

  const tempDir = mkdtempSync(join(tmpdir(), "longshot-planner-"));
  const selectedEndpoint = llmEndpoint ?? llmConfig.endpoints[0];
  logger.debug("Creating Pi session", {
    tempDir,
    modelName: llmConfig.model,
    endpoint: selectedEndpoint?.name,
    maxTokens: llmConfig.maxTokens,
    temperature: llmConfig.temperature,
    targetRepoPath,
  });
  writeFileSync(join(tempDir, "AGENTS.md"), systemPrompt, "utf-8");

  const { model, authStorage, modelRegistry } = registerPiModel(llmConfig, selectedEndpoint);

  const { session } = await createAgentSession({
    cwd: tempDir,
    model,
    tools: [...createReadOnlyTools(targetRepoPath), createGitReadOnlyBashTool(targetRepoPath)],
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    thinkingLevel: "off",
  });

  return { session, tempDir };
}

export function cleanupPiSession(session: AgentSession, tempDir: string): void {
  session.dispose();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

export const MAX_HANDOFF_SUMMARY_CHARS = 300;
export const MAX_FILES_PER_HANDOFF = 30;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
