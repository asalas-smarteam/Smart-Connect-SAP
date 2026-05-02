#!/usr/bin/env python3
"""Generate a Markdown changelog draft from git commit history."""

from __future__ import annotations

import argparse
import datetime as dt
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


SECTION_BY_TYPE = {
    "feat": "Added",
    "feature": "Added",
    "add": "Added",
    "fix": "Fixed",
    "bugfix": "Fixed",
    "perf": "Changed",
    "refactor": "Changed",
    "change": "Changed",
    "docs": "Changed",
    "style": "Changed",
    "test": "Changed",
    "build": "Changed",
    "ci": "Changed",
    "chore": "Changed",
    "revert": "Changed",
    "security": "Security",
    "sec": "Security",
    "remove": "Removed",
    "deprecate": "Deprecated",
}

SECTION_ORDER = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]
CONVENTIONAL_RE = re.compile(
    r"^(?P<type>[a-zA-Z]+)(?:\((?P<scope>[^)]+)\))?(?P<breaking>!)?:\s*(?P<message>.+)$"
)


@dataclass(frozen=True)
class Commit:
    sha: str
    short_sha: str
    date: str
    subject: str
    body: str


def run_git(args: list[str]) -> str:
    try:
        return subprocess.check_output(["git", *args], text=True, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as exc:
        message = exc.stderr.strip() or str(exc)
        raise SystemExit(f"git command failed: {message}") from exc


def parse_commits(raw: str) -> list[Commit]:
    commits: list[Commit] = []
    for record in raw.strip("\x1e\n").split("\x1e"):
        if not record.strip():
            continue
        parts = record.lstrip("\n").split("\x00", 4)
        if len(parts) != 5:
            continue
        commits.append(Commit(*parts))
    return commits


def collect_commits(from_tag: str | None, since: str | None) -> list[Commit]:
    pretty = "%H%x00%h%x00%ad%x00%s%x00%b%x1e"
    args = ["log", "--date=short", f"--pretty=format:{pretty}"]
    if since:
        args.append(f"--since={since}")
    if from_tag:
        args.append(f"{from_tag}..HEAD")
    raw = run_git(args)
    return parse_commits(raw)


def normalize_subject(subject: str) -> tuple[str, str, bool]:
    clean_subject = subject.strip()
    match = CONVENTIONAL_RE.match(clean_subject)
    if not match:
        words = clean_subject.lower().split()
        first_word = words[0] if words else ""
        section = SECTION_BY_TYPE.get(first_word, "Changed")
        return section, clean_subject.rstrip("."), False

    commit_type = match.group("type").lower()
    scope = match.group("scope")
    message = match.group("message").strip().rstrip(".")
    breaking = bool(match.group("breaking"))
    section = SECTION_BY_TYPE.get(commit_type, "Changed")

    if scope and not message.lower().startswith(scope.lower()):
        message = f"{scope}: {message}"

    return section, message, breaking


def has_breaking_footer(body: str) -> bool:
    return "BREAKING CHANGE:" in body or "BREAKING-CHANGE:" in body


def sentence_case(text: str) -> str:
    if not text:
        return text
    return text[0].upper() + text[1:]


def build_markdown(commits: list[Commit], version: str | None, unreleased: bool) -> str:
    heading = "Unreleased" if unreleased else version or dt.date.today().isoformat()
    grouped: dict[str, list[str]] = {section: [] for section in SECTION_ORDER}

    for commit in commits:
        section, message, breaking = normalize_subject(commit.subject)
        if breaking or has_breaking_footer(commit.body):
            message = f"BREAKING: {message}"
        grouped.setdefault(section, []).append(f"- {sentence_case(message)} (`{commit.short_sha}`)")

    lines = ["# Changelog", "", f"## {heading}", ""]
    if not commits:
        lines.extend(["No changes found.", ""])
        return "\n".join(lines)

    for section in SECTION_ORDER:
        entries = grouped.get(section, [])
        if not entries:
            continue
        lines.extend([f"### {section}", ""])
        lines.extend(dedupe(entries))
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def dedupe(entries: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for entry in entries:
        key = re.sub(r"\s+\(`[0-9a-f]+`\)$", "", entry).lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(entry)
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Markdown changelog draft from git history.")
    parser.add_argument("--output", help="File to write. Omit to print to stdout")
    parser.add_argument("--from-tag", help="Only include commits after this tag, e.g. v1.2.3")
    parser.add_argument("--since", help="Only include commits after this date, e.g. 2026-01-01")
    parser.add_argument("--version", help="Version heading to use, e.g. 1.3.0")
    parser.add_argument("--unreleased", action="store_true", help="Use 'Unreleased' as the section heading")
    parser.add_argument("--max-count", type=int, help="Maximum number of commits to include")
    parser.add_argument("--include-merges", action="store_true", help="Include merge commits")
    parser.add_argument("--force", action="store_true", help="Overwrite the output file if it already exists")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    commits = collect_commits(args.from_tag, args.since)
    if not args.include_merges:
        commits = [commit for commit in commits if not commit.subject.lower().startswith("merge ")]
    if args.max_count is not None:
        commits = commits[: args.max_count]
    markdown = build_markdown(commits, args.version, args.unreleased)

    if not args.output:
        sys.stdout.write(markdown)
        return 0

    output = Path(args.output)
    if output.exists() and not args.force:
        raise SystemExit(f"{output} already exists; pass --force to overwrite it")
    output.write_text(markdown, encoding="utf-8")
    print(f"Wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
