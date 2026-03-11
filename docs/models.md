# Configuring LLM Providers

Longshot talks to any OpenAI-compatible `/v1/chat/completions` endpoint. Point it at OpenAI, a local Ollama instance, OpenRouter, or anything else that speaks the same API.

## Quick Start

Set three environment variables and you're done:

```bash
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o
```

Copy `.env.example` to `.env` and fill in those values. The defaults already point at OpenAI with `gpt-4o`.

## Provider Examples

### OpenAI

```bash
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o        # or gpt-5.3, o3
```

### Anthropic

Anthropic's API is not OpenAI-compatible natively. Run a proxy like [LiteLLM](https://github.com/BerriAI/litellm) in front of it:

```bash
# Start LiteLLM proxy
litellm --model anthropic/claude-opus-4-20250514 --port 4000

# Then configure Longshot
LLM_BASE_URL=http://localhost:4000/v1
LLM_API_KEY=sk-...           # your Anthropic key, passed through LiteLLM
LLM_MODEL=claude-opus-4-20250514   # or claude-sonnet-4-20250514
```

### Ollama (local)

```bash
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama          # any non-empty string
LLM_MODEL=codestral         # or llama3, qwen2.5-coder, etc.
```

Ollama exposes an OpenAI-compatible endpoint at `/v1` by default.

### OpenRouter

```bash
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-...
LLM_MODEL=openai/gpt-4o     # use OpenRouter's model IDs
```

OpenRouter gives access to dozens of models through a single API key.

## Model Requirements

The model must support **tool/function calling** — Longshot relies on structured tool calls for its agent loop. Models without tool support will not work.

A large context window is strongly preferred. Longshot hardcodes `contextWindow=131072` tokens in the worker runner, so models with smaller windows may truncate long conversations or fail on large codebases.

Model capability directly affects output quality. More capable models write better code, recover from errors more reliably, and follow complex instructions more accurately. Use the most capable model your budget allows.

## All Tunable Parameters

| Variable | Default | Description |
|---|---|---|
| `LLM_BASE_URL` | _(required)_ | Base URL for the chat completions endpoint |
| `LLM_API_KEY` | _(required)_ | API key sent as Bearer token |
| `LLM_MODEL` | `gpt-4o` | Model name passed in each request (`.env.example` default; code falls back to `glm-5` if unset) |
| `LLM_MAX_TOKENS` | `65536` | Max tokens in the completion response |
| `LLM_TEMPERATURE` | `0.7` | Sampling temperature |
| `LLM_TIMEOUT_MS` | _(none)_ | Per-request timeout in milliseconds (unset = no timeout) |
| `LLM_READINESS_TIMEOUT_MS` | `120000` | How long to wait for the endpoint to become ready on startup (ms) |

## Load Balancing Across Providers

For high-throughput use, you can distribute requests across multiple endpoints using `LLM_ENDPOINTS`. Set it to a JSON array of weighted endpoint configs:

```bash
LLM_ENDPOINTS='[
  {"name": "openai-primary", "endpoint": "https://api.openai.com/v1", "apiKey": "sk-...", "weight": 70},
  {"name": "openrouter-backup", "endpoint": "https://openrouter.ai/api/v1", "apiKey": "sk-or-...", "weight": 30}
]'
```

When `LLM_ENDPOINTS` is set, the client uses weighted routing with latency-aware rebalancing and failover across the listed endpoints. The top-level `LLM_BASE_URL` and `LLM_API_KEY` vars are ignored.

Each entry must provide:

- `name`: label used in logs and endpoint stats
- `endpoint`: OpenAI-compatible base URL
- `apiKey`: optional per-endpoint API key
- `weight`: positive number used as the endpoint's base routing weight

The top-level `LLM_MODEL`, `LLM_MAX_TOKENS`, `LLM_TEMPERATURE`, and `LLM_TIMEOUT_MS` settings still apply globally to all configured endpoints.
