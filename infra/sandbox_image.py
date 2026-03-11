"""
Modal Sandbox Image for Coding Agent Workers
=============================================

Defines the container image that runs inside each Modal sandbox.
Each sandbox gets a copy of this image with:
- Node.js 22 (for TypeScript projects)
- Git (for version control)
- Python 3.12 (for scripting)
- Common dev tools (curl, wget, ripgrep, jq, tree)
- The @longshot/sandbox package (the agent itself)
- Pi coding agent SDK (@mariozechner/pi-coding-agent)

Usage:
    from infra.sandbox_image import create_agent_image
    image = create_agent_image()
    sandbox = modal.Sandbox.create(image=image, ...)
"""

import os
from pathlib import Path

import modal

# Root of the longshot repo
REPO_ROOT = Path(__file__).parent.parent


def create_agent_image() -> modal.Image:
    """
    Create the Modal Image for coding agent sandboxes.

    The image includes:
    - Debian slim base with Python 3.12
    - Node.js 22.x LTS via NodeSource
    - Git, curl, wget, ripgrep, jq, tree, build-essential
    - pnpm package manager
    - The compiled @longshot/sandbox package

    Returns:
        modal.Image: Ready-to-use image for Sandbox.create()
    """
    image = (
        modal.Image.debian_slim(python_version="3.12")
        # System packages
        .apt_install(
            "git",
            "curl",
            "wget",
            "jq",
            "tree",
            "build-essential",
            "ca-certificates",
            "gnupg",
        )
        # Install Node.js 22 via NodeSource
        .run_commands(
            "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
            "apt-get install -y nodejs",
            "node --version",
            "npm --version",
        )
        # Install ripgrep (not in default debian repos)
        .run_commands(
            "curl -LO https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep_14.1.1-1_amd64.deb",
            "dpkg -i ripgrep_14.1.1-1_amd64.deb",
            "rm ripgrep_14.1.1-1_amd64.deb",
        )
        # Install pnpm
        .run_commands(
            "npm install -g pnpm@9",
            "pnpm --version",
        )
        # Git configuration for agent commits
        .run_commands(
            f'git config --global user.name "{os.environ.get("GIT_COMMIT_NAME", "Longshot Bot")}"',
            f'git config --global user.email "{os.environ.get("GIT_COMMIT_EMAIL", "agent@longshot.bot")}"',
            "git config --global init.defaultBranch main",
        )
        # Set working directory
        .workdir("/workspace")
        # Environment variables
        .env(
            {
                "NODE_ENV": "production",
                "PNPM_HOME": "/root/.local/share/pnpm",
                "PATH": "/root/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin",
            }
        )
    )

    return image


def create_worker_image() -> modal.Image:
    """
    Extended image that includes the pre-built @longshot/sandbox package
    and the Pi coding agent SDK.

    Call this after packages/sandbox has been built locally.
    Copies the compiled sandbox agent code into the image.
    """
    base = create_agent_image()

    sandbox_dist = REPO_ROOT / "packages" / "sandbox" / "dist"
    sandbox_pkg = REPO_ROOT / "packages" / "sandbox" / "package.json"
    core_dist = REPO_ROOT / "packages" / "core" / "dist"
    core_pkg = REPO_ROOT / "packages" / "core" / "package.json"

    image = (
        base
        # Copy core package
        .add_local_dir(str(core_dist), "/agent/packages/core/dist", copy=True)
        .add_local_file(str(core_pkg), "/agent/packages/core/package.json", copy=True)
        # Copy sandbox package
        .add_local_dir(str(sandbox_dist), "/agent/packages/sandbox/dist", copy=True)
        .add_local_file(str(sandbox_pkg), "/agent/packages/sandbox/package.json", copy=True)
        # Install Pi coding agent SDK globally
        .run_commands("npm install -g @mariozechner/pi-coding-agent@0.55.3")
        # Link @longshot/core so sandbox can resolve it
        # (both packages are pre-built JS with zero runtime deps — no npm install needed)
        .run_commands(
            "mkdir -p /agent/node_modules/@longshot",
            "ln -s /agent/packages/core /agent/node_modules/@longshot/core",
            # Link Pi SDK so worker-runner.js can resolve it
            "ln -s $(npm root -g)/@mariozechner /agent/node_modules/@mariozechner",
            "ln -s /agent/packages/sandbox/dist/worker-runner.js /agent/worker-runner.js",
        )
    )

    return image


# Standalone: test image build
# Usage: modal run infra/sandbox_image.py
app = modal.App("sandbox-image-test")


@app.function(image=create_agent_image())
def test_image():
    """Verify the image has all required tools."""
    import subprocess

    checks = [
        ("node", ["node", "--version"]),
        ("npm", ["npm", "--version"]),
        ("pnpm", ["pnpm", "--version"]),
        ("git", ["git", "--version"]),
        ("rg", ["rg", "--version"]),
        ("jq", ["jq", "--version"]),
        ("python3", ["python3", "--version"]),
        ("curl", ["curl", "--version"]),
    ]

    results = {}
    for name, cmd in checks:
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            version = result.stdout.strip().split("\n")[0]
            results[name] = {"status": "ok", "version": version}
        except Exception as e:
            results[name] = {"status": "error", "error": str(e)}

    return results


@app.local_entrypoint()
def main():
    """Test the sandbox image by running tool checks."""
    results = test_image.remote()
    print("\n=== Sandbox Image Verification ===")
    for tool, info in results.items():
        status = "✅" if info["status"] == "ok" else "❌"
        detail = info.get("version", info.get("error", "unknown"))
        print(f"  {status} {tool}: {detail}")
    print("==================================\n")
