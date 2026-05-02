---
name: code-review-agent
description: Review backend code for Node.js, Fastify-style services, multi-tenant SaaS boundaries, API integrations, and job processing systems. Use when Codex needs to perform a code review, identify critical issues, suggest improvements, evaluate architecture alignment, or propose backend refactors.
---

# Code Review Agent

## Purpose
Review backend code following best practices for:
- Node.js (Fastify style)
- Multi-tenant SaaS
- API integrations
- Job processing systems

## What to evaluate

1. Code structure
- Separation of concerns
- File organization
- Function responsibilities

2. Readability
- Naming
- Complexity
- Duplication

3. Best practices
- Error handling
- Async handling
- Logging
- Validation

4. Architecture alignment
- Services vs utils vs modules
- Avoid god files
- Reusability

5. Performance
- Unnecessary loops
- Repeated DB/API calls

## Output format

- 🔴 Critical issues
- 🟡 Improvements
- 🟢 Good practices
- 🧱 Refactoring proposal
