/** @module Distributed tracing with span-based instrumentation and LLM request/response capture */

import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface SpanEvent {
  timestamp: number;
  trace: TraceContext;
  spanName: string;
  spanKind: "begin" | "end" | "event";
  spanStatus?: "ok" | "error";
  durationMs?: number;
  attributes?: Record<string, string | number | boolean>;
  taskId?: string;
  agentId?: string;
}

export interface LLMDetailEntry {
  timestamp: number;
  spanId: string;
  messages: unknown[];
  response?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// TraceWriter — singleton that writes SpanEvents as NDJSON
// ---------------------------------------------------------------------------

class TraceWriter {
  private stream: WriteStream | null = null;
  private filePath: string | null = null;
  private llmStream: WriteStream | null = null;
  private llmFilePath: string | null = null;

  /**
   * Enable trace file output. Creates `<projectRoot>/logs/trace-<ISO>.ndjson`
   * and `<projectRoot>/logs/llm-detail-<ISO>.ndjson`.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  enable(projectRoot: string): { traceFile: string; llmDetailFile: string } {
    if (this.stream) {
      if (!this.filePath || !this.llmFilePath) {
        throw new Error("Tracer stream initialized without file paths");
      }

      return { traceFile: this.filePath, llmDetailFile: this.llmFilePath };
    }

    const logsDir = resolve(projectRoot, "logs");
    mkdirSync(logsDir, { recursive: true });

    const ts = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\.\d+Z$/, "");

    this.filePath = resolve(logsDir, `trace-${ts}.ndjson`);
    this.stream = createWriteStream(this.filePath, { flags: "a" });

    this.llmFilePath = resolve(logsDir, `llm-detail-${ts}.ndjson`);
    this.llmStream = createWriteStream(this.llmFilePath, { flags: "a" });

    return { traceFile: this.filePath, llmDetailFile: this.llmFilePath };
  }

  write(event: SpanEvent): void {
    if (this.stream) {
      this.stream.write(`${JSON.stringify(event)}\n`);
    }
  }

  writeLLMDetail(
    spanId: string,
    data: { messages: unknown[]; response?: unknown; error?: string },
  ): void {
    const entry: LLMDetailEntry = {
      timestamp: Date.now(),
      spanId,
      messages: data.messages,
      response: data.response,
      error: data.error,
    };
    const line = JSON.stringify(entry);
    if (this.llmStream) {
      this.llmStream.write(`${line}\n`);
    }
  }

  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    if (this.llmStream) {
      this.llmStream.end();
      this.llmStream = null;
    }
  }
}

const traceWriter = new TraceWriter();

// ---------------------------------------------------------------------------
// Span
// ---------------------------------------------------------------------------

export class Span {
  public readonly spanId: string;
  private readonly startTime: number;
  private ended = false;
  private status: "ok" | "error" | undefined;
  private attrs: Record<string, string | number | boolean> = {};

  constructor(
    private readonly name: string,
    private readonly tracer: Tracer,
    private readonly parentSpanId?: string,
    private taskId?: string,
    private agentId?: string,
  ) {
    this.spanId = randomBytes(8).toString("hex");
    this.startTime = Date.now();

    // Emit "begin" event on construction
    traceWriter.write(this.buildEvent("begin"));
  }

  /** Emit an instant span event. */
  event(name: string, attrs?: Record<string, string | number | boolean>): void {
    traceWriter.write(
      this.buildEvent("event", {
        spanName: name,
        attributes: attrs ? { ...this.attrs, ...attrs } : { ...this.attrs },
      }),
    );
  }

  setStatus(status: "ok" | "error", message?: string): void {
    this.status = status;
    if (message) {
      this.attrs.statusMessage = message;
    }
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.attrs[key] = value;
  }

  setAttributes(attrs: Record<string, string | number | boolean>): void {
    Object.assign(this.attrs, attrs);
  }

  /** Create a child span parented to this span. */
  child(name: string, overrides?: { taskId?: string; agentId?: string }): Span {
    return new Span(
      name,
      this.tracer,
      this.spanId,
      overrides?.taskId ?? this.taskId,
      overrides?.agentId ?? this.agentId,
    );
  }

  /** End the span, emitting a final "end" event with computed duration. Idempotent. */
  end(): void {
    if (this.ended) {
      process.stderr.write(
        `[tracer] WARNING: Span "${this.name}" (${this.spanId}) already ended\n`,
      );
      return;
    }
    this.ended = true;
    const durationMs = Date.now() - this.startTime;
    traceWriter.write(this.buildEvent("end", { durationMs, spanStatus: this.status ?? "ok" }));
  }

  /** Return the trace context for this span. */
  context(): TraceContext {
    return {
      traceId: this.tracer.getTraceId(),
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
    };
  }

  // -- internals --

  private buildEvent(kind: SpanEvent["spanKind"], overrides?: Partial<SpanEvent>): SpanEvent {
    return {
      timestamp: Date.now(),
      trace: this.context(),
      spanName: this.name,
      spanKind: kind,
      spanStatus: this.status,
      attributes: Object.keys(this.attrs).length > 0 ? { ...this.attrs } : undefined,
      taskId: this.taskId,
      agentId: this.agentId,
      ...overrides,
    };
  }
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

export class Tracer {
  private readonly traceId: string;
  private propagatedParentSpanId: string | undefined;

  constructor(traceId?: string, propagatedParentSpanId?: string) {
    this.traceId = traceId ?? randomUUID();
    this.propagatedParentSpanId = propagatedParentSpanId;
  }

  /** Start a new span. */
  startSpan(
    name: string,
    opts?: {
      parent?: Span;
      parentSpanId?: string;
      taskId?: string;
      agentId?: string;
    },
  ): Span {
    const explicitParentSpanId = opts?.parent?.spanId ?? opts?.parentSpanId;
    const inheritedParentSpanId = explicitParentSpanId ?? this.propagatedParentSpanId;

    if (!explicitParentSpanId && this.propagatedParentSpanId) {
      this.propagatedParentSpanId = undefined;
    }

    return new Span(name, this, inheritedParentSpanId, opts?.taskId, opts?.agentId);
  }

  /** Recreate a Tracer from a propagated context (e.g. from a sandbox worker). */
  static fromPropagated(ctx: { traceId: string; parentSpanId: string }): Tracer {
    return new Tracer(ctx.traceId, ctx.parentSpanId);
  }

  /** Serialize context for passing to child processes. */
  propagationContext(span: Span): { traceId: string; parentSpanId: string } {
    return {
      traceId: this.traceId,
      parentSpanId: span.spanId,
    };
  }

  getTraceId(): string {
    return this.traceId;
  }
}

// ---------------------------------------------------------------------------
// Public helper functions
// ---------------------------------------------------------------------------

/** Enable tracing. Call once at startup. Returns paths to trace and LLM detail files. */
export function enableTracing(projectRoot: string): { traceFile: string; llmDetailFile: string } {
  return traceWriter.enable(projectRoot);
}

/** Close trace files. Call on graceful shutdown. */
export function closeTracing(): void {
  traceWriter.close();
}

/** Create a new Tracer instance. */
export function createTracer(traceId?: string): Tracer {
  return new Tracer(traceId);
}

/**
 * Write full LLM request/response detail to the LLM detail log.
 * Correlates with a span via spanId.
 */
export function writeLLMDetail(
  spanId: string,
  data: { messages: unknown[]; response?: unknown; error?: string },
): void {
  traceWriter.writeLLMDetail(spanId, data);
}
