# @longshot/orchestrator

Core orchestration engine — planning, worker dispatch, merge queue, and reconciliation for the Longshot multi-agent system.

## Purpose

This package contains the full lifecycle management for parallel coding runs: LLM-driven task decomposition, ephemeral worker dispatch to Modal sandboxes, serial merge queue with conflict retry, and a periodic reconciler that keeps the target repo green.

## Architecture

The package is organized in 7 dependency layers, each building on the one below.

| Layer | Files | Responsibility |
|-------|-------|---------------|
| 0 — Foundation | `config.ts`, `shared.ts` | Env config, repo state reading, Pi session helpers, concurrency primitives |
| 1 — Data | `task-queue.ts`, `task-store.ts`, `scope-tracker.ts` | Task state machine + priority queue, durable task-state journal, file-lock tracking |
| 2 — LLM | `llm-client.ts` | Multi-endpoint routing, latency-adaptive weighting, health tracking |
| 3 — Workers | `worker-pool.ts` | Ephemeral model: spawns `spawn_sandbox.py` per task |
| 4 — Merge | `merge-queue.ts` | Priority queue, conflict retry with rebase, background drain |
| 5 — Planning | `planner.ts`, `subplanner.ts` | Root loop (iterative LLM + delta context), recursive decomposer |
| 6 — Health | `reconciler.ts`, `monitor.ts` | Periodic tsc+test sweeps, metrics snapshots |
| 7 — Assembly | `orchestrator.ts`, `main.ts`, `index.ts` | Factory wiring, CLI entry, public barrel |

## File Guide

| File | Description |
|------|-------------|
| `config.ts` | Parses all env vars into `OrchestratorConfig`. Supports single (`LLM_BASE_URL`) and multi-endpoint (`LLM_ENDPOINTS`) LLM config |
| `shared.ts` | `readRepoState`, `parsePlannerResponse`, `ConcurrencyLimiter`, `GitMutex`, `slugifyForBranch`, Pi session factory |
| `task-queue.ts` | `PriorityQueue` (min-heap) + `TaskQueue` (state machine with callbacks) |
| `task-store.ts` | `TaskStore` interface + in-memory/journal implementations for durable task dispatch state |
| `scope-tracker.ts` | `ScopeTracker` — maps active task IDs to locked file sets, detects overlaps |
| `llm-client.ts` | `LLMClient` — weighted endpoint selection, EMA latency tracking, `waitForReady` probe |
| `worker-pool.ts` | `WorkerPool` — ephemeral model, streams sandbox stdout as NDJSON progress events |
| `merge-queue.ts` | `MergeQueue` — sorted by priority, up to 2 conflict retries with rebase, background tick |
| `planner.ts` | `Planner` — iterative Pi session, delta file-tree/features diffs, `injectTask` for external tasks |
| `subplanner.ts` | `Subplanner` — recursive decomposer, max depth 3, aggregates subtask handoffs |
| `reconciler.ts` | `Reconciler` — tsc + npm test + conflict-marker sweep, adaptive interval (speeds up on failure) |
| `monitor.ts` | `Monitor` — polls worker pool, emits `MetricsSnapshot`, detects timeouts |
| `orchestrator.ts` | `createOrchestrator` factory + finalization phase (drain → re-merge → sweep loop) |
| `main.ts` | CLI entry: loads dotenv, creates orchestrator, wires callbacks, exits with code 1 on failure |
| `index.ts` | Public API barrel |

## How to Test

```bash
pnpm --filter @longshot/orchestrator test
```

This compiles the package first, then runs the node:test suite.

## How to Modify

- **Add a config option**: add field to `OrchestratorConfig` in `config.ts`, parse from `process.env`, and update `.env.example` in the repo root.
- **Change merge strategy**: edit `merge-queue.ts` → `mergeBranch()`. The strategy comes from config, not hard-coded.
- **Add a planner callback**: extend `OrchestratorCallbacks` in `orchestrator.ts` and wire it in `createOrchestrator`.
- **Adjust reconciler frequency**: set `HEALTH_CHECK_INTERVAL` env var or pass `reconcilerIntervalMs` to `createOrchestrator`.
- **Change decomposition threshold**: edit `DEFAULT_SUBPLANNER_CONFIG` in `subplanner.ts` (`scopeThreshold`, `maxDepth`, `maxSubtasks`).
