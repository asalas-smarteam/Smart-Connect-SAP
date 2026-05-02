---
name: create-changelog
description: Create or update project changelog files, especially CHANGELOG.md, from git history, release notes, pull requests, issue lists, or user-provided change summaries. Use when Codex needs to create a new changelog, refresh an existing changelog, draft an Unreleased section, summarize commits into Added/Changed/Fixed/etc. categories, or prepare release notes for a version.
---

# Create Changelog

## Overview

Create clear Markdown changelogs that match the repository's existing release style when one exists. Prefer concise, user-facing entries over raw commit subjects.

## Workflow

1. Inspect existing changelog files first: `CHANGELOG.md`, `changelog.md`, `RELEASE_NOTES.md`, or docs release pages.
2. Determine the source range from the user's request, tags, branch comparison, PR list, or available git history.
3. Collect changes with `git log`, GitHub PR metadata, issue references, or user-provided notes.
4. Group entries by the existing project convention. If none exists, use Keep a Changelog-style sections: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
5. Rewrite commit-level noise into release-note language. Merge duplicates, drop internal-only churn unless it affects users or operators, and keep breaking changes explicit.
6. Edit or create the changelog file. Preserve existing historical sections unless the user asks for a full rewrite.
7. Verify the Markdown renders cleanly and the diff only changes the intended changelog files.

## Git-Based Draft

Use `scripts/generate_changelog.py` for a first draft from local git commits:

```bash
python3 /path/to/create-changelog/scripts/generate_changelog.py --from-tag v1.2.3
```

Useful options:

- `--from-tag v1.2.3` to include commits after a release tag.
- `--since 2026-01-01` to include commits after a date.
- `--version 1.3.0` to title the section with a version.
- `--unreleased` to title the section `Unreleased`.
- `--max-count 50` to limit a draft while reviewing noisy history.
- `--include-merges` to include merge commits when the repository uses meaningful merge messages.
- `--output CHANGELOG.md --force` to write the draft to a file. Without `--output`, the script prints to stdout.

Treat the script output as a draft. Edit entries for clarity and remove entries that do not belong in release notes.

## Writing Rules

- Prefer present-tense, outcome-focused bullets: "Add SAP order sync retry handling" instead of "added retries".
- Mention migration steps, configuration changes, API changes, and breaking behavior directly.
- Keep one change per bullet. Combine small related commits into one entry.
- Include issue or PR numbers only when they help trace a change and match local style.
- Do not fabricate versions, dates, issue numbers, authors, or release status. State assumptions when source data is incomplete.

## File Placement

Default to `CHANGELOG.md` at the repository root. If the repo already keeps release notes elsewhere, update that file instead and keep naming consistent.

## Validation

Run a Markdown formatter only if the repository already uses one. Otherwise, inspect the diff and ensure old changelog history remains intact.
