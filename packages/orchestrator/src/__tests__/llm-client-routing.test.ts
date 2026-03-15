/**
 * Tests for LLMClient routing, health tracking, and latency-adaptive weighting.
 * Covers the gaps identified in issue #29:
 *   - Endpoint demotion after repeated failures
 *   - Recovery probe after RECOVERY_PROBE_MS
 *   - Deterministic weighted ordering when Math.random is controlled
 *   - Latency-adaptive effectiveWeight changes
 *
 * Uses node:test + node:assert/strict. No extra dependencies.
 * All network calls are intercepted via globalThis.fetch.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { LLMClient } from "../llm-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalRandom = Math.random;
const originalDateNow = Date.now;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
  Date.now = originalDateNow;
});

/** A fetch stub that always succeeds with the given content string. */
function successFetch(content = "ok"): typeof fetch {
  return async () => {
    const body = JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

/** Build a two-endpoint client (primary w=80, secondary w=20). */
function makeTwoEndpointClient(timeoutMs = 1000): LLMClient {
  return new LLMClient({
    endpoints: [
      { name: "primary", endpoint: "https://primary.example.com", weight: 80 },
      { name: "secondary", endpoint: "https://secondary.example.com", weight: 20 },
    ],
    model: "test-model",
    maxTokens: 10,
    temperature: 0,
    timeoutMs,
  });
}

const MESSAGES = [{ role: "user" as const, content: "ping" }];

// ---------------------------------------------------------------------------
// Health tracking — endpoint demotion after repeated failures
// ---------------------------------------------------------------------------

describe("LLMClient — health tracking: endpoint demotion", () => {
  let client: LLMClient;

  beforeEach(() => {
    client = makeTwoEndpointClient();
  });

  it("endpoint stays healthy after two consecutive failures (below threshold of 3)", async () => {
    // Pin Math.random so primary (weight=80) is always selected first.
    // With random=0.5, pick=40 of 100 → skips primary(80) would not work;
    // actually with [primary=80, secondary=20]: pick=0.5*100=50 → subtract primary(80): 50-80<0
    // so primary IS selected. Let's use 0.5 to consistently hit primary.
    Math.random = () => 0.5;

    let primaryCallCount = 0;
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("primary")) {
        primaryCallCount++;
        return new Response("err", { status: 500 });
      }
      return successFetch()(input);
    };

    // Two failures on primary — falls back to secondary each time
    await client.complete(MESSAGES);
    await client.complete(MESSAGES);

    // Primary was tried (and failed) exactly twice
    assert.strictEqual(primaryCallCount, 2, "primary should have been tried exactly twice");

    const stats = client.getEndpointStats();
    const primary = stats.find((s) => s.name === "primary");
    assert.ok(primary, "primary endpoint must exist in stats");
    assert.strictEqual(primary.totalFailures, 2, "primary should have exactly 2 recorded failures");
    assert.strictEqual(
      primary.healthy,
      true,
      "primary should still be healthy below threshold of 3",
    );
  });

  it("marks endpoint unhealthy after 3 consecutive failures (at threshold)", async () => {
    // Math.random=0.5 → pick=50 of 100 → primary(80) is always selected first
    Math.random = () => 0.5;

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("primary")) return new Response("err", { status: 500 });
      return successFetch()(input);
    };

    // Drive 3 consecutive failures on primary
    for (let i = 0; i < 3; i++) {
      await client.complete(MESSAGES);
    }

    const stats = client.getEndpointStats();
    const primary = stats.find((s) => s.name === "primary");
    assert.ok(primary);
    assert.strictEqual(
      primary.healthy,
      false,
      "primary must be marked unhealthy after 3 consecutive failures",
    );
    assert.ok(
      primary.totalFailures >= 3,
      "totalFailures must reflect at least 3 recorded failures",
    );
  });

  it("resets to healthy after a successful request following two failures", async () => {
    // Math.random=0.5 → primary always selected first
    Math.random = () => 0.5;
    let primaryCallCount = 0;

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("primary")) {
        primaryCallCount++;
        // Fail first two calls, succeed on third
        if (primaryCallCount <= 2) return new Response("err", { status: 500 });
      }
      return successFetch()(input);
    };

    // Two failures — falls back to secondary
    await client.complete(MESSAGES);
    await client.complete(MESSAGES);
    // Third call succeeds on primary
    const result = await client.complete(MESSAGES);

    assert.strictEqual(result.endpoint, "primary", "third call should succeed on primary");

    const primary = client.getEndpointStats().find((s) => s.name === "primary");
    assert.ok(primary);
    assert.strictEqual(
      primary.healthy,
      true,
      "primary should be healthy after a successful request",
    );
  });

  it("demoted endpoint is tried last (after healthy endpoints)", async () => {
    // Math.random=0.5 → primary always selected first during demotion
    Math.random = () => 0.5;
    const callOrder: string[] = [];

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      const name = url.includes("primary") ? "primary" : "secondary";
      callOrder.push(name);
      if (url.includes("primary")) return new Response("err", { status: 500 });
      return successFetch()(input);
    };

    // Demote primary with 3 consecutive failures
    for (let i = 0; i < 3; i++) {
      await client.complete(MESSAGES);
    }

    callOrder.length = 0; // reset tracking

    // After demotion: secondary (healthy) must be tried before primary (unhealthy)
    await client.complete(MESSAGES);

    assert.strictEqual(
      callOrder[0],
      "secondary",
      "healthy secondary must be tried before demoted primary",
    );
  });
});

