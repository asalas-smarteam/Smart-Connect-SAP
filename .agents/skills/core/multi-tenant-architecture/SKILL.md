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