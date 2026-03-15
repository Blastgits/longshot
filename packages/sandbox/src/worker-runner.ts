/** @module Modal sandbox worker harness — orchestrates pi-coding-agent execution within cloud sandboxes */

import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Handoff, Task } from "@longshot/core";
import { closeTracing, enableTracing, type Span, Tracer } from "@longshot/core";
import {
  AuthStorage,
  codingTools,
  createAgentSession,
  findTool,
  grepTool,
  lsTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

const TASK_PATH = "/workspace/task.json";
const RESULT_PATH = "/workspace/result.json";
const WORK_DIR = "/workspace/repo";

export const ARTIFACT_PATTERNS = [
  /^node_modules\//,
  /^\.next\//,
  /^dist\//,
  /^build\//,
  /^out\//,
  /^\.turbo\//,
  /^\.tsbuildinfo$/,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^\.pnpm-store\//,
];

const GITIGNORE_ESSENTIALS = [
  "node_modules/",
  ".next/",
  "dist/",
  "build/",
  "out/",
  ".turbo/",
  "*.tsbuildinfo",
  ".pnpm-store/",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
].join("\n");

export function isArtifact(filePath: string): boolean {
  return ARTIFACT_PATTERNS.some((p) => p.test(filePath));
}

/**
 * Parent directory of the repo. Pi walks up from cwd to discover AGENTS.md,
 * so writing our worker instructions here keeps them separate from any
 * AGENTS.md that already exists in the target repo (both get loaded).
 */
const WORKER_AGENTS_MD_PATH = "/workspace/AGENTS.md";

/**
 * All 7 built-in Pi tools — gives workers full filesystem and search
 * capabilities instead of the limited 4-tool codingTools set.
 *
 * codingTools = [read, bash, edit, write]
 * + grep (ripgrep-powered content search)
 * + find  (glob-based file search)
 * + ls    (directory listing)
 */
const fullPiTools = [...codingTools, grepTool, findTool, lsTool];

interface TaskPayload {
  task: Task;
  systemPrompt: string;
  llmConfig: {
    endpoint: string;
    model: string;
    maxTokens: number;
    temperature: number;
    apiKey?: string;
  };
  repoUrl?: string;
  /** Trace propagation context from the orchestrator. */
  trace?: {
    traceId: string;
    parentSpanId: string;
  };
}

function log(msg: string): void {
  process.stderr.write(`[worker] ${msg}\n`);
}

function hasStatusCode(error: unknown): error is { status: number } {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return false;
  }

  const status = Reflect.get(error, "status");
  return typeof status === "number";
}

function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 30_000 }).trim();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`safeExec failed: ${cmd} (${errorMessage})`);
    return "";
  }
}

function writeResult(handoff: Handoff): void {
  writeFileSync(RESULT_PATH, JSON.stringify(handoff, null, 2), "utf-8");
  log(`Result written to ${RESULT_PATH}`);
}

export function buildTaskPrompt(task: Task): string {
  const parts: string[] = [
    `## Task: ${task.id}`,
    `**Description:** ${task.description}`,
    `**Scope (files to focus on):** ${task.scope.join(", ")}`,
    `**Acceptance criteria:** ${task.acceptance}`,
    `**Branch:** ${task.branch}`,
    "",
    "Complete this task. Commit your changes when done. Stay focused on the scoped files.",
  ];

  return parts.join("\n");
}

/**
 * Pure helper: determines whether an LLM session produced no useful work.
 * Exported for unit testing.
 */
export function detectEmptyResponse(tokensUsed: number, toolCallCount: number): boolean {
  return tokensUsed === 0 && toolCallCount === 0;
}

/**
 * Pure helper: aggregates git numstat output, filtering artifact paths.
 * Exported for unit testing.
 */
