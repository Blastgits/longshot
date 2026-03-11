/** @module Multi-endpoint LLM client with weighted routing, latency-adaptive balancing, and health tracking */

import { createLogger, type LLMEndpoint, type Span, writeLLMDetail } from "@longshot/core";

const logger = createLogger("llm-client", "root-planner");

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: string;
  endpoint: string;
  latencyMs: number;
}

export interface LLMClientConfig {
  endpoints: LLMEndpoint[];
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs?: number;
}

export interface LLMClientSingleConfig {
  endpoint: string;
  model: string;
  maxTokens: number;
  temperature: number;
  apiKey?: string;
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function isChatCompletionResponse(value: unknown): value is ChatCompletionResponse {
  if (typeof value !== "object" || value === null || !("choices" in value)) {
    return false;
  }

  const choices = value.choices;
  if (!Array.isArray(choices)) {
    return false;
  }

  for (const choice of choices) {
    if (
      typeof choice !== "object" ||
      choice === null ||
      !("message" in choice) ||
      typeof choice.message !== "object" ||
      choice.message === null ||
      !("content" in choice.message) ||
      typeof choice.message.content !== "string"
    ) {
      return false;
    }
  }

  return true;
}

interface EndpointState {
  config: LLMEndpoint;
  effectiveWeight: number;
  avgLatencyMs: number;
  totalRequests: number;
  totalFailures: number;
  consecutiveFailures: number;
  lastFailureAt: number;
  healthy: boolean;
}

// EMA smoothing: 0.3 = responsive to recent latency shifts
const LATENCY_ALPHA = 0.3;
const UNHEALTHY_THRESHOLD = 3;
const RECOVERY_PROBE_MS = 30_000;

export class LLMClient {
  private config: LLMClientConfig;
  private states: EndpointState[];
  private requestCounter: number = 0;

  constructor(config: LLMClientConfig | LLMClientSingleConfig) {
    if ("endpoint" in config) {
      this.config = {
        endpoints: [
          {
            name: "default",
            endpoint: config.endpoint,
            apiKey: config.apiKey,
            weight: 100,
          },
        ],
        model: config.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        timeoutMs: config.timeoutMs,
      };
    } else {
      this.config = config;
    }

    if (this.config.endpoints.length === 0) {
      throw new Error("LLMClient requires at least one endpoint");
    }

    const invalidEndpoint = this.config.endpoints.find(
      (endpoint) => !Number.isFinite(endpoint.weight) || endpoint.weight <= 0,
    );
    if (invalidEndpoint) {
      throw new Error(`LLM endpoint "${invalidEndpoint.name}" must have a positive weight`);
    }

    this.states = this.config.endpoints.map((ep) => ({
      config: ep,
      effectiveWeight: ep.weight,
      avgLatencyMs: 0,
      totalRequests: 0,
      totalFailures: 0,
      consecutiveFailures: 0,
      lastFailureAt: 0,
      healthy: true,
    }));

    const names = this.config.endpoints.map((e) => `${e.name}(w=${e.weight})`).join(", ");
    logger.info(`LLMClient initialized with ${this.config.endpoints.length} endpoint(s): ${names}`);
  }

  async complete(
    messages: LLMMessage[],
    overrides?: Partial<Pick<LLMClientConfig, "model" | "temperature" | "maxTokens">>,
    parentSpan?: Span,
  ): Promise<LLMResponse> {
    const orderedEndpoints = this.selectEndpoints();
    let lastError: Error | null = null;

    logger.debug("LLM request starting", {
      endpointOrder: orderedEndpoints.map((e) => e.config.name),
      model: overrides?.model ?? this.config.model,
      messageCount: messages.length,
    });

    const span = parentSpan?.child("llm.complete", { agentId: "llm-client" });
    span?.setAttributes({
      model: overrides?.model ?? this.config.model,
      messageCount: messages.length,
      endpointCount: orderedEndpoints.length,
    });

    for (let attemptIndex = 0; attemptIndex < orderedEndpoints.length; attemptIndex++) {
      const state = orderedEndpoints[attemptIndex];
      if (!state) {
        continue;
      }

      try {
        const result = await this.sendRequest(state, messages, overrides, span);

        span?.setAttributes({
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
          endpoint: result.endpoint,
          latencyMs: result.latencyMs,
          finishReason: result.finishReason,
          retries: attemptIndex,
        });
        span?.setStatus("ok");
        span?.end();

        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.recordFailure(state, lastError);

        if (attemptIndex < orderedEndpoints.length - 1) {
          logger.warn(`Endpoint ${state.config.name} failed, trying next`, {
            error: lastError.message,
            endpoint: state.config.name,
          });
        }
      }
    }

    span?.setStatus("error", lastError?.message);
    span?.end();

    throw new Error(
      `All ${this.config.endpoints.length} LLM endpoints failed. Last error: ${lastError?.message}`,
    );
  }

