/** @module Environment-driven configuration loader with typed defaults and validation */

import { createLogger, type HarnessConfig, type LLMEndpoint } from "@longshot/core";

export interface FinalizationConfig {
  maxAttempts: number;
  enabled: boolean;
  sweepTimeoutMs: number;
}

export interface OrchestratorConfig extends HarnessConfig {
  targetRepoPath: string;
  pythonPath: string;
  stateDir: string;
  runId: string;
  healthCheckInterval: number;
  /** Max ms to wait for LLM endpoints to become ready at startup. 0 = skip probe. */
  readinessTimeoutMs: number;
  finalization: FinalizationConfig;
}

/** Named type for the LLM configuration block (extracted from HarnessConfig). */
export type LLMConfig = OrchestratorConfig["llm"];

const ALLOWED_MERGE_STRATEGIES = ["fast-forward", "rebase", "merge-commit"] as const;
const logger = createLogger("config", "root-planner");

interface EndpointEnvConfig {
  name: string;
  endpoint: string;
  apiKey?: string;
  weight: number;
}

function isEndpointEnvConfig(value: unknown): value is EndpointEnvConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (
    !("name" in value) ||
    !("endpoint" in value) ||
    !("weight" in value) ||
    typeof value.name !== "string" ||
    typeof value.endpoint !== "string" ||
    typeof value.weight !== "number"
  ) {
    return false;
  }

  if ("apiKey" in value && value.apiKey !== undefined && typeof value.apiKey !== "string") {
    return false;
  }

  return true;
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function parseNumberWithDefault(
  raw: string | undefined,
  fallback: number,
  envName: string,
): number {
  const parsed = Number(raw);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  if (raw !== undefined) {
    logger.warn(`${envName} is invalid; using default`, { value: raw, fallback });
  }

  return fallback;
}

function clampMin(value: number, min: number, envName: string): number {
  if (value >= min) {
    return value;
  }

  logger.warn(`${envName} must be >= ${min}; clamping`, { value, clamped: min });
  return min;
}

function ensurePositiveOrDefault(value: number, fallback: number, envName: string): number {
  if (value > 0) {
    return value;
  }

  logger.warn(`${envName} must be > 0; using default`, { value, fallback });
  return fallback;
}

function parseOptionalPositive(raw: string | undefined, envName: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  logger.warn(`${envName} must be > 0; ignoring value`, { value: raw });
  return undefined;
}

