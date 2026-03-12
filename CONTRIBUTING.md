# Contributing to Longshot

Longshot is a massively parallel autonomous coding tool. This guide takes you from `git clone` to running tests.

## Prerequisites

- **Node.js** 22+
- **pnpm** 9+
- **Python** 3.12+
- **uv** (Python package manager)
- **Modal account** — only needed for full E2E tests, not unit tests

## Setup

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/<your-username>/longshot.git
cd longshot

# Install TypeScript packages
pnpm install
pnpm build

# Install Python dependencies
uv sync

# Configure environment
cp .env.example .env
# Edit .env with your API keys
```

`pnpm build` compiles in dependency order: `core` first, then `orchestrator` and `sandbox` in parallel (via Turborepo).

For iterative development, run `pnpm dev` in a separate terminal. It starts `tsc -b --watch` across packages so builds update automatically on save.

## Running Tests

```bash
# All unit tests
pnpm test

# Single package
pnpm --filter @longshot/orchestrator test
pnpm --filter @longshot/sandbox test

# Python E2E (requires Modal credentials)
python scripts/test_sandbox.py
```

Tests use Node's built-in `node:test` runner. No Jest, no Vitest.

## The Modal Boundary

Modal is only required for `spawn_sandbox.py`, which runs worker tasks in cloud sandboxes. Everything else runs locally.

**You can test all of this without Modal:**
- Unit tests across all packages
- Orchestrator logic (planner, merge queue, reconciler)
- Planner output (LLM calls go to your API key, not Modal)
- Core utilities

**You need Modal for:**
- Full E2E runs that actually execute code in sandboxes
- `python scripts/test_sandbox.py`

## Architecture

Longshot has two Python/TypeScript boundaries and a single NDJSON protocol connecting everything.

```
main.py (Python CLI + dashboard)
  |
  | spawns subprocess
  v
packages/orchestrator/dist/main.js
  |
  +-- Planner (LLM, root-planner.md)
  |     |
  |     +-- large tasks --> Subplanner (subplanner.md)
  |
  +-- WorkerPool
        |
        | spawns subprocess per task (hot path, hundreds concurrent)
        v
      infra/spawn_sandbox.py
        |
        v
      Modal sandbox
        - clones repo
        - creates branch
        - runs worker-runner.js
            (pi-coding-agent + worker.md)
        |
        v
      result.json --> push branch
        |
        v
      MergeQueue (serial, rebase/ff/merge)
        - conflicts become new fix tasks
        |
        v
      Reconciler (periodic build/test sweeps, reconciler.md)
        |
        v
      Finalization (drain queue, final sweep, retry unmerged)
```

**Python is a pure display layer.** `main.py` spawns the Node orchestrator and reads its NDJSON stdout to render the dashboard at 4Hz. It does no planning, no merging, no LLM calls.

**NDJSON is the universal bus.** Every status update, task event, and result flows as newline-delimited JSON from the orchestrator to the dashboard.

**Prompts are markdown files, not compiled code.** The four files in `prompts/` (`root-planner.md`, `subplanner.md`, `worker.md`, `reconciler.md`) are loaded at startup. Edit them and rerun without rebuilding.

## Packages

### `packages/core` ⭐ Easy

Pure utilities with zero internal dependencies. Types, helpers, shared constants. If you're new to the codebase, start here. Changes are low-risk and easy to test in isolation.

### `packages/orchestrator` ⭐⭐⭐ Complex

The brain. 14 source files covering the planner, worker pool, merge queue, reconciler, and finalization logic. Understand the NDJSON protocol and the architecture diagram above before diving in. High leverage, high complexity.

### `packages/sandbox` ⭐⭐ Medium

Three files. This is the Modal worker harness that runs inside the sandbox: clones the repo, sets up the environment, runs the coding agent, and writes `result.json`. Changes here affect what happens inside each parallel worker.


## Code Style

TypeScript/JavaScript uses **Biome** for formatting and linting:

```bash
pnpm format
```

Python uses **Ruff**:

```bash
uv run ruff check --fix .
uv run ruff format .
```

CI will fail on lint errors, so run these before pushing.

## PR Workflow

1. Branch from `main` with a descriptive name (`fix/merge-queue-deadlock`, `feat/reconciler-retry`)
2. Keep commits focused. One logical change per commit.
3. Open a PR against `main`. The PR template will prompt you for context.
4. If your change touches the orchestrator or sandbox, note whether you tested with or without Modal.

## Where to Contribute

**Good first issues** are tagged on GitHub. In general:

- `packages/core` is the safest place to start. Utilities, types, and helpers welcome.
- `prompts/` improvements don't require any code changes. If you find the planner making poor decisions, better prompt engineering is a real contribution.
- Dashboard display logic in `main.py` is self-contained Python with no Modal dependency.
- Documentation and test coverage gaps exist throughout.

Check [github.com/Blastgits/longshot/issues](https://github.com/Blastgits/longshot/issues) for open issues before starting something large. For significant changes, open an issue first to discuss the approach.
