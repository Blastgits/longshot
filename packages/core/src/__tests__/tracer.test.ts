import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { closeTracing, createTracer, enableTracing, Tracer, writeLLMDetail } from "../tracer.js";

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function readNdjsonEventually(filePath: string, minLines: number): Promise<unknown[]> {
  const deadline = Date.now() + 500;
  let lastErr: unknown;

  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length >= minLines) {
        return lines.map((l) => JSON.parse(l) as unknown);
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 10));
  }

  if (lastErr instanceof Error) {
    throw lastErr;
  }
  throw new Error(`Timed out waiting for NDJSON lines in ${filePath}`);
}

async function withCapturedStderr(fn: (writes: string[]) => void | Promise<void>): Promise<void> {
  const writes: string[] = [];
  const originalWrite = process.stderr.write;

  function captureWrite(buffer: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
  function captureWrite(
    str: string | Uint8Array,
    encoding?: BufferEncoding,
    cb?: (err?: Error | null) => void,
  ): boolean;
  function captureWrite(
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    let callback: ((err?: Error | null) => void) | undefined;
    let enc: BufferEncoding = "utf8";
    if (typeof encodingOrCb === "function") {
      callback = encodingOrCb;
    } else {
      enc = encodingOrCb ?? "utf8";
      callback = cb;
    }

    if (typeof chunk === "string") {
      writes.push(chunk);
    } else {
      writes.push(Buffer.from(chunk).toString(enc));
    }

    if (callback) callback();
    return true;
  }

  process.stderr.write = captureWrite;
  try {
    await fn(writes);
  } finally {
    process.stderr.write = originalWrite;
  }
}

afterEach(() => {
  closeTracing();
});

describe("tracer", () => {
  it("emits begin and end events with expected trace context", async () => {
    const root = await createTempDir("core-tracer-test-");
    const { traceFile } = enableTracing(root);

    const tracer = createTracer("trace-1");
    const span = tracer.startSpan("op", { taskId: "task-1", agentId: "agent-1" });
    span.end();
    closeTracing();

    const events = await readNdjsonEventually(traceFile, 2);
    assert.strictEqual(events.length, 2);

    const begin = events[0];
    const end = events[1];
    assert.ok(begin && typeof begin === "object");
    assert.ok(end && typeof end === "object");

    const beginObj = begin as Record<string, unknown>;
    const endObj = end as Record<string, unknown>;
    assert.strictEqual(beginObj.spanKind, "begin");
    assert.strictEqual(beginObj.spanName, "op");
    assert.strictEqual(beginObj.taskId, "task-1");
    assert.strictEqual(beginObj.agentId, "agent-1");

    const beginTrace = beginObj.trace;
    assert.ok(beginTrace && typeof beginTrace === "object");
    assert.strictEqual((beginTrace as Record<string, unknown>).traceId, "trace-1");
    assert.strictEqual((beginTrace as Record<string, unknown>).spanId, span.spanId);

    assert.strictEqual(endObj.spanKind, "end");
    assert.strictEqual(endObj.spanName, "op");
    assert.strictEqual(endObj.spanStatus, "ok");
    assert.strictEqual(typeof endObj.durationMs, "number");
    assert.ok((endObj.durationMs as number) >= 0);

    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("creates child spans with parentSpanId and merges attributes for events", async () => {
    const root = await createTempDir("core-tracer-test-");
    const { traceFile } = enableTracing(root);

    const tracer = createTracer("trace-2");
    const parent = tracer.startSpan("parent");
    parent.setAttribute("k", "v");

    const child = parent.child("child");
    child.end();

    parent.event("tick", { n: 1 });
    parent.end();
    closeTracing();

    const events = await readNdjsonEventually(traceFile, 5);

    const childBegin = events.find((e) => {
      if (!e || typeof e !== "object") return false;
      const obj = e as Record<string, unknown>;
      const trace = obj.trace;
      if (!trace || typeof trace !== "object") return false;
      return (
        obj.spanKind === "begin" &&
        obj.spanName === "child" &&
        (trace as Record<string, unknown>).spanId === child.spanId
      );
    });

    assert.ok(childBegin && typeof childBegin === "object");
    const trace = (childBegin as Record<string, unknown>).trace;
    assert.ok(trace && typeof trace === "object");
    assert.strictEqual((trace as Record<string, unknown>).parentSpanId, parent.spanId);

    const tickEvent = events.find((e) => {
      if (!e || typeof e !== "object") return false;
      const obj = e as Record<string, unknown>;
      return obj.spanKind === "event" && obj.spanName === "tick";
    });
    assert.ok(tickEvent && typeof tickEvent === "object");
    const attrs = (tickEvent as Record<string, unknown>).attributes;
    assert.ok(attrs && typeof attrs === "object");
    const attrsObj = attrs as Record<string, unknown>;
    assert.strictEqual(attrsObj.k, "v");
    assert.strictEqual(attrsObj.n, 1);

    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("propagates traceId via propagationContext/fromPropagated", async () => {
    const root = await createTempDir("core-tracer-test-");
    const { traceFile } = enableTracing(root);

    const tracerA = createTracer("trace-prop");
    const spanA = tracerA.startSpan("root");
    const ctx = tracerA.propagationContext(spanA);
    assert.deepStrictEqual(ctx, { traceId: "trace-prop", parentSpanId: spanA.spanId });

    const tracerB = Tracer.fromPropagated(ctx);
    assert.strictEqual(tracerB.getTraceId(), "trace-prop");
    const spanB = tracerB.startSpan("child");
    spanB.end();
    spanA.end();
    closeTracing();

    const events = await readNdjsonEventually(traceFile, 4);
    const childBegin = events.find((e) => {
      if (!e || typeof e !== "object") return false;
      const obj = e as Record<string, unknown>;
      const trace = obj.trace;
      if (!trace || typeof trace !== "object") return false;
      return (
        obj.spanKind === "begin" &&
        obj.spanName === "child" &&
        (trace as Record<string, unknown>).spanId === spanB.spanId
      );
    });

    assert.ok(childBegin && typeof childBegin === "object");
    const childTrace = (childBegin as Record<string, unknown>).trace as Record<string, unknown>;
    assert.strictEqual(childTrace.traceId, "trace-prop");
    assert.strictEqual(childTrace.parentSpanId, spanA.spanId);

    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("applies propagated parent to first span only when no explicit parent is passed", async () => {
    const root = await createTempDir("core-tracer-test-");
    const { traceFile } = enableTracing(root);

    const tracer = Tracer.fromPropagated({ traceId: "trace-once", parentSpanId: "upstream-123" });
    const first = tracer.startSpan("first");
    const second = tracer.startSpan("second");
    first.end();
    second.end();
    closeTracing();

    const events = await readNdjsonEventually(traceFile, 4);

    const firstBegin = events.find((e) => {
      if (!e || typeof e !== "object") return false;
      const obj = e as Record<string, unknown>;
      const trace = obj.trace;
      if (!trace || typeof trace !== "object") return false;
      return (
        obj.spanKind === "begin" &&
        obj.spanName === "first" &&
        (trace as Record<string, unknown>).spanId === first.spanId
      );
    });

    const secondBegin = events.find((e) => {
      if (!e || typeof e !== "object") return false;
      const obj = e as Record<string, unknown>;
      const trace = obj.trace;
      if (!trace || typeof trace !== "object") return false;
      return (
        obj.spanKind === "begin" &&
        obj.spanName === "second" &&
        (trace as Record<string, unknown>).spanId === second.spanId
      );
    });

    assert.ok(firstBegin && typeof firstBegin === "object");
    assert.ok(secondBegin && typeof secondBegin === "object");

    const firstTrace = (firstBegin as Record<string, unknown>).trace as Record<string, unknown>;
    const secondTrace = (secondBegin as Record<string, unknown>).trace as Record<string, unknown>;
    assert.strictEqual(firstTrace.parentSpanId, "upstream-123");
    assert.strictEqual(secondTrace.parentSpanId, undefined);

    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("writes LLM detail entries and warns on double end", async () => {
    const root = await createTempDir("core-tracer-test-");
    const { traceFile, llmDetailFile } = enableTracing(root);
    const tracer = createTracer("trace-llm");

    await withCapturedStderr(async (writes) => {
      const span = tracer.startSpan("llm");
      writeLLMDetail(span.spanId, {
        messages: [{ role: "user", content: "hi" }],
        response: { ok: true },
      });
      span.end();
      span.end();
      closeTracing();

      assert.ok(writes.join("").includes("already ended"));

      const traceEvents = await readNdjsonEventually(traceFile, 2);
      const spanEnds = traceEvents.filter((e) => {
        if (!e || typeof e !== "object") return false;
        const obj = e as Record<string, unknown>;
        const trace = obj.trace;
        if (!trace || typeof trace !== "object") return false;
        return obj.spanKind === "end" && (trace as Record<string, unknown>).spanId === span.spanId;
      });
      assert.strictEqual(spanEnds.length, 1);

      const llmEntries = await readNdjsonEventually(llmDetailFile, 1);
      assert.strictEqual(llmEntries.length, 1);
      const entry = llmEntries[0];
      assert.ok(entry && typeof entry === "object");
      const entryObj = entry as Record<string, unknown>;
      assert.strictEqual(entryObj.spanId, span.spanId);
      assert.ok(Array.isArray(entryObj.messages));
    });

    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });
});
