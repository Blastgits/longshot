"""
Sandbox Spawner — File I/O + exec pattern for Modal sandboxes
=============================================================

Creates an ephemeral Modal sandbox, writes task.json into it,
clones the target repo, execs worker-runner.js, reads result.json,
and returns the handoff dict. Purely synchronous, no HTTP tunnels.

Usage:
    from infra.spawn_sandbox import run_task

    result = run_task({
        "task": {"id": "task-001", "branch": "worker/task-001", ...},
        "systemPrompt": "You are a coding agent...",
        "repoUrl": "https://github.com/org/repo.git",
        "llmConfig": {"endpoint": "...", "model": "...", "maxTokens": 4096,
                       "temperature": 0.2, "apiKey": "sk-..."},
    })
    print(result)  # Handoff dict
"""

import argparse
import base64
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import modal

from infra.sandbox_image import create_worker_image

# ---------------------------------------------------------------------------
# Module-level Modal resources
# ---------------------------------------------------------------------------
app = modal.App.lookup("longshot", create_if_missing=True)
image = create_worker_image()
RESULT_PREFIX = "__LONGSHOT_RESULT__ "


# ---------------------------------------------------------------------------
# Core function
# ---------------------------------------------------------------------------
def _redact_secret(text: str, secret: str) -> str:
    if not secret:
        return text
    return text.replace(secret, "[REDACTED]")