// ---------------------------------------------------------------------------
// Recovery probe after RECOVERY_PROBE_MS (30 000 ms)
// ---------------------------------------------------------------------------

describe("LLMClient — health tracking: recovery probe", () => {
  it("unhealthy endpoint is re-probed after RECOVERY_PROBE_MS and recovers on success", async () => {
    Math.random = () => 0.5; // pin primary first

    let now = Date.now();
    Date.now = () => now;

    const client = makeTwoEndpointClient();
    let primaryShouldFail = true;

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("primary") && primaryShouldFail) {
        return new Response("err", { status: 500 });
      }
      return successFetch()(input);
    };

    // Demote primary
    for (let i = 0; i < 3; i++) {
      await client.complete(MESSAGES);
    }

    const beforeRecovery = client.getEndpointStats().find((s) => s.name === "primary");
    assert.ok(beforeRecovery);
    assert.strictEqual(beforeRecovery.healthy, false, "primary should be unhealthy before probe");

    // Advance clock past RECOVERY_PROBE_MS (30 000 ms)
    now += 30_001;
    primaryShouldFail = false;

    const result = await client.complete(MESSAGES);

    const afterRecovery = client.getEndpointStats().find((s) => s.name === "primary");
    assert.ok(afterRecovery);
    assert.strictEqual(
      afterRecovery.healthy,
      true,
      "primary should be healthy after successful recovery probe",
    );
    assert.ok(result.content.length > 0, "request should succeed after recovery");
  });

  it("unhealthy endpoint is NOT re-probed before RECOVERY_PROBE_MS elapses", async () => {
    Math.random = () => 0.5; // pin primary first

    let now = Date.now();
    Date.now = () => now;

    const client = makeTwoEndpointClient();

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("primary")) return new Response("err", { status: 500 });
      return successFetch()(input);
    };

    // Demote primary
    for (let i = 0; i < 3; i++) {
      await client.complete(MESSAGES);
    }

    // Advance clock by less than RECOVERY_PROBE_MS (only 29 000 ms of the 30 000 ms window)
    now += 29_000;

    // Primary is still unhealthy — secondary handles the request
    const result = await client.complete(MESSAGES);
    assert.strictEqual(
      result.endpoint,
      "secondary",
      "secondary must handle request before probe window",
    );

    const primary = client.getEndpointStats().find((s) => s.name === "primary");
    assert.ok(primary);
    assert.strictEqual(
      primary.healthy,
      false,
      "primary must still be unhealthy before probe window",
    );
  });
});

