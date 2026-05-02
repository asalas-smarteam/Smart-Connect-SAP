---
name: multi-tenant-architecture
description: Design and review multi-tenant SaaS architecture with tenant resolution, master and tenant database separation, isolation, caching, performance, and security patterns. Use when Codex needs to implement or evaluate tenant-aware backend code, tenant provisioning, cross-tenant data safety, or multi-tenant database strategy.
---

# Multi-Tenant Architecture

## Principles

- Data must be isolated per tenant.
- No cross-tenant data leaks.

## Patterns

### Tenant Resolution
- Resolve tenant from:
  - token
  - subdomain
  - request metadata

### Database Strategy
- Master DB:
  - global configs
- Tenant DB:
  - isolated data

### Performance
- Avoid cross-tenant queries.
- Cache tenant config when possible.

### Security
- Validate tenant on every request.
- Never trust client input blindly.
