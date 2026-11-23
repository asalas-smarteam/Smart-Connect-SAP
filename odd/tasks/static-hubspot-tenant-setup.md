# Static HubSpot tenant setup

Branch: `feat/static-hubspot-tenant-setup` (from main b98246c). Locator: `odd/tasks/static-hubspot-tenant-setup.md`.

## Objective

Let a tenant be connected to HubSpot with a static private-app token instead of the OAuth flow
(`POST /oauth/hubspot/init` + callback). Today the OAuth path is the only place that, besides storing
tokens, links the credentials to a base ClientConfig, replicates the master ClientConfigs into the
tenant and seeds the HubSpot portal. With a static app none of that runs.

## Problem

`/internal/tenant` (step 1) creates the tenant, subscription and collections only. The OAuth init
(`ensureHubspotCredential`, `updateClientHubspotPortal`) and callback (`replicate`, `seed`) do the rest.

## Scope

- One reusable use case `SetupStaticHubspotTenant` with injected collaborators (tenant repository,
  master config replicator, HubSpot seeder, SAP flavor resolver). It reuses the existing classes; it does
  not copy their logic.
- One script `scripts/setup-static-hubspot-tenant.mjs` that wires the real collaborators, reads the token
  from an environment variable (never argv, never printed) and is a dry run unless `--apply` is passed.
- Unit tests for the use case.

Out of scope: changing the OAuth flow, the HubSpot project files, line item properties.

## Constraints

- The token must never be logged, printed, or put in an audit log.
- Idempotent: running twice must not duplicate ClientConfigs or credentials.
- Seed errors must be reported (the OAuth callback swallows them; the script must not).
- Runs inside the `api` container (`docker compose exec`), where the production env is available.

## Tasks

- [x] T1 Use case `src/application/use-cases/SetupStaticHubspotTenant.js` + unit tests (test first). (0a9fc7e)
- [x] T2 Script `scripts/setup-static-hubspot-tenant.mjs` wiring real collaborators, dry run by default. (b50c064)
- [x] T3 Verify: unit tests green; usage documented in the script header. Script dry run against a real Mongo not run (left to the operator).

## Acceptance

- With `--apply`: base ClientConfig and HubspotCredentials exist and are linked both ways; the credential
  holds portalId, the token and a far-future expiresAt and no refresh token; master ClientConfigs for the
  tenant flavor are replicated linked to that credential; the seed ran or its error was reported.
- Without `--apply`: nothing is written and the output says what would happen.
- A second run changes nothing and creates no duplicates.

## Progress

T1 0a9fc7e: use case + 10 unit tests (RED observed: module missing; GREEN 10/10). T2 b50c064: script, `node --check` ok. T3: setupStaticHubspotTenant + hubspotOAuthUseCases + tenantProvisioning = 19/19 passed.

Notes: the script subclasses OAuthTenantRepository to add `findClientByTenantKey` (the base class only has `findClientById`). The replicator returns nothing, so replicated configs are counted via ClientConfig.countDocuments before/after; the zero-replication warning fires only when no config besides the base one exists, so repeat runs do not warn.
