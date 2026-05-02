---
name: api-integration-patterns
description: Build and review resilient external API integrations with retries, idempotency, error handling, rate limiting, pagination, request logging, response logging, and timeouts. Use when Codex needs to implement, debug, or evaluate third-party API communication patterns.
---

# API Integration Patterns

## Principles

- All external API calls must be resilient.
- Never assume availability of external services.
- Always log requests and responses.

## Patterns

### Retries
- Use exponential backoff.
- Avoid infinite retries.

### Idempotency
- Operations must be safe to retry.
- Use idempotency keys when possible.

### Error Handling
- Categorize errors:
  - Network errors
  - API errors
  - Validation errors

### Rate Limiting
- Respect API limits.
- Implement throttling if needed.

### Pagination
- Always handle paginated APIs.
- Use loops with stop conditions.

### Timeouts
- Never leave requests hanging.
- Set explicit timeout per request.