export function aggregateNumstat(numstat: string): {
  linesAdded: number;
  linesRemoved: number;
  filesChanged: string[];
} {
  const filesChanged: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  if (numstat) {
    for (const line of numstat.split("\n")) {
      const parts = line.split("\t");
      const [addedRaw, removedRaw, filePath] = parts;
      if (addedRaw && removedRaw && filePath) {
        if (isArtifact(filePath)) continue;
        const added = parseInt(addedRaw, 10);
        const removed = parseInt(removedRaw, 10);
        if (!Number.isNaN(added)) linesAdded += added;
        if (!Number.isNaN(removed)) linesRemoved += removed;
        filesChanged.push(filePath);
      }
    }
  }
  return { linesAdded, linesRemoved, filesChanged };
}

/**
 * Pure helper: builds the failed handoff for an empty-response run.
 * Exported for unit testing.
 */
export function buildEmptyResponseHandoff(taskId: string, durationMs: number): Handoff {
  return {
    taskId,
    status: "failed",
    summary:
      "Task failed: LLM returned empty response (0 tokens, 0 tool calls). Possible API/endpoint failure.",
    diff: "",
    filesChanged: [],
    concerns: ["Empty LLM response — possible API failure or model endpoint issue"],
    suggestions: [
      "Check LLM endpoint connectivity",
      "Verify model is available in sandbox environment",
    ],
    metrics: {
      linesAdded: 0,
      linesRemoved: 0,
      filesCreated: 0,
      filesModified: 0,
      tokensUsed: 0,
      toolCallCount: 0,
      durationMs,
    },
  };
}