  private selectEndpoints(): EndpointState[] {
    const now = Date.now();

    for (const state of this.states) {
      if (!state.healthy && now - state.lastFailureAt > RECOVERY_PROBE_MS) {
        state.healthy = true;
        state.consecutiveFailures = 0;
        logger.info(`Endpoint ${state.config.name} marked healthy for recovery probe`);
      }
    }

    const healthy = this.states.filter((s) => s.healthy);
    const unhealthy = this.states.filter((s) => !s.healthy);
    const orderedHealthy = this.weightedSort(healthy);
    const ordered = [...orderedHealthy, ...unhealthy];

    logger.debug("Endpoint selection", {
      healthy: healthy.map((s) => s.config.name),
      unhealthy: unhealthy.map((s) => s.config.name),
      order: ordered.map((s) => ({
        name: s.config.name,
        weight: Math.round(s.effectiveWeight * 10) / 10,
        latency: Math.round(s.avgLatencyMs),
      })),
    });

    return ordered;
  }

  private weightedSort(states: EndpointState[]): EndpointState[] {
    if (states.length <= 1) return [...states];

    if (states.every((s) => s.effectiveWeight <= 0)) return [...states];

    const result: EndpointState[] = [];
    const remaining = [...states];

    while (remaining.length > 0) {
      const remainingWeight = remaining.reduce((sum, s) => sum + Math.max(s.effectiveWeight, 0), 0);
      if (remainingWeight <= 0) {
        result.push(...remaining);
        break;
      }

      let pick = Math.random() * remainingWeight;

      let selectedIdx = remaining.length - 1;
      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        if (!candidate) {
          continue;
        }

        const candidateWeight = Math.max(candidate.effectiveWeight, 0);
        if (candidateWeight === 0) {
          continue;
        }

        pick -= candidateWeight;
        if (pick <= 0) {
          selectedIdx = i;
          break;
        }
      }

      const selected = remaining[selectedIdx];
      if (!selected) {
        break;
      }

      result.push(selected);
      remaining.splice(selectedIdx, 1);
    }

    return result;
  }

