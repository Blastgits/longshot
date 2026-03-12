#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path


class FormulaArgs(argparse.Namespace):
    version: str
    sha256: str
    repo: str
    output: str

def parse_args() -> FormulaArgs:
    parser = argparse.ArgumentParser(description="Generate Homebrew formula for longshot")
    _ = parser.add_argument("--version", required=True, help="Release version, e.g. 0.1.0")
    _ = parser.add_argument("--sha256", required=True, help="SHA256 of longshot-{version}.tar.gz")
    _ = parser.add_argument(
        "--repo",
        default="Blastgits/longshot",
        help="GitHub repo slug for release assets",
    )
    _ = parser.add_argument(
        "--output",
        default="packaging/homebrew/longshot.rb",
        help="Output formula path",
    )
    return parser.parse_args(namespace=FormulaArgs())


def render_formula(version: str, sha256: str, repo: str) -> str:
    return f'''class Longshot < Formula
  include Language::Python::Virtualenv

  desc "Massively parallel autonomous coding orchestrator"
  homepage "https://github.com/{repo}"
  url "https://github.com/{repo}/releases/download/v{version}/longshot-{version}.tar.gz"
  sha256 "{sha256}"
  license "MIT"

  depends_on "python@3.12"
  depends_on "node"

  def install
    virtualenv_install_with_resources
  end

  test do
    assert_match "longshot", shell_output("#{{bin}}/longshot --version")
  end
end
'''


def main() -> None:
    args = parse_args()
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _ = output_path.write_text(
        render_formula(args.version, args.sha256, args.repo), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