export async function runWorker(): Promise<void> {
  const startTime = Date.now();

  log("Reading task payload...");
  const raw = readFileSync(TASK_PATH, "utf-8");
  const payload: TaskPayload = JSON.parse(raw);
  const { task, systemPrompt, llmConfig } = payload;
  log(`Task: ${task.id} — ${task.description.slice(0, 80)}`);

  enableTracing("/workspace");
  let workerSpan: Span | undefined;
  if (payload.trace) {
    const tracer = Tracer.fromPropagated(payload.trace);
    workerSpan = tracer.startSpan("sandbox.worker", {
      taskId: task.id,
      agentId: `sandbox-${task.id}`,
    });
    log(`Tracing enabled — traceId=${payload.trace.traceId}`);
  }

  // Write worker instructions as AGENTS.md in /workspace/ (parent of repo cwd).
  // Pi auto-discovers AGENTS.md by walking up from cwd, so both this file and
  // any AGENTS.md in the target repo itself get loaded and concatenated.
  if (systemPrompt) {
    writeFileSync(WORKER_AGENTS_MD_PATH, systemPrompt, "utf-8");
    log("Worker instructions written to /workspace/AGENTS.md");
  }

  const authStorage = Reflect.construct(AuthStorage, []) as AuthStorage;
  const modelRegistry = new ModelRegistry(authStorage);
  modelRegistry.registerProvider("glm5", {
    baseUrl: llmConfig.endpoint,
    apiKey: llmConfig.apiKey || "no-key-needed",
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

  const model = modelRegistry.find("glm5", llmConfig.model);
  if (!model) {
    throw new Error(`Model "${llmConfig.model}" not found in registry after registration`);
  }
  log(`Model registered: ${llmConfig.model} via ${llmConfig.endpoint}`);

  const startSha = safeExec("git rev-parse HEAD", WORK_DIR);
  workerSpan?.event("sandbox.agentSessionCreate");
  log("Creating agent session (full Pi capabilities)...");
  const { session } = await createAgentSession({
    cwd: WORK_DIR,
    model,
    tools: fullPiTools,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    thinkingLevel: "off",
  });

  let toolCallCount = 0;
  let lastAssistantMessage = "";

  session.subscribe((event: unknown) => {
    if (typeof event !== "object" || event === null || !("type" in event)) {
      return;
    }

    const eventType = event.type;

    if (eventType === "tool_execution_start") {
      toolCallCount++;
      if (toolCallCount % 5 === 0) {
        log(`Tool calls: ${toolCallCount}`);
      }
    }
    if (eventType === "message_end" && "message" in event) {
      const msg = event.message;
      if (msg && typeof msg === "object" && "role" in msg && msg.role === "assistant") {
        const content = "content" in msg ? msg.content : undefined;
        if (Array.isArray(content)) {
          const textParts: string[] = [];
          for (const part of content) {
            if (
              typeof part === "object" &&
              part !== null &&
              "type" in part &&
              part.type === "text" &&
              "text" in part &&
              typeof part.text === "string"
            ) {
              textParts.push(part.text);
            }
          }
          if (textParts.length > 0) {
            lastAssistantMessage = textParts.join("\n");
          }
        }
      }
    }
  });

  const prompt = buildTaskPrompt(task);
  workerSpan?.event("sandbox.agentPromptStart");
  log("Running agent prompt...");
  await session.prompt(prompt);
  workerSpan?.event("sandbox.agentPromptEnd");
  log("Agent prompt completed.");

  const stats = session.getSessionStats();
  const tokensUsed = stats.tokens.total;

  session.dispose();

  // ── Bug fix: Detect empty LLM responses ────────────────────────────────
  // If the LLM returned zero tokens and the agent made zero tool calls,
  // the worker produced no useful work. Mark as failed so the planner
  // can re-plan instead of treating scaffold-only diffs as "complete".
  const isEmptyResponse = tokensUsed === 0 && toolCallCount === 0;
  if (isEmptyResponse) {
    log("WARNING: LLM returned empty response (0 tokens, 0 tool calls). Marking task as failed.");
  }

  const gitignorePath = `${WORK_DIR}/.gitignore`;
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${GITIGNORE_ESSENTIALS}\n`, "utf-8");
    log("Created .gitignore with artifact exclusions");
  } else {
    const existing = readFileSync(gitignorePath, "utf-8");
    if (!existing.includes("node_modules")) {
      appendFileSync(gitignorePath, `\n${GITIGNORE_ESSENTIALS}\n`, "utf-8");
      log("Appended artifact exclusions to existing .gitignore");
    }
  }

  // ── Bug fix: Only safety-net commit if agent actually did work ─────────
  // Without this guard, scaffold files (.gitignore, AGENTS.md) get committed
  // even when the LLM did nothing, producing a false "successful" diff.
  if (!isEmptyResponse) {
    log("Safety-net: staging any uncommitted changes...");
    safeExec("git add -A", WORK_DIR);
    const stagedFiles = safeExec("git diff --cached --name-only", WORK_DIR);
    if (stagedFiles) {
      safeExec(`git commit -m "feat(${task.id}): auto-commit uncommitted changes"`, WORK_DIR);
      log(`Safety-net commit created (${stagedFiles.split("\n").length} files).`);
    }
  } else {
    log("Skipping safety-net commit — agent produced no work.");
  }

  let buildExitCode: number | null = null;
  if (!isEmptyResponse && existsSync(`${WORK_DIR}/tsconfig.json`)) {
    log("Running post-agent build check (tsc --noEmit)...");
    try {
      execSync("npx tsc --noEmit", { cwd: WORK_DIR, encoding: "utf-8", timeout: 60_000 });
      buildExitCode = 0;
      log("Post-agent build check: PASS");
    } catch (buildErr: unknown) {
      const code = hasStatusCode(buildErr) ? buildErr.status : undefined;
      buildExitCode = code ?? 1;
      log(`Post-agent build check: FAIL (exit code ${buildExitCode})`);
    }
  }

  log("Extracting git diff stats...");
  const diff = safeExec(`git diff ${startSha} --no-color -- . ':!node_modules'`, WORK_DIR);
  const numstat = safeExec(`git diff ${startSha} --numstat`, WORK_DIR);
  const filesCreatedRaw = safeExec(`git diff ${startSha} --diff-filter=A --name-only`, WORK_DIR);
  const filesChangedRaw = safeExec(`git diff ${startSha} --name-only`, WORK_DIR);

  const filesChangedAll = filesChangedRaw ? filesChangedRaw.split("\n").filter(Boolean) : [];
  const filesCreatedAll = filesCreatedRaw ? filesCreatedRaw.split("\n").filter(Boolean) : [];

  const filesChanged = filesChangedAll.filter((f) => !isArtifact(f));
  const filesCreated = filesCreatedAll.filter((f) => !isArtifact(f));

  let linesAdded = 0;
  let linesRemoved = 0;
  if (numstat) {
    for (const line of numstat.split("\n")) {
      const parts = line.split("\t");
      const [addedRaw, removedRaw, filePath] = parts;
      if (addedRaw && removedRaw && filePath) {
        if (isArtifact(filePath)) continue;
        const added = parseInt(addedRaw, 10);
        const removed = parseInt(removedRaw, 10);
        if (!Number.isNaN(added)) linesAdded += added;
        if (!Number.isNaN(removed)) linesRemoved += removed;
      }
    }
  }

  const filesModified = filesChanged.length - filesCreated.length;

  const handoff: Handoff = {
    taskId: task.id,
    status: isEmptyResponse ? "failed" : "complete",
    summary: isEmptyResponse
      ? "Task failed: LLM returned empty response (0 tokens, 0 tool calls). Possible API/endpoint failure."
      : lastAssistantMessage || "Task completed (no final message captured).",
    diff,
    filesChanged,
    concerns: isEmptyResponse
      ? ["Empty LLM response — possible API failure or model endpoint issue"]
      : buildExitCode !== null && buildExitCode !== 0
        ? [`Post-agent build check failed (tsc exit code ${buildExitCode})`]
        : [],
    suggestions: isEmptyResponse
      ? ["Check LLM endpoint connectivity", "Verify model is available in sandbox environment"]
      : [],
    buildExitCode,
    metrics: {
      linesAdded,
      linesRemoved,
      filesCreated: filesCreated.length,
      filesModified: Math.max(0, filesModified),
      tokensUsed,
      toolCallCount,
      durationMs: Date.now() - startTime,
    },
  };

  workerSpan?.setAttributes({
    toolCallCount,
    tokensUsed,
    filesChanged: filesChanged.length,
    linesAdded,
    linesRemoved,
    durationMs: handoff.metrics.durationMs,
  });
  workerSpan?.setStatus("ok");
  workerSpan?.end();
  closeTracing();

  writeResult(handoff);
  log(
    `Done. Duration: ${handoff.metrics.durationMs}ms, Tools: ${toolCallCount}, Tokens: ${tokensUsed}`,
  );
}

function readTaskIdSafe(): string {
  try {
    const raw = readFileSync(TASK_PATH, "utf-8");
    const payloadRaw: unknown = JSON.parse(raw);
    if (
      typeof payloadRaw === "object" &&
      payloadRaw !== null &&
      "task" in payloadRaw &&
      typeof payloadRaw.task === "object" &&
      payloadRaw.task !== null &&
      "id" in payloadRaw.task &&
      typeof payloadRaw.task.id === "string"
    ) {
      return payloadRaw.task.id;
    }

    return "unknown";
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Failed to read task id from task payload: ${errorMessage}`);
    return "unknown";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWorker().catch((err: unknown) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    log(`FATAL: ${errorMessage}`);
    if (errorStack) {
      log(errorStack);
    }
    closeTracing();

    const taskId = readTaskIdSafe();
    const failureHandoff: Handoff = {
      taskId,
      status: "failed",
      summary: `Worker crashed: ${errorMessage}`,
      diff: "",
      filesChanged: [],
      concerns: [errorMessage],
      suggestions: ["Check worker logs for stack trace"],
      metrics: {
        linesAdded: 0,
        linesRemoved: 0,
        filesCreated: 0,
        filesModified: 0,
        tokensUsed: 0,
        toolCallCount: 0,
        durationMs: 0,
      },
    };

    writeResult(failureHandoff);
    process.exit(1);
  });
}