def run_task(payload: dict) -> dict:
    """
    Run a single coding task in an ephemeral Modal sandbox.

    Args:
        payload: dict with keys:
            task        – Task dict (must include ``id`` and ``branch``)
            systemPrompt – The worker system prompt
            repoUrl     – Git repo URL to clone
            llmConfig   – {endpoint, model, maxTokens, temperature, apiKey}

    Returns:
        Handoff result dict from the worker, or a failure stub on error.
    """
    task = payload["task"]
    task_id = task["id"]
    git_token = payload.get("gitToken", "")
    sb = None

    try:
        t0 = time.time()
        sb = modal.Sandbox.create(
            app=app,
            image=image,
            timeout=2400,
            workdir="/workspace",
        )
        print(f"[spawn] sandbox created for task {task_id} ({time.time() - t0:.1f}s)", flush=True)

        f = sb.open("/workspace/task.json", "w")
        f.write(json.dumps(payload))
        f.close()

        # Build git auth header for private GitHub clones/pushes without
        # embedding secrets in the URL (which can leak into logs/errors).
        repo_url = payload["repoUrl"]
        github_extraheader = None
        if git_token and "github.com" in repo_url:
            basic_auth = base64.b64encode(f"x-access-token:{git_token}".encode()).decode("ascii")
            github_extraheader = f"AUTHORIZATION: basic {basic_auth}"
        else:
            github_extraheader = None

        # Full clone (no --depth 1) so git diff against startSha works in worker-runner
        t1 = time.time()
        if github_extraheader:
            clone = sb.exec(
                "git",
                "-c",
                f"http.https://github.com/.extraheader={github_extraheader}",
                "clone",
                repo_url,
                "/workspace/repo",
                timeout=120,
            )
        else:
            clone = sb.exec(
                "git",
                "clone",
                repo_url,
                "/workspace/repo",
                timeout=120,
            )
        clone.wait()
        if github_extraheader:
            persist_auth = sb.exec(
                "git",
                "-C",
                "/workspace/repo",
                "config",
                "http.https://github.com/.extraheader",
                github_extraheader,
                timeout=30,
            )
            persist_auth.wait()
        print(f"[spawn] repo cloned for task {task_id} ({time.time() - t1:.1f}s)", flush=True)

        branch = task["branch"]
        conflict_source = task.get("conflictSourceBranch")

        if conflict_source:
            # Conflict-resolution mode: checkout the original branch and
            # rebase onto main so conflict markers appear in the working tree.
            fetch_branch = sb.exec(
                "git",
                "-C",
                "/workspace/repo",
                "fetch",
                "origin",
                conflict_source,
                timeout=60,
            )
            fetch_branch.wait()
            checkout_proc = sb.exec(
                "git",
                "-C",
                "/workspace/repo",
                "checkout",
                "-b",
                branch,
                f"origin/{conflict_source}",
            )
            checkout_proc.wait()
            rebase_proc = sb.exec(
                "git",
                "-C",
                "/workspace/repo",
                "rebase",
                "origin/main",
            )
            # Rebase will exit non-zero if conflicts exist — that's expected.
            try:
                rebase_proc.wait()
            except Exception as rebase_error:
                print(
                    f"[spawn] rebase ended with conflicts for {task_id}: "
                    f"{_redact_secret(str(rebase_error), git_token)}",
                    flush=True,
                )
            print(
                f"[spawn] conflict-resolution mode: rebased {conflict_source} onto main for {task_id}",
                flush=True,
            )
        else:
            branch_proc = sb.exec(
                "git",
                "-C",
                "/workspace/repo",
                "checkout",
                "-b",
                branch,
            )
            branch_proc.wait()
            print(f"[spawn] branch created for task {task_id}: {branch}", flush=True)

        print(f"[spawn] starting worker agent for task {task_id}", flush=True)
        process = sb.exec("node", "/agent/worker-runner.js", timeout=1800)

        # Stream stdout and stderr concurrently so worker-runner log
        # messages (written to stderr) are visible in real-time instead
        # of being collected only after the process exits.
        def _stream_stderr():
            for line in process.stderr:
                # Forward to stdout with [worker:ID] prefix so the
                # orchestrator's forwardWorkerLine picks them up.
                print(f"[worker:{task_id}] {line}", end="", flush=True)

        stderr_thread = threading.Thread(target=_stream_stderr, daemon=True)
        stderr_thread.start()

        for line in process.stdout:
            print(f"[worker:{task_id}] {line}", end="", flush=True)

        stderr_thread.join(timeout=5)
        process.wait()

        f = sb.open("/workspace/result.json", "r")
        result = json.loads(f.read())
        f.close()

        has_changes = result.get("filesChanged") and len(result["filesChanged"]) > 0
        if git_token and has_changes:
            push_proc = sb.exec(
                "git",
                "-C",
                "/workspace/repo",
                "push",
                "origin",
                branch,
                timeout=120,
            )
            push_proc.wait()
            print(f"[spawn] pushed branch {branch} to origin", flush=True)
        elif not has_changes:
            print(f"[spawn] no files changed, skipping push for {branch}", flush=True)
        else:
            print(f"[spawn] WARNING: no GIT_TOKEN, skipping push for {branch}", flush=True)

        print(f"[spawn] task {task_id} completed: {result.get('status', 'unknown')}", flush=True)
        return result

    except Exception as e:
        safe_error = _redact_secret(str(e), git_token)
        print(f"[spawn] task {task_id} failed: {safe_error}", flush=True)
        return {
            "taskId": task_id,
            "status": "failed",
            "summary": safe_error,
            "diff": "",
            "filesChanged": [],
            "concerns": [safe_error],
            "suggestions": ["Retry the task"],
            "metrics": {
                "linesAdded": 0,
                "linesRemoved": 0,
                "filesCreated": 0,
                "filesModified": 0,
                "tokensUsed": 0,
                "toolCallCount": 0,
                "durationMs": 0,
            },
        }

    finally:
        if sb is not None:
            try:
                sb.terminate()
                print(f"[spawn] sandbox terminated for task {task_id}", flush=True)
            except Exception as terminate_error:
                print(
                    f"[spawn] WARNING: failed to terminate sandbox for {task_id}: "
                    f"{_redact_secret(str(terminate_error), git_token)}",
                    flush=True,
                )


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Spawn a Modal sandbox and run one task")
    parser.add_argument(
        "payload_json",
        nargs="?",
        help="Task payload as JSON (legacy mode; prefer --stdin)",
    )
    parser.add_argument(
        "--stdin",
        action="store_true",
        help="Read JSON payload from stdin",
    )
    args = parser.parse_args()

    raw_payload = ""
    if args.stdin:
        raw_payload = sys.stdin.read()
    elif args.payload_json:
        raw_payload = args.payload_json

    if not raw_payload.strip():
        raise SystemExit("Missing payload JSON. Use --stdin or pass payload_json argument.")

    payload = json.loads(raw_payload)
    result = run_task(payload)
    print(f"{RESULT_PREFIX}{json.dumps(result)}")
