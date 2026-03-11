import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { LLMClient } from "../llm-client.js";

const originalFetch = globalThis.fetch;
const originalRandom = Math.random;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
});

describe("LLMClient", () => {
  it("complete (happy path) returns parsed content + usage and sends auth header", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      const body = JSON.stringify({
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const client = new LLMClient({
      endpoint: "https://llm.example.com",
      apiKey: "secret",
      model: "test-model",
      maxTokens: 123,
      temperature: 0.1,
      timeoutMs: 1000,
    });

    const result = await client.complete([{ role: "user", content: "hi" }]);

    assert.strictEqual(result.content, "hello");
    assert.deepStrictEqual(result.usage, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    assert.strictEqual(result.finishReason, "stop");
    assert.strictEqual(result.endpoint, "default");
    assert.ok(result.latencyMs >= 0);

    assert.strictEqual(calls.length, 1);
    const first = calls.at(0);
    assert.ok(first);
    assert.ok(first.url.endsWith("/v1/chat/completions"));

    const headers = new Headers(first.init?.headers);
    assert.strictEqual(headers.get("Authorization"), "Bearer secret");

    const sentBodyRaw = first.init?.body;
    assert.ok(typeof sentBodyRaw === "string");
    const sentBody = JSON.parse(sentBodyRaw);
    assert.strictEqual(sentBody.model, "test-model");
    assert.deepStrictEqual(sentBody.messages, [{ role: "user", content: "hi" }]);
  });

  it("complete falls back to next endpoint when first fails", async () => {
    Math.random = () => 0;
    const calls: string[] = [];

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);

      if (url.startsWith("https://a.example.com")) {
        return new Response("oops", { status: 500 });
      }

      const body = JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const client = new LLMClient({
      endpoints: [
        { name: "a", endpoint: "https://a.example.com", weight: 50 },
        { name: "b", endpoint: "https://b.example.com", weight: 50 },
      ],
      model: "test-model",
      maxTokens: 1,
      temperature: 0,
      timeoutMs: 1000,
    });

    const result = await client.complete([{ role: "user", content: "hi" }]);
    assert.strictEqual(result.endpoint, "b");
    assert.strictEqual(result.content, "ok");

    assert.strictEqual(calls.length, 2);
    assert.ok(calls[0]?.startsWith("https://a.example.com"));
    assert.ok(calls[1]?.startsWith("https://b.example.com"));

    const stats = client.getEndpointStats();
    const a = stats.find((s) => s.name === "a");
    assert.ok(a);
    assert.strictEqual(a.totalFailures, 1);
  });

  it("complete throws when response shape is invalid", async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ not: "valid" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = new LLMClient({
      endpoint: "https://llm.example.com",
      model: "test-model",
      maxTokens: 1,
      temperature: 0,
      timeoutMs: 1000,
    });

    await assert.rejects(
      () => client.complete([{ role: "user", content: "hi" }]),
      (err: Error) =>
        err.message.includes("All 1 LLM endpoints failed") &&
        err.message.includes("Invalid LLM response shape"),
    );
  });

  it("rejects non-positive endpoint weights at construction time", () => {
    assert.throws(
      () =>
        new LLMClient({
          endpoints: [{ name: "bad", endpoint: "https://bad.example.com", weight: 0 }],
          model: "test-model",
          maxTokens: 1,
          temperature: 0,
          timeoutMs: 1000,
        }),
      (err: Error) => err.message.includes('LLM endpoint "bad" must have a positive weight'),
    );
  });
});