  private async sendRequest(
    state: EndpointState,
    messages: LLMMessage[],
    overrides?: Partial<Pick<LLMClientConfig, "model" | "temperature" | "maxTokens">>,
    parentSpan?: Span,
  ): Promise<LLMResponse> {
    const startMs = Date.now();
    state.totalRequests++;
    this.requestCounter++;

    const model = overrides?.model ?? this.config.model;
    const promptCharCount = messages.reduce((sum, m) => sum + m.content.length, 0);

    const requestSpan = parentSpan?.child("llm.request", { agentId: "llm-client" });
    requestSpan?.setAttributes({
      endpoint: state.config.name,
      model,
      promptCharCount,
    });

    const url = `${state.config.endpoint}/v1/chat/completions`;

    logger.debug("Sending LLM request", {
      url,
      endpoint: state.config.name,
      model,
      promptCharCount,
      maxTokens: overrides?.maxTokens ?? this.config.maxTokens,
      temperature: overrides?.temperature ?? this.config.temperature,
    });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(state.config.apiKey ? { Authorization: `Bearer ${state.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: overrides?.temperature ?? this.config.temperature,
          max_tokens: overrides?.maxTokens ?? this.config.maxTokens,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 120_000),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `LLM request failed (${response.status}) from ${state.config.name}: ${body}`,
        );
      }

      const dataRaw: unknown = await response.json();
      if (!isChatCompletionResponse(dataRaw)) {
        throw new Error(`Invalid LLM response shape from ${state.config.name}`);
      }

      const data = dataRaw;
      const firstChoice = data.choices.at(0);
      if (!firstChoice) {
        throw new Error(`LLM response from ${state.config.name} did not contain any choices`);
      }

      const latencyMs = Date.now() - startMs;

      this.recordSuccess(state, latencyMs);

      logger.debug("LLM response received", {
        endpoint: state.config.name,
        latencyMs,
        finishReason: firstChoice.finish_reason,
        contentLength: firstChoice.message.content.length,
        contentPreview: firstChoice.message.content.slice(0, 200),
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      });

      if (requestSpan) {
        requestSpan.setAttributes({
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
          totalTokens: data.usage?.total_tokens ?? 0,
          finishReason: firstChoice.finish_reason ?? "unknown",
          latencyMs,
          endpoint: state.config.name,
        });
        requestSpan.setStatus("ok");
        requestSpan.end();

        writeLLMDetail(requestSpan.spanId, {
          messages,
          response: firstChoice.message.content,
        });
      }

      return {
        content: firstChoice.message.content,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
          totalTokens: data.usage?.total_tokens ?? 0,
        },
        finishReason: firstChoice.finish_reason ?? "unknown",
        endpoint: state.config.name,
        latencyMs,
      };
    } catch (err) {
      if (requestSpan) {
        const errMsg = err instanceof Error ? err.message : String(err);
        requestSpan.setStatus("error", errMsg);
        requestSpan.end();

        writeLLMDetail(requestSpan.spanId, {
          messages,
          error: errMsg,
        });
      }

      throw err;
    }
  }

  private recordSuccess(state: EndpointState, latencyMs: number): void {
    state.consecutiveFailures = 0;
    state.healthy = true;

    if (state.avgLatencyMs === 0) {
      state.avgLatencyMs = latencyMs;
    } else {
      state.avgLatencyMs = LATENCY_ALPHA * latencyMs + (1 - LATENCY_ALPHA) * state.avgLatencyMs;
    }

    this.rebalanceWeights();
  }

  private recordFailure(state: EndpointState, error: Error): void {
    state.totalFailures++;
    state.consecutiveFailures++;
    state.lastFailureAt = Date.now();

    if (state.consecutiveFailures >= UNHEALTHY_THRESHOLD) {
      state.healthy = false;
      logger.warn(
        `Endpoint ${state.config.name} marked unhealthy after ${state.consecutiveFailures} consecutive failures`,
        {
          lastError: error.message,
        },
      );
    }
  }

  /**
   * Latency-adaptive weight rebalancing.
   * Faster endpoints get up to 2x their base weight; endpoints 2x slower get 0.5x.
   */
  private rebalanceWeights(): void {
    const healthyWithLatency = this.states.filter((s) => s.healthy && s.avgLatencyMs > 0);
    if (healthyWithLatency.length < 2) return;

    const minLatency = Math.min(...healthyWithLatency.map((s) => s.avgLatencyMs));

    for (const state of healthyWithLatency) {
      const latencyRatio = state.avgLatencyMs / minLatency;
      const latencyScale = Math.max(0.5, 1.0 / latencyRatio);
      state.effectiveWeight = state.config.weight * latencyScale;
    }

    logger.debug("Endpoint weights rebalanced", {
      weights: healthyWithLatency.map((s) => ({
        name: s.config.name,
        baseWeight: s.config.weight,
        effectiveWeight: Math.round(s.effectiveWeight * 10) / 10,
        avgLatencyMs: Math.round(s.avgLatencyMs),
      })),
    });
  }

  getEndpointStats(): Array<{
    name: string;
    endpoint: string;
    healthy: boolean;
    effectiveWeight: number;
    avgLatencyMs: number;
    totalRequests: number;
    totalFailures: number;
  }> {
    return this.states.map((s) => ({
      name: s.config.name,
      endpoint: s.config.endpoint,
      healthy: s.healthy,
      effectiveWeight: Math.round(s.effectiveWeight * 10) / 10,
      avgLatencyMs: Math.round(s.avgLatencyMs),
      totalRequests: s.totalRequests,
      totalFailures: s.totalFailures,
    }));
  }

  async waitForReady(options?: { maxWaitMs?: number; pollIntervalMs?: number }): Promise<void> {
    const maxWait = options?.maxWaitMs ?? 120_000;
    const pollInterval = options?.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + maxWait;

    while (Date.now() < deadline) {
      for (const state of this.states) {
        try {
          const res = await fetch(`${state.config.endpoint}/v1/models`, {
            headers: state.config.apiKey ? { Authorization: `Bearer ${state.config.apiKey}` } : {},
            signal: AbortSignal.timeout(5_000),
          });
          if (res.ok) {
            logger.info(`Endpoint ${state.config.name} is ready`);
            return;
          }
        } catch {
          // Endpoint not ready yet — expected during cold start.
        }
      }

      const remainingSec = Math.round((deadline - Date.now()) / 1000);
      logger.info("Waiting for LLM endpoint(s) to become ready…", {
        retryIn: `${pollInterval / 1000}s`,
        timeoutIn: `${remainingSec}s`,
      });
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(
      `LLM readiness probe timed out after ${maxWait / 1000}s — no endpoints became available`,
    );
  }

  get totalRequests(): number {
    return this.requestCounter;
  }
}
