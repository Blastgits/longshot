# Longshot

[![CI](https://github.com/andrewcai8/longshot/actions/workflows/ci.yml/badge.svg)](https://github.com/andrewcai8/longshot/actions/workflows/ci.yml)

Massively parallel autonomous coding: decompose any project into hundreds of tasks and execute them simultaneously in isolated cloud sandboxes.

## What it does

Longshot takes a natural-language build request and turns it into working code. A root planner breaks the request into granular tasks, dispatches them to ephemeral Modal sandboxes running in parallel, and merges the results back into your repository. A reconciler monitors build health throughout and automatically spawns fix tasks when something breaks.

The entire system is stateless. Workers are ephemeral, state lives only in Git, and the orchestrator runs locally while all execution happens in the cloud.

## Architecture

```
User request
    └── Root Planner (LLM)
            └── Subplanners (for large task scopes)
                    └── Workers (parallel, up to MAX_WORKERS)
                            └── Modal Sandboxes
                                    └── Pi Coding Agent (@mariozechner/pi-coding-agent)
                                            └── Merge Queue
                                                    └── Reconciler (self-healing)
```

**Three TypeScript packages** (scope `@longshot/*`):

- `packages/core` — shared types, logging, LLM client, git utilities
- `packages/orchestrator` — planner loop, worker pool, merge queue, reconciler
- `packages/sandbox` — Modal sandbox definition and worker harness

**Python layer** (`main.py`, `dashboard.py`) wraps the Node orchestrator with a human-readable CLI and optional Rich TUI dashboard.

**Modal** currently provides the cloud sandboxes. Each worker runs in a fully isolated container with its own clone of the target repository.

## Moonshot Goals

Longshot already runs parallel planning and execution across isolated workers. The moonshot is to evolve this into a **self-driving codebase loop** that can handle larger scopes over longer time horizons while keeping human review as the final gate.

### Direction of travel

- **Background agents**: long-lived agents that can keep working asynchronously and report back with reviewable artifacts.
- **Long-running execution**: multi-hour task completion with explicit planning, progress memory, and follow-through.
- **Issue-to-PR automation**: tighter pipelines from problem intake to draft PRs, with CI + human approval gates.
- **Agent reliability**: better harness design for context rollover, retries, verification, and anti-fragile recovery.

### Planned platform abstractions (future)

- **Pluggable sandbox providers**: keep Modal as the current default, while adding adapter-based support for alternatives like **E2B** (and other compatible runtimes).
- **Pluggable agent harnesses**: expand beyond the current Pi harness to support multiple coding agents (for example **OpenCode**, **Claude Code**, and other compatible harnesses).
- **Configuration-first selection**: make sandbox + harness provider choice a deploy-time config concern instead of a code fork, so open-source contributors can swap backends safely.
- **Capability-aware routing**: normalize provider capabilities (filesystem, shell, network, session longevity, snapshots) and route tasks to the best compatible backend.

### Prior art and references

#### User-provided references

- [Why We Built Our Background Agent (Ramp)](https://builders.ramp.com/post/why-we-built-our-background-agent)
- [Minions: Stripe’s one-shot, end-to-end coding agents](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents)
- [Minions Part 2 (Stripe)](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2)
- [The Self-Driving Codebase — Background Agents and the Next Era of Enterprise Software Delivery](https://background-agents.com/)
- [The third era of AI software development (Cursor)](https://cursor.com/blog/third-era)
- [Towards self-driving codebases (Cursor)](https://cursor.com/blog/self-driving-codebases)
- [Expanding our long-running agents research preview (Cursor)](https://cursor.com/blog/long-running-agents)

#### Additional relevant references

- [Effective harnesses for long-running agents (Anthropic Engineering)](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

## Prerequisites

### End users (installed CLI)

- Python 3.12+
- Node.js 22+ (runtime engine for the orchestrator)

### Development (this repository)

- Node.js 22+
- pnpm
- Python 3.12+
- [uv](https://docs.astral.sh/uv/)
- [Modal](https://modal.com) account (`pip install modal && modal setup`)

## Install (public CLI)

### PyPI + pipx (recommended)

```bash
pipx install longshot
longshot --version
```

### Homebrew tap

```bash
brew tap andrewcai8/longshot
brew install longshot
longshot --version
```

On first run, the CLI downloads a matching runtime bundle and installs Node runtime dependencies into a local cache (`~/.longshot/runtime/<version>` by default).

Optional overrides:

- `LONGSHOT_RUNTIME_URL`: explicit URL for the runtime tarball
- `LONGSHOT_RELEASE_REPO`: GitHub repo slug for release downloads (default: `andrewcai8/longshot`)
- `LONGSHOT_CACHE_DIR`: custom cache root for runtime assets

## Release maintainers

For one-time publishing setup (PyPI trusted publishing + Homebrew tap wiring) and first release steps, see:

- [`docs/release-setup.md`](./docs/release-setup.md)

Publishing is intentionally disabled by default via repository variable `ENABLE_PUBLIC_RELEASE=false`.

## Quick Start

```bash
# Install dependencies
pnpm install
pnpm build

# Install Python dependencies
uv sync

# Optional: install a global CLI command from this repo
uv tool install --from . longshot

# Configure environment
cp .env.example .env
# Edit .env with your LLM credentials and target repo

# Run
uv run longshot "Build a REST API according to SPEC.md"

# With the Rich TUI dashboard
uv run longshot "Build a REST API according to SPEC.md" --dashboard

# Reset target repo to initial commit before running
uv run longshot "Build a REST API according to SPEC.md" --reset

# Debug logging
uv run longshot "Build a REST API according to SPEC.md" --debug

# If installed globally with uv tool, run without `uv run`
longshot "Build a REST API according to SPEC.md"
```

## Configuration

All configuration is via environment variables in `.env`.

### Required

| Variable | Description |
|----------|-------------|
| `GIT_REPO_URL` | URL of the target repository workers will clone and commit to |
| `LLM_BASE_URL` | Base URL of your LLM API endpoint (OpenAI-compatible) |
| `LLM_API_KEY` | API key for the LLM endpoint |

For multiple LLM endpoints with load balancing, use `LLM_ENDPOINTS` instead of `LLM_BASE_URL`/`LLM_API_KEY`:

```json
LLM_ENDPOINTS=[{"name":"primary","endpoint":"https://...","apiKey":"sk-...","weight":100}]
```

Each `weight` must be a positive number. `LLM_MODEL`, `LLM_MAX_TOKENS`, and `LLM_TEMPERATURE` remain global settings shared by all endpoints.

### Workers

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_WORKERS` | `50` | Maximum number of parallel workers |
| `WORKER_TIMEOUT` | `1800` | Worker timeout in seconds |

### LLM

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_MODEL` | `glm-5` | Model name to pass to the API |
| `LLM_MAX_TOKENS` | `65536` | Max tokens per LLM request |
| `LLM_TEMPERATURE` | `0.7` | Sampling temperature |

### Sandboxes

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_CPU_CORES` | `4` | CPU cores per Modal sandbox |
| `SANDBOX_MEMORY_MB` | `8192` | Memory per Modal sandbox (MB) |
| `SANDBOX_IDLE_TIMEOUT` | `300` | Sandbox idle timeout in seconds |

### Git

| Variable | Default | Description |
|----------|---------|-------------|
| `GIT_MAIN_BRANCH` | `main` | Main branch name in the target repo |
| `GIT_BRANCH_PREFIX` | `worker/` | Prefix for worker branches |

### Orchestrator

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_CHECK_INTERVAL` | `10` | Reconciler health check interval in seconds |
| `MERGE_STRATEGY` | `rebase` | Merge strategy: `fast-forward`, `rebase`, or `merge-commit` |
| `FINALIZATION_ENABLED` | `true` | Run build/test sweep after all tasks complete |
| `FINALIZATION_MAX_ATTEMPTS` | `3` | Max reconciler fix attempts during finalization |


## Contributing

1. Fork the repo
2. Create a branch (`git checkout -b feat/your-feature`)
3. Commit your changes
4. Open a pull request against `main`

## License

See [LICENSE](./LICENSE).
