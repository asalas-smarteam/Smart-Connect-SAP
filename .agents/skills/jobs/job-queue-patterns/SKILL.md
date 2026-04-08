# Job Queue Patterns (BullMQ)

## Principles

- Jobs must be idempotent.
- Jobs must be retryable.
- Jobs must be observable.

## Patterns

### Retries
- Use exponential backoff.
- Configure max attempts.

### Deduplication
- Avoid duplicate jobs.
- Use unique job IDs.

### Failure Handling
- Log all failures.
- Send alerts if needed.

### Job Design
- Keep jobs small and atomic.
- Avoid long blocking jobs.

### Monitoring
- Track job status.
- Use dashboards if possible.