function parseEndpoints(): LLMEndpoint[] {
  const endpoints: LLMEndpoint[] = [];

  // LLM_ENDPOINTS: JSON array format — [{name, endpoint, apiKey?, weight}]
  const endpointsJson = process.env.LLM_ENDPOINTS;
  if (endpointsJson) {
    let parsedRaw: unknown;

    try {
      parsedRaw = JSON.parse(endpointsJson);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON in LLM_ENDPOINTS: ${errorMessage}`);
    }

    if (!Array.isArray(parsedRaw) || parsedRaw.length === 0) {
      throw new Error("LLM_ENDPOINTS must contain at least one endpoint");
    }

    for (const ep of parsedRaw) {
      if (!isEndpointEnvConfig(ep)) {
        throw new Error("Each LLM_ENDPOINTS item must contain name, endpoint, and numeric weight");
      }

      endpoints.push({
        name: ep.name,
        endpoint: normalizeUrl(ep.endpoint),
        apiKey: ep.apiKey,
        weight: ep.weight,
      });
    }
    return endpoints;
  }

  // Fallback: LLM_BASE_URL (single endpoint, backwards compatible)
  const llmBaseUrl = process.env.LLM_BASE_URL;
  if (llmBaseUrl) {
    endpoints.push({
      name: "default",
      endpoint: normalizeUrl(llmBaseUrl),
      apiKey: process.env.LLM_API_KEY || undefined,
      weight: 100,
    });
    return endpoints;
  }

  throw new Error(
    "Missing required env: LLM_ENDPOINTS (JSON array) or LLM_BASE_URL (single endpoint)",
  );
}

let cachedConfig: OrchestratorConfig | null = null;

export function loadConfig(): OrchestratorConfig {
  const endpoints = parseEndpoints();
  if (endpoints.length === 0) {
    throw new Error("LLM_ENDPOINTS must contain at least one endpoint");
  }

  const gitRepoUrl = process.env.GIT_REPO_URL;
  if (!gitRepoUrl) {
    throw new Error("Missing required env: GIT_REPO_URL");
  }

  const mergeStrategy = process.env.MERGE_STRATEGY || "rebase";
  const validatedMergeStrategy = ALLOWED_MERGE_STRATEGIES.find(
    (strategy) => strategy === mergeStrategy,
  );
  if (!validatedMergeStrategy) {
    throw new Error(
      `Invalid mergeStrategy: ${mergeStrategy}. Must be one of: ${ALLOWED_MERGE_STRATEGIES.join(", ")}`,
    );
  }

  const maxWorkers = clampMin(
    parseNumberWithDefault(process.env.MAX_WORKERS, 50, "MAX_WORKERS"),
    1,
    "MAX_WORKERS",
  );
  const workerTimeout = ensurePositiveOrDefault(
    parseNumberWithDefault(process.env.WORKER_TIMEOUT, 1800, "WORKER_TIMEOUT"),
    1800,
    "WORKER_TIMEOUT",
  );
  const llmMaxTokens = clampMin(
    parseNumberWithDefault(process.env.LLM_MAX_TOKENS, 65536, "LLM_MAX_TOKENS"),
    1,
    "LLM_MAX_TOKENS",
  );
  const llmTemperature = parseNumberWithDefault(
    process.env.LLM_TEMPERATURE,
    0.7,
    "LLM_TEMPERATURE",
  );
  const llmTimeoutMs = parseOptionalPositive(process.env.LLM_TIMEOUT_MS, "LLM_TIMEOUT_MS");
  const sandboxCpuCores = ensurePositiveOrDefault(
    parseNumberWithDefault(process.env.SANDBOX_CPU_CORES, 4, "SANDBOX_CPU_CORES"),
    4,
    "SANDBOX_CPU_CORES",
  );
  const sandboxMemoryMb = ensurePositiveOrDefault(
    parseNumberWithDefault(process.env.SANDBOX_MEMORY_MB, 8192, "SANDBOX_MEMORY_MB"),
    8192,
    "SANDBOX_MEMORY_MB",
  );
  const sandboxIdleTimeout = ensurePositiveOrDefault(
    parseNumberWithDefault(process.env.SANDBOX_IDLE_TIMEOUT, 300, "SANDBOX_IDLE_TIMEOUT"),
    300,
    "SANDBOX_IDLE_TIMEOUT",
  );
  const healthCheckInterval = ensurePositiveOrDefault(
    parseNumberWithDefault(process.env.HEALTH_CHECK_INTERVAL, 10, "HEALTH_CHECK_INTERVAL"),
    10,
    "HEALTH_CHECK_INTERVAL",
  );
  const readinessTimeoutMs = ensurePositiveOrDefault(
    process.env.LLM_READINESS_TIMEOUT_MS ? Number(process.env.LLM_READINESS_TIMEOUT_MS) : 120_000,
    120_000,
    "LLM_READINESS_TIMEOUT_MS",
  );
  const finalizationMaxAttempts = clampMin(
    parseNumberWithDefault(process.env.FINALIZATION_MAX_ATTEMPTS, 3, "FINALIZATION_MAX_ATTEMPTS"),
    1,
    "FINALIZATION_MAX_ATTEMPTS",
  );
  const finalizationSweepTimeoutMs = ensurePositiveOrDefault(
    parseNumberWithDefault(
      process.env.FINALIZATION_SWEEP_TIMEOUT_MS,
      120_000,
      "FINALIZATION_SWEEP_TIMEOUT_MS",
    ),
    120_000,
    "FINALIZATION_SWEEP_TIMEOUT_MS",
  );

  cachedConfig = {
    maxWorkers,
    workerTimeout,
    mergeStrategy: validatedMergeStrategy,
    llm: {
      endpoints,
      model: process.env.LLM_MODEL || "glm-5",
      maxTokens: llmMaxTokens,
      temperature: llmTemperature,
      timeoutMs: llmTimeoutMs,
    },
    git: {
      repoUrl: gitRepoUrl,
      mainBranch: process.env.GIT_MAIN_BRANCH || "main",
      branchPrefix: process.env.GIT_BRANCH_PREFIX || "worker/",
    },
    sandbox: {
      imageTag: process.env.SANDBOX_IMAGE_TAG || "latest",
      cpuCores: sandboxCpuCores,
      memoryMb: sandboxMemoryMb,
      idleTimeout: sandboxIdleTimeout,
    },
    targetRepoPath: process.env.TARGET_REPO_PATH || "./target-repo",
    pythonPath: process.env.PYTHON_PATH || "python3",
    stateDir: process.env.TASKSTORE_STATE_DIR || "./taskstore-state",
    runId: process.env.ORCHESTRATOR_RUN_ID || `run-${Date.now()}`,
    healthCheckInterval,
    readinessTimeoutMs,
    finalization: {
      maxAttempts: finalizationMaxAttempts,
      enabled: process.env.FINALIZATION_ENABLED !== "false",
      sweepTimeoutMs: finalizationSweepTimeoutMs,
    },
  };

  return cachedConfig;
}

export function clearConfigCache(): void {
  cachedConfig = null;
}

export function getConfig(): OrchestratorConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
}