// ---------------------------------------------------------------------------
// Weighted ordering — deterministic when Math.random is controlled
// ---------------------------------------------------------------------------

describe("LLMClient — weighted ordering (deterministic)", () => {
  it("higher-weight endpoint is selected first when random=0.5 (pick lands within its range)", async () => {
    // Endpoints: [light=10, heavy=90]. totalWeight=100.
    // random=0.5 → pick=50. Iterate: light(10): 50-10=40>0, skip. heavy(90): 40-90<0 → select heavy.
    Math.random = () => 0.5;
    const callOrder: string[] = [];

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      callOrder.push(url.includes("heavy") ? "heavy" : "light");
      return successFetch()(input);
    };

    const client = new LLMClient({
      endpoints: [
        { name: "light", endpoint: "https://light.example.com", weight: 10 },
        { name: "heavy", endpoint: "https://heavy.example.com", weight: 90 },
      ],
      model: "test-model",
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 1000,
    });

    await client.complete(MESSAGES);
    assert.strictEqual(
      callOrder[0],
      "heavy",
      "heavy (weight=90) must be selected first when random=0.5",
    );
  });

  it("lower-weight endpoint is selected first when random=0 (pick=0 lands on first in array)", async () => {
    // Endpoints: [light=10, heavy=90]. totalWeight=100.
    // random=0 → pick=0. Iterate: light(10): 0-10<0 → select light immediately.
    Math.random = () => 0;
    const callOrder: string[] = [];

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      callOrder.push(url.includes("heavy") ? "heavy" : "light");
      return successFetch()(input);
    };

    const client = new LLMClient({
      endpoints: [
        { name: "light", endpoint: "https://light.example.com", weight: 10 },
        { name: "heavy", endpoint: "https://heavy.example.com", weight: 90 },
      ],
      model: "test-model",
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 1000,
    });

    await client.complete(MESSAGES);
    assert.strictEqual(
      callOrder[0],
      "light",
      "light (weight=10) is selected first when random=0 picks first array element",
    );
  });

  it("equal-weight endpoints: random=0 picks the first in declaration order", async () => {
    // random=0 → pick=0 → immediately selects the first element (alpha)
    Math.random = () => 0;
    const callOrder: string[] = [];

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      callOrder.push(url.includes("alpha") ? "alpha" : "beta");
      return successFetch()(input);
    };

    const client = new LLMClient({
      endpoints: [
        { name: "alpha", endpoint: "https://alpha.example.com", weight: 50 },
        { name: "beta", endpoint: "https://beta.example.com", weight: 50 },
      ],
      model: "test-model",
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 1000,
    });

    await client.complete(MESSAGES);
    assert.strictEqual(
      callOrder[0],
      "alpha",
      "alpha must be tried first when weights are equal and random=0",
    );
  });

  it("effectiveWeight equals base weight before any requests (no latency data)", () => {
    const client = new LLMClient({
      endpoints: [
        { name: "a", endpoint: "https://a.example.com", weight: 60 },
        { name: "b", endpoint: "https://b.example.com", weight: 40 },
      ],
      model: "test-model",
      maxTokens: 10,
      temperature: 0,
    });

    const stats = client.getEndpointStats();
    const a = stats.find((s) => s.name === "a");
    const b = stats.find((s) => s.name === "b");
    assert.ok(a);
    assert.ok(b);
    assert.strictEqual(
      a.effectiveWeight,
      60,
      "effectiveWeight must equal base weight before any requests",
    );
    assert.strictEqual(
      b.effectiveWeight,
      40,
      "effectiveWeight must equal base weight before any requests",
    );
  });
});

// ---------------------------------------------------------------------------
// Latency-adaptive weighting — effectiveWeight changes after requests
// ---------------------------------------------------------------------------

