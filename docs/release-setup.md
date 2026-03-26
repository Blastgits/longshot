# Release Setup (PyPI + Homebrew)

This runbook covers one-time setup and first release for public CLI distribution.

Current ownership split:

- Canonical code + runtime releases: `Blastgits/longshot`
- Canonical Homebrew tap: `andrewcai8/homebrew-longshot` and `brew tap andrewcai8/longshot`

Until a `Blastgits/homebrew-longshot` repo actually exists, keep the Homebrew instructions and release wiring pointed at `andrewcai8`.

## 1) One-time GitHub setup

From repository root:

```bash
scripts/setup-release.sh
```

What it does:

- Ensures the canonical Homebrew tap repo exists (`andrewcai8/homebrew-longshot` by default for `Blastgits/longshot`)
- Sets repository variable `HOMEBREW_TAP_REPO`
- Sets repository variable `ENABLE_PUBLIC_RELEASE=false` (safe default, prevents accidental publishing)
- Optionally sets `HOMEBREW_TAP_TOKEN` if provided via environment variable

If you already have a fine-grained token that can push to the tap repo:

```bash
HOMEBREW_TAP_TOKEN=<token> scripts/setup-release.sh
```

Recommended token scope for `HOMEBREW_TAP_TOKEN`:

- Fine-grained PAT
- Repository access: only `andrewcai8/homebrew-longshot`
- Permissions: **Contents: Read and write**

## 2) Configure PyPI trusted publishing

In PyPI project settings, add a trusted publisher:

- **Owner:** your GitHub org/user
- **Repository:** `longshot`
- **Workflow name:** `release.yml`
- **Environment:** leave empty unless you intentionally use one

The workflow is configured for OIDC (`id-token: write`) and uses `pypa/gh-action-pypi-publish`.

## 3) Preflight checks before tagging

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
python -m ruff check .
python -m build
```

## 4) Cut a release

When you're ready for public distribution, enable publishing:

```bash
gh variable set ENABLE_PUBLIC_RELEASE --repo Blastgits/longshot --body true
```

1. Bump `pyproject.toml` version.
2. Commit and push.
3. Create and push a matching tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

`release.yml` will then:

- Build/test/lint
- Build Python artifacts (`dist/python`)
- Build runtime bundle (`dist/runtime/longshot-runtime-vX.Y.Z.tar.gz`)
- Publish GitHub release assets
- Publish to PyPI
- Generate Homebrew formula artifact
- Push formula to tap (if `HOMEBREW_TAP_REPO` + `HOMEBREW_TAP_TOKEN` are set)

## 5) Validate as an external user

```bash
pipx install longshot
longshot --version
```

Homebrew:

```bash
brew tap andrewcai8/longshot
brew install longshot
longshot --version
```
