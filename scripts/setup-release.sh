#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/setup-release.sh [--repo owner/repo] [--tap-repo owner/homebrew-longshot] [--create-tap]

Sets up GitHub-side configuration used by .github/workflows/release.yml:
  - Ensures Homebrew tap repository exists
  - Sets repository variable HOMEBREW_TAP_REPO
  - Optionally sets repository secret HOMEBREW_TAP_TOKEN from env var

Environment variables:
  HOMEBREW_TAP_TOKEN   Optional. If provided, script will set secret HOMEBREW_TAP_TOKEN

Examples:
  scripts/setup-release.sh
  scripts/setup-release.sh --repo Blastgits/longshot --tap-repo andrewcai8/homebrew-longshot
  HOMEBREW_TAP_TOKEN=ghp_xxx scripts/setup-release.sh
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd gh

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

repo=""
tap_repo=""
create_tap=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      repo="$2"
      shift 2
      ;;
    --tap-repo)
      tap_repo="$2"
      shift 2
      ;;
    --create-tap)
      create_tap=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$repo" ]]; then
  repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
fi

owner="${repo%%/*}"
if [[ -z "$tap_repo" ]]; then
  if [[ "$repo" == "Blastgits/longshot" ]]; then
    tap_repo="andrewcai8/homebrew-longshot"
  else
    tap_repo="${owner}/homebrew-longshot"
  fi
fi

echo "Repository: ${repo}"
echo "Homebrew tap: ${tap_repo}"

if ! gh repo view "$tap_repo" --json nameWithOwner >/dev/null 2>&1; then
  if [[ "$create_tap" == true ]]; then
    echo "Creating tap repository ${tap_repo}"
    gh repo create "$tap_repo" --public --add-readme --description "Homebrew tap for longshot"
  else
    echo "Tap repository ${tap_repo} does not exist." >&2
    exit 1
  fi
else
  echo "Tap repository already exists"
fi

echo "Setting repository variable HOMEBREW_TAP_REPO=${tap_repo}"
gh variable set HOMEBREW_TAP_REPO --body "$tap_repo" --repo "$repo"

if gh variable get ENABLE_PUBLIC_RELEASE --repo "$repo" >/dev/null 2>&1; then
  echo "ENABLE_PUBLIC_RELEASE already exists; leaving current value unchanged"
else
  echo "Setting repository variable ENABLE_PUBLIC_RELEASE=false (safe default)"
  gh variable set ENABLE_PUBLIC_RELEASE --body "false" --repo "$repo"
fi

if [[ -n "${HOMEBREW_TAP_TOKEN:-}" ]]; then
  echo "Setting repository secret HOMEBREW_TAP_TOKEN from environment"
  gh secret set HOMEBREW_TAP_TOKEN --body "$HOMEBREW_TAP_TOKEN" --repo "$repo"
else
  echo
  echo "HOMEBREW_TAP_TOKEN was not provided."
  echo "Set it with one of the following before your first release tag:"
  echo "  gh secret set HOMEBREW_TAP_TOKEN --repo ${repo}"
  echo "  # or"
  echo "  HOMEBREW_TAP_TOKEN=<token> scripts/setup-release.sh --repo ${repo} --tap-repo ${tap_repo}"
fi

echo
echo "Next: configure PyPI trusted publishing for ${repo} and workflow '.github/workflows/release.yml'."
echo "When you're ready to actually publish, run:"
echo "  gh variable set ENABLE_PUBLIC_RELEASE --repo ${repo} --body true"