describe("LLMClient — latency-adaptive weighting", () => {
  it("faster endpoint gets a higher effectiveWeight than the slower one", async () => {
    const FAST_LATENCY = 100;
    const SLOW_LATENCY = 500;

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      const delay = url.includes("primary") ? FAST_LATENCY : SLOW_LATENCY;
      await new Promise((r) => setTimeout(r, delay));
      return successFetch()(input);
    };

    const client = new LLMClient({
      endpoints: [
        { name: "primary", endpoint: "https://primary.example.com", weight: 50 },
        { name: "secondary", endpoint: "https://secondary.example.com", weight: 50 },
      ],
      model: "test-model",
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 5000,
    });

    // Seed latency data: one success on each endpoint
    Math.random = () => 0.5; // pick=25 of 100 → primary(50): 25-50<0 → select primary
    await client.complete(MESSAGES);

    Math.random = () => 0; // pick=0 → primary(50): 0-50<0 → select primary again...
    // Actually we need secondary to get latency data too.
    // With [primary=50, secondary=50], random=0 → pick=0 → primary selected.
    // Use random=0.6 → pick=30 of 100 → primary(50): 30-50<0 → still primary.
    // Use random=0.99 → pick=49.5 of 100 → primary(50): 49.5-50<0 → primary.
    // Hmm, with two equal weight 50 endpoints:
    // random=X, pick=X*100. If pick <= 50, primary is selected (pick-50 <= 0).
    // So we need pick > 50, i.e. random > 0.5 to select secondary.
    Math.random = () => 0.51; // pick=51 → primary(50): 51-50=1>0, skip → secondary(50): 1-50<0 → select secondary
    await client.complete(MESSAGES);

    const stats = client.getEndpointStats();
    const primary = stats.find((s) => s.name === "primary");
    const secondary = stats.find((s) => s.name === "secondary");
    assert.ok(primary);
    assert.ok(secondary);

    assert.ok(
      primary.effectiveWeight > secondary.effectiveWeight,
      `faster primary (effectiveWeight=${primary.effectiveWeight}) should outweigh slower secondary (effectiveWeight=${secondary.effectiveWeight})`,
    );
  });

  it("single endpoint keeps effectiveWeight equal to base weight (rebalancing skipped)", async () => {
    globalThis.fetch = successFetch();

    const client = new LLMClient({
      endpoint: "https://only.example.com",
      model: "test-model",
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 1000,
    });

    await client.complete(MESSAGES);

    const stats = client.getEndpointStats();
    const only = stats[0];
    assert.ok(only);
    // rebalanceWeights() requires >= 2 healthy endpoints with latency data — skipped here
    assert.strictEqual(
      only.effectiveWeight,
      100,
      "single endpoint effectiveWeight must remain at base weight",
    );
  });

  it("avgLatencyMs converges toward new latency via EMA (alpha=0.3) after two requests", async () => {
    const ALPHA = 0.3;
    const FIRST_LATENCY = 200;
    const SECOND_LATENCY = 600;

    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount++;
      const delay = requestCount === 1 ? FIRST_LATENCY : SECOND_LATENCY;
      await new Promise((r) => setTimeout(r, delay));
      return successFetch()(String(requestCount));
    };

    const client = new LLMClient({
      endpoint: "https://llm.example.com",
      model: "test-model",
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 5000,
    });

    await client.complete(MESSAGES); // first call: avgLatency = FIRST_LATENCY
    await client.complete(MESSAGES); // second call: EMA update

    const ep = client.getEndpointStats()[0];
    assert.ok(ep);

    // EMA: avgLatency = ALPHA * SECOND + (1 - ALPHA) * FIRST
    const expectedEMA = ALPHA * SECOND_LATENCY + (1 - ALPHA) * FIRST_LATENCY;

    // Allow ±50ms tolerance for timing variance in CI
    assert.ok(
      Math.abs(ep.avgLatencyMs - expectedEMA) < 50,
      `avgLatencyMs (${ep.avgLatencyMs}) should be within 50ms of EMA (${Math.round(expectedEMA)})`,
    );
  });
});
