# bp-lookup-consumer-final-nit

Branch: fix/bp-lookup-consumer-final-nit (from origin/main 8a84573). Worktree: ~/smartprojects/Smart-Connect-SAP-worktrees/printer-cf-nit-cui

## Objective
For tenants that opt in, when the business partner tax id resolved for a deal is the consumer-final placeholder ("C.F.", any case/dots/dashes), look up and create the SAP B1 business partner using the person's national id (HubSpot deal property `cui`) in `FederalTaxID` instead.

## Problem
`SapWebhookOrderAdapter.findOrCreateBusinessPartner` searches `FederalTaxID eq <nit>` with `$top: 1`. "00000000C.F." is shared by many BPs in SAP (some frozen), so an arbitrary, sometimes blocked BP is returned and the deal attaches to the wrong customer. The BP has no CUI/DPI user field (verified read-only in SAP), so `FederalTaxID` is the only place. Approved by the tenant's integrator (2026-11-26). A previous attempt on the client side failed with a format error: if SAP rejects the 13-digit value, report it, do not work around it.

## Scope / constraints
- Opt-in per tenant via a Configuration key; no key = behavior unchanged for every other tenant.
- Integration is transport: no silent data trimming; fail with a clear error.
- Only when CUI is present; if the NIT is C.F. and no CUI, keep current behavior.
- Tests first (RED), conventional commits, no AI attribution, no tenant names in code comments/commit text.

## Tasks
- [x] T1 Explore how the deal `cui` can reach findOrCreateBusinessPartner (webhookQuotationSupport / resolveBusinessPartnerForDocument) and design the minimal opt-in config.
- [x] T2 Unit tests (RED) for: C.F. detection/normalization, lookup by CUI, creation with CUI in FederalTaxID, no-op when config absent or CUI missing.
- [x] T3 Implementation (GREEN) + full unit suite (baseline: 4 time-dependent suites already fail on main).
- [ ] T4 Commit(s) on the branch; PR against main (user authorizes push/PR).

## Route
Delegated direct: one writer (2+ non-trivial files + exploration). Evidence: mapping needs >5 lookups.

## Progress
Created 2026-11-26 16:02 local.

- T1: deal reaches resolveBusinessPartnerForDocument via the event `payload` it already receives (`resolveEventPayload({ payload }).deal`); no resolver signature change. Config key `consumerFinalNit` = `{ "enabled": true, "identityProperty": "cui" }` read by `TenantWebhookRuntimeRepository.resolveConsumerFinalNitConfig`; support passes `consumerFinalIdentity` to `findOrCreateBusinessPartner` (default null, other callers unaffected).
- T2 RED: 4 suites / 10 tests failed for missing behavior (consumerFinalIdentity ignored, resolveConsumerFinalNitConfig undefined).
- T3 GREEN: 4 suites, 95 tests pass. Full `npm test`: 293 suites pass, 4 fail (internalTenant, sendMappedItemsToHubspot, lineItemPriceWebhook.service, serviceLayerService; 9 tests), identical on base via git stash.
- Note: worktree had no node_modules; symlinked from the main checkout for test runs (untracked, not committed).
