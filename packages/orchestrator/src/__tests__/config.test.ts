import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { getConfig, loadConfig, resetConfig } from "../config.js";

// Environment helper to set and restore env vars
function withEnv(env: Record<string, string>, fn: () => void): void {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    original[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const [key, val] of Object.entries(original)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  }
}

// Required env vars for valid config
const REQUIRED_ENV = {
  LLM_BASE_URL: "https://pod-abc123-8000.proxy.runpod.net/v1",
  GIT_REPO_URL: "https://github.com/test/repo",
};

describe("config", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("loadConfig with all defaults - verifies all defaults are correct", () => {
    withEnv(REQUIRED_ENV, () => {
      const config = loadConfig();

      // Verify defaults
      assert.strictEqual(config.maxWorkers, 50);
      assert.strictEqual(config.workerTimeout, 1800);
      assert.strictEqual(config.mergeStrategy, "rebase");
      assert.strictEqual(config.llm.model, "glm-5");
      assert.strictEqual(config.llm.maxTokens, 65536);
      assert.strictEqual(config.llm.temperature, 0.7);
      assert.strictEqual(config.git.mainBranch, "main");
      assert.strictEqual(config.git.branchPrefix, "worker/");
      assert.strictEqual(config.sandbox.imageTag, "latest");
      assert.strictEqual(config.sandbox.cpuCores, 4);
      assert.strictEqual(config.sandbox.memoryMb, 8192);
      assert.strictEqual(config.sandbox.idleTimeout, 300);
      assert.strictEqual(config.targetRepoPath, "./target-repo");
      assert.strictEqual(config.pythonPath, "python3");
      assert.strictEqual(config.stateDir, "./taskstore-state");
      assert.match(config.runId, /^run-\d+$/);
      assert.strictEqual(config.healthCheckInterval, 10);
      assert.strictEqual(config.readinessTimeoutMs, 120_000);
    });
  });

  it("loadConfig with custom values - verifies each is read correctly", () => {
    const customEnv = {
      ...REQUIRED_ENV,
      MAX_WORKERS: "8",
      WORKER_TIMEOUT: "3600",
      MERGE_STRATEGY: "rebase",
      LLM_MODEL: "custom-model",
      LLM_MAX_TOKENS: "16384",
      LLM_TEMPERATURE: "0.5",
      GIT_MAIN_BRANCH: "master",
      GIT_BRANCH_PREFIX: "feature/",
      SANDBOX_IMAGE_TAG: "v1.0.0",
      SANDBOX_CPU_CORES: "8",
      SANDBOX_MEMORY_MB: "16384",
      SANDBOX_IDLE_TIMEOUT: "600",
      TARGET_REPO_PATH: "/custom/path",
      PYTHON_PATH: "/usr/bin/python",
      TASKSTORE_STATE_DIR: "/var/lib/longshot/state",
      ORCHESTRATOR_RUN_ID: "run-custom-123",
      HEALTH_CHECK_INTERVAL: "30",
    };

    withEnv(customEnv, () => {
      const config = loadConfig();

      assert.strictEqual(config.maxWorkers, 8);
      assert.strictEqual(config.workerTimeout, 3600);
      assert.strictEqual(config.mergeStrategy, "rebase");
      assert.strictEqual(config.llm.model, "custom-model");
      assert.strictEqual(config.llm.maxTokens, 16384);
      assert.strictEqual(config.llm.temperature, 0.5);
      assert.strictEqual(config.git.mainBranch, "master");
      assert.strictEqual(config.git.branchPrefix, "feature/");
      assert.strictEqual(config.sandbox.imageTag, "v1.0.0");
      assert.strictEqual(config.sandbox.cpuCores, 8);
      assert.strictEqual(config.sandbox.memoryMb, 16384);
      assert.strictEqual(config.sandbox.idleTimeout, 600);
      assert.strictEqual(config.targetRepoPath, "/custom/path");
      assert.strictEqual(config.pythonPath, "/usr/bin/python");
      assert.strictEqual(config.stateDir, "/var/lib/longshot/state");
      assert.strictEqual(config.runId, "run-custom-123");
      assert.strictEqual(config.healthCheckInterval, 30);
    });
  });

  it("throws on missing LLM endpoints", () => {
    withEnv({ GIT_REPO_URL: REQUIRED_ENV.GIT_REPO_URL }, () => {
      delete process.env.LLM_BASE_URL;
      delete process.env.LLM_ENDPOINTS;
      assert.throws(
        () => loadConfig(),
        (err: Error) => err.message.includes("Missing required env: LLM_ENDPOINTS"),
      );
    });
  });

  it("throws on missing GIT_REPO_URL", () => {
    withEnv({ LLM_BASE_URL: REQUIRED_ENV.LLM_BASE_URL }, () => {
      delete process.env.GIT_REPO_URL;
      assert.throws(
        () => loadConfig(),
        (err: Error) => err.message === "Missing required env: GIT_REPO_URL",
      );
    });
  });

  it("parses LLM_BASE_URL as single endpoint with normalization", () => {
    withEnv(
      { ...REQUIRED_ENV, LLM_BASE_URL: "https://pod-abc123-8000.proxy.runpod.net/v1/" },
      () => {
        const config = loadConfig();
        assert.strictEqual(config.llm.endpoints.length, 1);
        const endpoint = config.llm.endpoints[0];
        assert.ok(endpoint);
        assert.strictEqual(endpoint.endpoint, "https://pod-abc123-8000.proxy.runpod.net");
        assert.strictEqual(endpoint.name, "default");
        assert.strictEqual(endpoint.weight, 100);
      },
    );
  });

  it("parses LLM_ENDPOINTS as multi-endpoint JSON", () => {
    const endpoints = JSON.stringify([
      { name: "modal-b200", endpoint: "https://modal.example.com/v1", weight: 65 },
      { name: "runpod-h200", endpoint: "https://runpod.example.com", apiKey: "key123", weight: 35 },
    ]);
    withEnv({ GIT_REPO_URL: REQUIRED_ENV.GIT_REPO_URL, LLM_ENDPOINTS: endpoints }, () => {
      const config = loadConfig();
      assert.strictEqual(config.llm.endpoints.length, 2);
      const firstEndpoint = config.llm.endpoints[0];
      const secondEndpoint = config.llm.endpoints[1];
      assert.ok(firstEndpoint);
      assert.ok(secondEndpoint);
      assert.strictEqual(firstEndpoint.name, "modal-b200");
      assert.strictEqual(firstEndpoint.endpoint, "https://modal.example.com");
      assert.strictEqual(firstEndpoint.weight, 65);
      assert.strictEqual(secondEndpoint.name, "runpod-h200");
      assert.strictEqual(secondEndpoint.apiKey, "key123");
      assert.strictEqual(secondEndpoint.weight, 35);
    });
  });

  it("throws when LLM_ENDPOINTS is an empty array", () => {
    withEnv({ GIT_REPO_URL: REQUIRED_ENV.GIT_REPO_URL, LLM_ENDPOINTS: "[]" }, () => {
      assert.throws(
        () => loadConfig(),
        (err: Error) => err.message.includes("LLM_ENDPOINTS must contain at least one endpoint"),
      );
    });
  });

  it("LLM_ENDPOINTS takes priority over LLM_BASE_URL", () => {
    const endpoints = JSON.stringify([
      { name: "primary", endpoint: "https://primary.example.com", weight: 100 },
    ]);
    withEnv({ ...REQUIRED_ENV, LLM_ENDPOINTS: endpoints }, () => {
      const config = loadConfig();
      assert.strictEqual(config.llm.endpoints.length, 1);
      const endpoint = config.llm.endpoints[0];
      assert.ok(endpoint);
      assert.strictEqual(endpoint.name, "primary");
    });
  });

  it("LLM_API_KEY is attached to single endpoint from LLM_BASE_URL", () => {
    withEnv({ ...REQUIRED_ENV, LLM_API_KEY: "my-secret-key" }, () => {
      const config = loadConfig();
      const endpoint = config.llm.endpoints[0];
      assert.ok(endpoint);
      assert.strictEqual(endpoint.apiKey, "my-secret-key");
    });
  });

  it("throws on invalid merge strategy", () => {
    withEnv({ ...REQUIRED_ENV, MERGE_STRATEGY: "invalid" }, () => {
      assert.throws(
        () => loadConfig(),
        (err: Error) => err.message.includes("Invalid mergeStrategy"),
      );
    });
  });

  it("accepts all valid merge strategies - fast-forward", () => {
    withEnv({ ...REQUIRED_ENV, MERGE_STRATEGY: "fast-forward" }, () => {
      const config = loadConfig();
      assert.strictEqual(config.mergeStrategy, "fast-forward");
    });
  });

  it("accepts all valid merge strategies - rebase", () => {
    withEnv({ ...REQUIRED_ENV, MERGE_STRATEGY: "rebase" }, () => {
      const config = loadConfig();
      assert.strictEqual(config.mergeStrategy, "rebase");
    });
  });

  it("accepts all valid merge strategies - merge-commit", () => {
    withEnv({ ...REQUIRED_ENV, MERGE_STRATEGY: "merge-commit" }, () => {
      const config = loadConfig();
      assert.strictEqual(config.mergeStrategy, "merge-commit");
    });
  });

  it("numeric values are parsed correctly", () => {
    withEnv({ ...REQUIRED_ENV, MAX_WORKERS: "8" }, () => {
      const config = loadConfig();
      assert.strictEqual(typeof config.maxWorkers, "number");
      assert.strictEqual(config.maxWorkers, 8);
    });
  });

  it("clamps MAX_WORKERS to minimum of 1", () => {
    withEnv({ ...REQUIRED_ENV, MAX_WORKERS: "0" }, () => {
      const config = loadConfig();
      assert.strictEqual(config.maxWorkers, 1);
    });
  });

  it("uses default worker timeout when WORKER_TIMEOUT is non-positive", () => {
    withEnv({ ...REQUIRED_ENV, WORKER_TIMEOUT: "0" }, () => {
      const config = loadConfig();
      assert.strictEqual(config.workerTimeout, 1800);
    });
  });

  it("getConfig returns cached value", () => {
    withEnv(REQUIRED_ENV, () => {
      const config1 = getConfig();
      const config2 = getConfig();
      assert.strictEqual(config1, config2);
    });
  });
});
