#!/usr/bin/env python3
"""
Longshot CLI — run the orchestrator with human-readable logs.

Usage:
    longshot "Build a playable MVP of Minecraft"
    longshot "Build a playable MVP of Minecraft" --dashboard

Backward-compatible invocation is also supported:
    python main.py "Build a playable MVP of Minecraft"
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tarfile
import time
from datetime import datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any
from urllib.request import urlopen

DIM = "\033[2m"
RESET = "\033[0m"
BOLD = "\033[1m"
RED = "\033[31m"
YELLOW = "\033[33m"
GREEN = "\033[32m"
CYAN = "\033[36m"
MAGENTA = "\033[35m"
BLUE = "\033[34m"
WHITE = "\033[37m"
UNDERLINE = "\033[4m"

LEVEL_STYLE: dict[str, str] = {
    "debug": DIM,
    "info": GREEN,
    "warn": YELLOW,
    "error": RED,
}

AGENT_STYLE: dict[str, str] = {
    "planner": CYAN,
    "orchestrator": MAGENTA,
    "monitor": BLUE,
    "worker-pool": MAGENTA,
    "reconciler": YELLOW,
    "merge-queue": BLUE,
    "llm-client": DIM,
    "main": WHITE,
    "shared": DIM,
}

ERROR_TRUNCATE_LIMIT = 500
DEFAULT_TRUNCATE_LIMIT = 200
DEBUG_TRUNCATE_LIMIT = 2000

debug_mode = False
RUNTIME_REPO_DEFAULT = "andrewcai8/longshot"
RUNTIME_ENV_VAR = "LONGSHOT_RUNTIME_URL"
PROMPTS_ROOT_ENV_VAR = "LONGSHOT_PROMPTS_ROOT"
PI_CODING_AGENT_VERSION = "^0.55.3"


def _runtime_cache_root() -> Path:
    override = os.environ.get("LONGSHOT_CACHE_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".longshot" / "runtime"


def _runtime_release_url(version_tag: str) -> str:
    repo = os.environ.get("LONGSHOT_RELEASE_REPO", RUNTIME_REPO_DEFAULT)
    return (
        f"https://github.com/{repo}/releases/download/v{version_tag}/"
        f"longshot-runtime-v{version_tag}.tar.gz"
    )


def _safe_extract_tar(archive_path: Path, target_dir: Path) -> None:
    with tarfile.open(archive_path, "r:gz") as tar:
        for member in tar.getmembers():
            member_path = target_dir / member.name
            if not member_path.resolve().is_relative_to(target_dir.resolve()):
                raise RuntimeError(f"Unsafe path in runtime bundle: {member.name}")
        tar.extractall(target_dir)


def _find_runtime_root(search_root: Path) -> Path:
    direct = search_root / "runtime"
    if (direct / "packages" / "orchestrator" / "dist" / "main.js").exists():
        return direct

    for candidate in search_root.glob("**/*"):
        if not candidate.is_dir():
            continue
        if (candidate / "packages" / "orchestrator" / "dist" / "main.js").exists():
            return candidate

    raise RuntimeError("Downloaded runtime bundle does not contain orchestrator entrypoint")


def _write_runtime_package_json(runtime_root: Path) -> None:
    package_json_path = runtime_root / "package.json"
    if package_json_path.exists():
        return

    package_json = {
        "name": "longshot-runtime",
        "private": True,
        "type": "module",
        "dependencies": {
            "@longshot/core": "file:./packages/core",
            "@mariozechner/pi-coding-agent": PI_CODING_AGENT_VERSION,
            "dotenv": "^17.3.1",
        },
    }
    package_json_path.write_text(f"{json.dumps(package_json, indent=2)}\n", encoding="utf-8")


def _ensure_runtime_node_modules(runtime_root: Path) -> None:
    required = [
        runtime_root / "node_modules" / "@longshot" / "core" / "dist" / "index.js",
        runtime_root / "node_modules" / "@mariozechner" / "pi-coding-agent",
        runtime_root / "node_modules" / "dotenv",
    ]
    if all(path.exists() for path in required):
        return

    _write_runtime_package_json(runtime_root)
    try:
        subprocess.run(
            ["npm", "install", "--omit=dev", "--no-audit", "--no-fund"],
            cwd=runtime_root,
            check=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("npm is required for longshot runtime bootstrap") from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"Failed to install longshot runtime dependencies (exit {exc.returncode})"
        ) from exc


def resolve_runtime_root(package_root: Path) -> Path:
    local_entry = package_root / "packages" / "orchestrator" / "dist" / "main.js"
    local_prompts = package_root / "prompts"
    if local_entry.exists() and local_prompts.exists():
        return package_root

    version_tag = get_cli_version()
    cache_root = _runtime_cache_root()
    runtime_root = cache_root / version_tag
    runtime_entry = runtime_root / "packages" / "orchestrator" / "dist" / "main.js"
    runtime_prompts = runtime_root / "prompts"

    if not (runtime_entry.exists() and runtime_prompts.exists()):
        cache_root.mkdir(parents=True, exist_ok=True)
        runtime_root_tmp = cache_root / f"{version_tag}.tmp"
        if runtime_root_tmp.exists():
            shutil.rmtree(runtime_root_tmp)
        runtime_root_tmp.mkdir(parents=True, exist_ok=True)

        runtime_url = os.environ.get(RUNTIME_ENV_VAR) or _runtime_release_url(version_tag)
        archive_path = runtime_root_tmp / "runtime.tar.gz"

        try:
            with urlopen(runtime_url, timeout=120) as resp:
                archive_path.write_bytes(resp.read())
        except Exception as exc:
            raise RuntimeError(
                "Unable to download longshot runtime bundle. "
                f"Set {RUNTIME_ENV_VAR} to a reachable bundle URL or install from source."
            ) from exc

        extracted_dir = runtime_root_tmp / "extracted"
        extracted_dir.mkdir(parents=True, exist_ok=True)
        _safe_extract_tar(archive_path, extracted_dir)
        unpacked_runtime_root = _find_runtime_root(extracted_dir)

        if runtime_root.exists():
            shutil.rmtree(runtime_root)
        shutil.move(str(unpacked_runtime_root), str(runtime_root))
        shutil.rmtree(runtime_root_tmp, ignore_errors=True)

    _ensure_runtime_node_modules(runtime_root)
    return runtime_root


def format_ts(epoch_ms: int) -> str:
    dt = datetime.fromtimestamp(epoch_ms / 1000)
    if debug_mode:
        return dt.strftime("%H:%M:%S.") + f"{dt.microsecond // 1000:03d}"
    return dt.strftime("%H:%M:%S")


def format_data(data: dict[str, Any], level: str = "info") -> str:
    if not data:
        return ""
    if debug_mode:
        truncate_limit = DEBUG_TRUNCATE_LIMIT
    elif level in ("error", "warn"):
        truncate_limit = ERROR_TRUNCATE_LIMIT
    else:
        truncate_limit = DEFAULT_TRUNCATE_LIMIT
    parts: list[str] = []
    for k, v in data.items():
        if isinstance(v, float):
            v = f"{v:.2f}"
        elif isinstance(v, str) and len(v) > truncate_limit:
            v = v[:truncate_limit] + "…"
        elif isinstance(v, list) and len(str(v)) > truncate_limit:
            v = str(v)[:truncate_limit] + "…"
        parts.append(f"{k}={v}")
    return " ".join(parts)


def format_file_link(path: str) -> str:
    return f"{UNDERLINE}{DIM}{path}{RESET}"


def format_line(entry: dict[str, Any]) -> str:
    ts = format_ts(entry.get("timestamp", 0))
    level: str = entry.get("level", "info")
    agent: str = entry.get("agentId", "?")
    msg: str = entry.get("message", "")
    data: dict[str, Any] = entry.get("data", {})

    lstyle = LEVEL_STYLE.get(level, "")
    astyle = AGENT_STYLE.get(agent, WHITE)

    parts = [
        f"{DIM}{ts}{RESET}",
        f"{lstyle}{level.upper():5s}{RESET}",
        f"{astyle}{agent:14s}{RESET}",
        f"{BOLD}{msg}{RESET}",
    ]

    data_str = format_data(data, level)
    if data_str:
        parts.append(f"{DIM}{data_str}{RESET}")

    return " ".join(parts)


def format_metrics_bar(data: dict[str, Any]) -> str:
    active = data.get("activeWorkers", 0)
    pending = data.get("pendingTasks", 0)
    completed = data.get("completedTasks", 0)
    failed = data.get("failedTasks", 0)
    cph = data.get("commitsPerHour", 0)
    tokens = data.get("totalTokensUsed", 0)
    merged = data.get("totalMerged", 0)
    merge_failed = data.get("totalMergeFailed", 0)
    merge_queue = data.get("mergeQueueDepth", 0)
    in_flight = data.get("estimatedInFlightTokens", 0)

    bar = (
        f"  {BOLD}workers={CYAN}{active}{RESET}"
        f"  {BOLD}pending={YELLOW}{pending}{RESET}"
        f"  {BOLD}done={GREEN}{completed}{RESET}"
        f"  {BOLD}failed={RED}{failed}{RESET}"
        f"  {BOLD}commits/hr={CYAN}{cph:.0f}{RESET}"
        f"  {BOLD}merged={GREEN}{merged}{RESET}"
    )

    if merge_failed > 0 or merge_queue > 0:
        bar += f"  {BOLD}merge-q={YELLOW}{merge_queue}{RESET}"
    if merge_failed > 0:
        bar += f"  {BOLD}merge-fail={RED}{merge_failed}{RESET}"

    token_str = f"{tokens:,}"
    if in_flight > 0:
        token_str += f" {DIM}(~+{in_flight:,} in-flight){RESET}"
    bar += f"  {BOLD}tokens={DIM}{token_str}{RESET}"
    return bar


def format_run_summary(
    last_metrics: dict[str, Any] | None,
    elapsed: int,
    run_files: dict[str, str] | None,
) -> str:
    lines: list[str] = []
    lines.append(f"\n{BOLD}{CYAN}═══ Run Summary ═══{RESET}")

    m, s = divmod(elapsed, 60)
    h, m = divmod(m, 60)
    time_str = f"{h}h {m:02d}m {s:02d}s" if h else f"{m}m {s:02d}s"
    lines.append(f"  {DIM}Duration:{RESET}  {time_str}")

    if last_metrics:
        completed = last_metrics.get("completedTasks", 0)
        failed = last_metrics.get("failedTasks", 0)
        total = completed + failed + last_metrics.get("pendingTasks", 0)
        merged = last_metrics.get("totalMerged", 0)
        merge_failed = last_metrics.get("totalMergeFailed", 0)
        conflicts = last_metrics.get("totalConflicts", 0)
        tokens = last_metrics.get("totalTokensUsed", 0)
        cph = last_metrics.get("commitsPerHour", 0)

        lines.append(
            f"  {DIM}Tasks:{RESET}     {GREEN}{completed}{RESET} done / {RED}{failed}{RESET} failed / {total} total"
        )
        lines.append(
            f"  {DIM}Merges:{RESET}    {GREEN}{merged}{RESET} merged / {RED}{merge_failed}{RESET} failed / {YELLOW}{conflicts}{RESET} conflicts"
        )
        lines.append(
            f"  {DIM}Throughput:{RESET} {CYAN}{cph:.0f}{RESET} commits/hr  |  {DIM}{tokens:,} tokens{RESET}"
        )

    if run_files:
        lines.append(f"  {DIM}Log:{RESET}       {format_file_link(run_files.get('logFile', ''))}")
        lines.append(f"  {DIM}Traces:{RESET}    {format_file_link(run_files.get('traceFile', ''))}")
        lines.append(
            f"  {DIM}LLM log:{RESET}   {format_file_link(run_files.get('llmDetailFile', ''))}"
        )

    return "\n".join(lines)


def run(
    request: str, with_dashboard: bool = False, reset: bool = False, debug: bool = False
) -> int:
    global debug_mode
    debug_mode = debug

    package_root = Path(__file__).resolve().parent
    runtime_root = resolve_runtime_root(package_root)
    node_entry = runtime_root / "packages" / "orchestrator" / "dist" / "main.js"
    working_dir = Path.cwd()
    node_cmd = ["node", str(node_entry), request]

    env = os.environ.copy()
    env[PROMPTS_ROOT_ENV_VAR] = str(runtime_root)
    if debug:
        env["LOG_LEVEL"] = "debug"

    print(f"{BOLD}{CYAN}▶ Longshot{RESET}")
    print(f"  {DIM}Request:{RESET} {request[:120]}")
    print(f"  {DIM}CWD:{RESET}     {working_dir}")
    print(f"  {DIM}Runtime:{RESET} {runtime_root}")
    if debug:
        print(f"  {DIM}Debug:{RESET}   {YELLOW}enabled{RESET} (LOG_LEVEL=debug)")
    print()

    if reset:
        reset_script = runtime_root / "scripts" / "reset-target.sh"
        print(f"{YELLOW}⟳ Resetting target repo…{RESET}")
        result = subprocess.run(["bash", str(reset_script)], cwd=working_dir)
        if result.returncode != 0:
            print(f"{RED}✗ Reset failed (exit code {result.returncode}){RESET}")
            return result.returncode
        print(f"{GREEN}✓ Target repo reset to initial commit{RESET}")
        print()

    proc = subprocess.Popen(
        node_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=working_dir,
        env=env,
    )
    if proc.stdout is None:
        raise RuntimeError("Failed to open subprocess stdout pipe")

    dashboard_proc: subprocess.Popen[bytes] | None = None
    if with_dashboard:
        dashboard_proc = subprocess.Popen(
            [sys.executable, str(package_root / "dashboard.py"), "--stdin"],
            stdin=subprocess.PIPE,
            cwd=working_dir,
        )

    last_metrics: dict[str, Any] | None = None
    run_files: dict[str, str] | None = None
    start_time = time.time()
    last_was_metrics = False

    def shutdown(signum: int | None = None, frame: Any = None) -> None:
        if last_was_metrics:
            print()
        print(f"\n{YELLOW}⏹ Shutting down…{RESET}")
        elapsed = int(time.time() - start_time)
        print(format_run_summary(last_metrics, elapsed, run_files))
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        if dashboard_proc:
            dashboard_proc.terminate()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    for raw_line in iter(proc.stdout.readline, b""):
        line = raw_line.decode("utf-8", errors="replace").rstrip()
        if not line:
            continue

        if dashboard_proc and dashboard_proc.stdin:
            try:
                dashboard_proc.stdin.write(raw_line)
                dashboard_proc.stdin.flush()
            except BrokenPipeError:
                dashboard_proc = None

        try:
            entry: dict[str, Any] = json.loads(line)
        except json.JSONDecodeError:
            if last_was_metrics:
                print()
                last_was_metrics = False
            print(f"{DIM}{line}{RESET}")
            continue

        msg: str = entry.get("message", "")
        data: dict[str, Any] = entry.get("data", {})

        if msg == "Run files":
            run_files = data
            print(f"  {DIM}Log:{RESET}     {format_file_link(data.get('logFile', ''))}")
            print(f"  {DIM}Traces:{RESET}  {format_file_link(data.get('traceFile', ''))}")
            print(f"  {DIM}LLM:{RESET}     {format_file_link(data.get('llmDetailFile', ''))}")
            print()
            last_was_metrics = False
            continue

        if msg == "Final summary":
            last_metrics = data
            run_files = {k: data[k] for k in ("logFile", "traceFile", "llmDetailFile") if k in data}
            continue

        if msg == "Metrics":
            last_metrics = data
            elapsed = int(time.time() - start_time)
            m, s = divmod(elapsed, 60)
            h, m = divmod(m, 60)
            time_str = f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"
            sys.stdout.write(f"\r{DIM}[{time_str}]{RESET}{format_metrics_bar(data)}    ")
            sys.stdout.flush()
            last_was_metrics = True
            continue

        if last_was_metrics:
            print()
            last_was_metrics = False

        print(format_line(entry))

    proc.wait()
    exit_code = proc.returncode

    if dashboard_proc and dashboard_proc.stdin:
        dashboard_proc.stdin.close()
        dashboard_proc.wait()

    if last_was_metrics:
        print()

    elapsed = int(time.time() - start_time)

    if exit_code == 0:
        print(f"{GREEN}{BOLD}✓ Orchestrator finished{RESET}")
    else:
        print(f"{RED}{BOLD}✗ Orchestrator exited with code {exit_code}{RESET}")

    print(format_run_summary(last_metrics, elapsed, run_files))
    print()
    return exit_code


def get_cli_version() -> str:
    try:
        return version("longshot")
    except PackageNotFoundError:
        return "dev"


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="longshot",
        description="Run Longshot against a natural-language build request.",
    )
    ap.add_argument("request", help="Build request, e.g. 'Build Minecraft according to SPEC.md'")
    ap.add_argument(
        "--dashboard",
        action="store_true",
        help="Also launch the Rich TUI dashboard",
    )
    ap.add_argument(
        "--reset",
        action="store_true",
        help="Reset target repo to initial commit before running",
    )
    ap.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging (LOG_LEVEL=debug, verbose output)",
    )
    ap.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {get_cli_version()}",
    )
    return ap


def main() -> None:
    args = build_parser().parse_args()
    sys.exit(run(args.request, args.dashboard, args.reset, args.debug))


if __name__ == "__main__":
    main()
