# amc-address-config

Branch: `feat/amc-address-config` (from `main` @ 5fd5978). No push. Engram mirror: `odd/amc-address-config/tasks`.
Alternative kept as a fallback, untouched and local: `feat/amc-bpaddress-fieldmapping` (@ 23edd8a), the same feature built with a collection selector in FieldMapping.
Spec: `docs/superpowers/specs/2026-10-13-amc-address-config-design.md`. The old `2026-10-13-bpaddress-selector-fieldmapping-design.md` (untracked, selector design) stays only as the record of the fallback branch.

## Objective

AMC (SAP B1 Service Layer) needs the BusinessPartner `bo_ShipTo` / `bo_BillTo` address (street, city, state) in HubSpot company and contact properties. One direction only, SAP to HubSpot (confirmed by Alejandro's audio); HubSpot to SAP stays as it is today.

## Why this mechanism

Alejandro's audio describes a `Configurations` entry whose value is an object saying which HubSpot property each address goes to. The repo already has the gate for exactly this: `requireAddress` (`{ required: boolean }`), documented in `configuration_examples.md` as the address sync SAP to HubSpot, today "not implemented" (`ADDRESS_SYNC_NOT_IMPLEMENTED` warning in `SyncSapConfigToHubspot`). Printer has it as `{ "required": false }`, AMC has none. The object shape follows `businessPartnerCreation.addresses.byName` (one key per address name). This is an inference from the audio and the code, not a confirmation from Alejandro; the shape below is a proposal.

## Proposed config shape (to confirm)

Changed on 2026-10-14 after the meeting with Alejandro (T9). The earlier `byName` object shape was removed.

```json
{ "key": "requireAddress", "value": {
  "required": true,
  "addresses": [
    { "AddressType": "bo_ShipTo", "sourceField": "Street", "targetField": "direccion_entrega" },
    { "AddressType": "bo_BillTo", "sourceField": "Street", "targetField": "direccion_fiscal" }
  ] } }
```

- `addresses` is an array of rules and one rule is one HubSpot property. The row of `BPAddresses` is picked by `AddressType` and/or `AddressName`, first match, independent of position; several rules may share the same row (Street and City of the ship-to).
- `sourceField` is the field of that row, `targetField` the HubSpot property. Applies to `company` and `contact` (AMC uses the same property names in both). AMC loads only the street.
- Duplicate `targetField`: the first rule keeps it, the later ones are reported (`DUPLICATE_PROPERTY`) and skipped. A legacy `byName` key is ignored.
- `required: false`, a missing key, an invalid or empty `addresses` or a non-B1 tenant keep today's behavior.

## Authorized scope

- `src/domain/business-partners/address-sync.constants.js` (update), new `address-sync.service.js`, new `bp-addresses-select.service.js` (ported from the fallback branch and re-triggered by the config).
- `src/infrastructure/config/AddressSyncConfigRepository.js` (extend).
- New `src/infrastructure/sap/customers/AddressSyncEnrichmentAdapter.js`, modelled on `PropertiesFlagsEnrichmentAdapter`.
- Wiring in `src/application/use-cases/SyncSapConfigToHubspot.js` and `src/composition/sap-sync.composition.js`; the placeholder warning is replaced.
- T6 only after the decision: the dropdown task (`dropdown-options.service.js` and the target resolution).
- `configuration_examples.md`, the spec, tests under `tests/unit/`.
- No change to `FieldMapping`, the shared resolver or any HubSpot to SAP code. No push. No Mongo writes (the user writes Mongo).

## Constraints

- A tenant without a valid `requireAddress.addresses` must not change behavior (resolution, `$select`, writes).
- `requireAddress: { required: false }` (what Printer has) must keep working exactly as today.
- Nothing is written into HubSpot for a missing address: values that are `null` are dropped by `sanitizeProperties` before every batch write.
- Planning heuristic: about 400 authored changed lines per task; forward the same advisory to any delegate.

## Tasks (each test first; RED observed, or the exception recorded)

- [x] T1 Normalizer (pure, domain) and `AddressSyncConfigRepository`: returns `{ required, byName }`; keys lowercased; entries without `AddressType`/`AddressName` or without valid `fields` dropped; never throws; non-B1 degrades like `propertiesFlags`. Route: inline (a near copy of the `PropertiesFlags` normalizer pattern, already read). RED then GREEN observed 2026-10-13.
- [x] T2 Projection (pure, domain): `readSapAddressesToProperties({ sapRecord, config })` returns the properties to write, or `null` when the feature is off. Route: inline (one pure function in the module T1 created, modelled on `readSapPropertiesFlags`). RED then GREEN observed 2026-10-13.
- [x] T3 `$select`: `withBpAddressesSelectField` triggered by the config (company and contact only), port of the fallback branch module and tests, including the URL-level tests and the sourceContext drift guard. Route: inline (a port of a module and tests already written and reviewed on the fallback branch, with the trigger changed). The wiring into `SyncSapConfigToHubspot` moved to T4, which reads the config once for this step and for the enricher.
- [x] T4 Enricher + wiring + use case: `AddressSyncEnrichmentAdapter` (B1 only, company/contact, silent failure), composition entry, port compliance, `required: true` without a valid `byName` gives a warning instead of the old "not implemented" one. Route: inline (a near copy of `PropertiesFlagsEnrichmentAdapter` and its wiring, already read in full). RED then GREEN observed 2026-10-13.
- [x] T5 End to end for company and contact (real `mapRecords` + enricher + `sanitizeProperties`), plus the existing-record path: addresses reach an existing record only when the properties are in `hubspotUpdateFields`. Route: inline; tests only, no production change (it assembles pieces already built and tested one by one). Characterization, so no RED: a mutation check instead.
- [ ] T6 Dropdown pairing. DECISION PENDING with Alejandro: today `DROPDOWN_OPTIONS` finds target properties through FieldMapping rows, and this design has none. Options: (a) the task also reads `requireAddress`; (b) `dropdownOptionsSync` sources declare explicit targets (my pick, an optional field). Not started until decided.
- [x] T7 (passive docs and one comment, route inline, structural readback instead of tests) Docs: rewrite the `requireAddress` section of `configuration_examples.md` (it says "always false, not implemented"), update the comments of `address-sync.constants.js`, rewrite the spec for this design.
- [ ] T8 Manual, outside the code (the user): recreate `pais`, `departamento_entrega`, `departamento_fiscal` as dropdowns in companies and contacts (they are `string` today and the dropdown task skips non-`enumeration` properties); write the `requireAddress` document, the dropdown sources and `hubspotUpdateFields` in Mongo; deploy first; the HubSpot workflow script last.

- [x] T9 New config shape after the 2026-10-14 meeting with Alejandro (decided with the user the same day). `requireAddress.byName` (object keyed by name, with `fields`) becomes `requireAddress.addresses`, an ARRAY of rules `{ AddressType?, AddressName?, sourceField, targetField }`: one rule per HubSpot property, the row of `BPAddresses` still picked by type and/or name (first match, never by position), `sourceField` is the field of that row, `targetField` the HubSpot property. AMC loads only the street: `direccion_entrega` and `direccion_fiscal` (City and State are dropped from the AMC config, but the code still accepts any scalar `sourceField`). No `entrega`/`fiscal` names. The old object shape and the `byName` key are removed (nothing is deployed). Route: delegated writer (reshapes the normalizer, the projection, the repository contract and about seven test files plus docs; trigger evidence: 2+ non-trivial files and the reading that prepares the write). Test first: the tests of each piece are rewritten to the new shape and observed RED before the code changes.

## Acceptance criteria

- With the proposed config, a company or contact synced from SAP gets the six properties from the row of the right type, in any row order; `State` arrives as the SAP code.
- A BP without one of the addresses leaves those properties out of the write.
- A tenant with `required: false`, no key, or an invalid object behaves as today (tests prove it).
- No file under the shared resolver or the HubSpot to SAP builders changes.

## Checks

Runner: `npm test` (`NODE_OPTIONS=--experimental-vm-modules jest`). Baseline on `main` and on the fallback branch: 10 failing tests in 5 suites (`lineItemPriceWebhook.service`, `sendMappedItemsToHubspot`, `serviceLayerFlow`, `serviceLayerService`, `internalTenant`), pre-existing; any change in that number is a regression. Test-first policy applies; characterization tests (no code to write) record the exception and get a mutation check.

## Route declaration

Default inline: each task is a near copy of the `PropertiesFlags` precedent (`sap-properties-flags.service.js`, `PropertiesFlagsEnrichmentAdapter.js`, `BusinessPartnerCreationConfigRepository.js`), already read in full, with no open design decision except T6. Recorded again per task with its evidence; if a task grows past that, delegate one bounded writer.

## Delivery

Forecast: about 250 source lines, 450 test lines, 60 docs lines, so about 760 authored lines, over the ~400 heuristic. Two slices: slice 1 = T1 to T3 (about 400), slice 2 = T4 to T7. Strategy `ask-on-risk`; the PR chain strategy (`stacked-to-main` or `feature-branch-chain`) is chosen when the user decides to push, since nothing is pushed or opened now. Review per slice through the native flow (the user is asked for consent each time).

## Reuse from the fallback branch (copy, do not merge)

`bp-addresses-select.service.js` and its tests, the drift guard test, the journey test shape, `odd/tasks/amc-bpaddress-fieldmapping.md` findings (HubSpot property check, `hubspotUpdateFields`, contacts config inactive), `git show feat/amc-bpaddress-fieldmapping:<path>`.

## Findings that still apply (verified 2026-10-13)

- AMC HubSpot (portal `49373530`): the six property names exist on companies and contacts; `pais`, `departamento_*` are `string`; companies also have a lookalike enum `direccion_de_entrega`.
- AMC has no `hubspotUpdateFields`: without it, addresses reach only newly created records; Printer uses it for phone, currency and others.
- AMC company sync is `mode: FULL`, so a listed property is overwritten on every run; the contact sync is `active: false`.
- Header `Address`/`MailAddress` hold the street; `State` exists only in `BPAddresses`.

## Progress

- 2026-10-13: branch created from `main`; this plan written. No source written.
- 2026-10-13: plan approved by the user. T1 done.

## Verification evidence

- T1 RED: `tests/unit/domain/addressSyncConfig.test.js` failed on the missing `address-sync.service.js`; `addressSyncConfigRepository.test.js` failed 10 of 13 (the 3 that passed already matched the extended contract: no log for a valid config, no `sapFlavor` document means B1, config read through `tenantContext`).
- T1 GREEN: domain test and repository test plus the neighbors that read `requireAddress` (`syncSapConfigToHubspot`, `syncSapConfigSelectInjection`): 4 suites, 50/50. Full suite: 2295 passed, 10 failed in the same 5 pre-existing suites as `main`.
- What T1 added: `src/domain/business-partners/address-sync.service.js` (`normalizeAddressSyncConfig`, `isAddressSyncEnabled`), two constants in `address-sync.constants.js` (`BP_ADDRESS_TYPES`, `ADDRESS_SYNC_ISSUE_CODES`), and `getAddressSyncConfig` now returns `{ required, byName }`. The old four repository tests keep their intent; only their expected value gained `byName: {}`. The one consumer (`SyncSapConfigToHubspot`) destructures only `required`, so it is unaffected.
- Beyond the plan, on purpose: `normalizeAddressSyncConfig` reports what it drops in `issues` (`INVALID_ENTRY`, `NO_MATCH_CRITERIA`, `NO_VALID_FIELDS`, `DUPLICATE_PROPERTY`) and the repository logs them once. A property claimed by two entries stays with the first, because otherwise the two would overwrite each other without any error.
- Behavior that did NOT change: `{ required: false }` (Printer today), a missing key, a non-object value and a read error all still give "off".

- Commit T1: `0dbad45` `feat(config): read the requireAddress byName object for the address sync`. Not pushed.
- Review of the slice `main..0dbad45` (6 files, 570 lines, mostly tests and this plan): assess `review_due: true` (`slice_budget_reached`), consent granted by the user, medium risk, lens `review-reliability`, approved and acknowledged (lineage `review-f051ea778c7e5280`, authority burned). The reviewed boundary is now `0dbad45`. Two non-blocking findings, both real, kept as follow-ups and not a reason to re-review this candidate:
  - `R3-byname-key-collision` (WARNING): two raw `byName` keys that normalize to the same name (`Entrega` next to `entrega`, or with spaces) overwrite each other in `byName[entry]` with no issue recorded, and the first entry's properties stay claimed, so that address silently disappears from the sync. It contradicts the module's promise that whatever is dropped is listed in `issues`. No test covers it.
  - `R3-s4-required-flip` (SUGGESTION): on a non-B1 tenant with `required: true` and a non-empty `byName` the repository returns `required: false`, while with an empty `byName` it keeps `required: true`; the same tenant used to get `required: true` and the old warning. Suggested: keep `required` and clear only `byName`, so a non-B1 tenant that asked for the feature still gets a warning from the consumer, and pin that outcome in a test.

- The two T1 findings were fixed (accepted by the user, test first, inline), commit `55fa3d1` `fix(config): report a repeated address name and keep required on non-B1 tenants`. RED: 4 of 42 failed (2 per finding; the tests that passed already pinned correct behavior). Fixes: a second `byName` key that normalizes to an accepted name is reported as `DUPLICATE_ENTRY` and skipped before it can claim any property; on a non-B1 tenant only `byName` is cleared and `required` stays as written, so the consumer still warns (and a non-B1 tenant gives the same answer with or without `byName`). GREEN 58/58 with the neighbors.
- T2 RED: `tests/unit/domain/addressSyncProjection.test.js` failed because `readSapAddressesToProperties` was not exported. GREEN: 70/70 with the T1 tests. Full suite after T2: 2328 passed, 10 failed in the same 5 pre-existing suites.
- T2 design decisions, recorded: `null` means the feature is off and `{}` means it is on with nothing to write; the row is picked by `AddressType` and/or `AddressName` (both when both are set), never by position, first match wins; only properties that got a value are returned, so a value SAP leaves empty (`null`, `''`, blanks) or a non-scalar never reaches HubSpot blank; numbers and booleans are kept, strings exactly as SAP has them.

- T3 RED: both test files failed on the missing `bp-addresses-select.service.js` (0 tests ran). GREEN: `bpAddressesSelectField.test.js` and `bpAddressesSelectContextDrift.test.js`, 27/27. Full suite after T3: 2355 passed, 10 failed in the same 5 pre-existing suites.
- T3 changes against the fallback module, recorded: the signature is `withBpAddressesSelectField(mappings, addressConfig, { objectType })`, like `withPropertiesFlagsSelectFields`; the trigger is `isAddressSyncEnabled(addressConfig)` instead of "an active mapping uses a `BPAddresses[` selector"; the selector prefix and the `sourceContext` option are gone (the synthetic always carries `businessPartner`); the "already selected" rule (`survivesTheSelect`: active, asks for the select, context not excluded) and the sourceContext drift guard are kept as they were.
- Honest note on the evidence: these tests are ports of ones whose mutation checks were done on the fallback branch, and this branch's RED was the missing module. No new mutation run was made here. They are not vacuous by construction: each assertion reads the final `$select` of `buildServiceLayerUrl` and fails on an empty list.

- Commits: the two T1 fixes `55fa3d1`, T2 `deb44ca`, T3 `6dfbce5`. Not pushed.
- Review of the slice `0dbad45..6dfbce5` (fixes, T2 and T3; 10 files, 666 lines): assess `review_due: true` (`slice_budget_reached`), consent granted by the user, medium risk, lens `review-reliability`, approved and acknowledged (lineage `review-fcaee895c4df092a`, authority burned). The reviewed boundary is now `6dfbce5`. One non-blocking SUGGESTION kept as a follow-up:
  - `R3-match-all-unnormalized-entry`: `rowMatchesEntry` returns true for an entry that sets neither `addressType` nor `addressName`. The normalizer drops such entries, but `readSapAddressesToProperties` is exported and only guards with `isAddressSyncEnabled`, which accepts any `{ required: true, byName: {non-empty object} }`. A caller that passes a raw, un-normalized config would have every entry match the first object row, and fields of the wrong address would reach HubSpot with no error; it would pick by position, the one thing the function promises not to do. Suggested: return false when the entry has no criteria, plus a test that passes a raw `byName`. Related gap to close in the same change: with a raw entry `fields` can be missing and `Object.entries(undefined)` would throw.

- `R3-match-all-unnormalized-entry` fixed (accepted by the user, test first, inline), commit `a6787eb` `fix(config): never pick an address by position when a config was not normalized`. RED: 7 new tests failed (an entry with no criteria matched the first row; an entry with no `fields` or that is not an object threw); the 28 that existed kept passing. Fix in `readSapAddressesToProperties`: an entry with neither `addressType` nor `addressName` matches nothing, and an entry that is not an object or has no `fields` is skipped. GREEN 95/95 with the neighbors; with a normalized config the output is identical.
- T4 RED: `addressSyncEnrichmentAdapter.test.js` failed on the missing adapter; of `syncSapConfigAddressSync.test.js` and `sapSyncComposition.test.js` 9 tests failed (18 already passed: they pin what must not change). GREEN: those plus `syncSapConfigToHubspot`, `syncSapConfigSelectInjection` and the repository test, 6 suites, 78/78. Full suite after T4: 2405 passed, 10 failed in the same 5 pre-existing suites.
- What T4 added: `src/infrastructure/sap/customers/AddressSyncEnrichmentAdapter.js` (writes the projected properties into `record.properties` after the mapped ones, so the SAP address wins over a mapping on the same property; company and contact only; reads the config once per run; never throws, logs and leaves the records alone); in `SyncSapConfigToHubspot` a new optional `addressSyncEnricher`, a `readAddressSyncConfig` read once per run that feeds both the `$select` (`withBpAddressesSelectField`) and the warning, and the enricher call after `propertiesFlagsEnricher` and before the send; in `sap-sync.composition.js` one shared `AddressSyncConfigRepository` and the `addressSyncEnricher` entry (with its assertion in `sapSyncComposition.test.js`, which now fails if the wiring is deleted).
- Beyond the plan, on purpose: (1) `readAddressSyncConfig` catches a failed read and treats it as the feature being off, because a sync that dies on an unreadable config is worse than a sync without addresses; (2) the old placeholder had no test at all, the new warning and the whole flow are covered; (3) `ADDRESS_SYNC_NOT_IMPLEMENTED` was removed, with its re-export in the repository, after checking that nothing else used it, and `ADDRESS_SYNC_MISCONFIGURED` replaces it; the header comment of `address-sync.constants.js` still describes the old behavior and is rewritten in T7.
- Behavior that did NOT change: a tenant with no `requireAddress`, `{ required: false }` (Printer today) or an invalid value gets the same request, the same writes and no warning; product and deal syncs never read the config.

- Commits: the finding fix `a6787eb` and T4 `5584777`. Not pushed.
- Review of the slice `6dfbce5..5584777` (hardening of the projection and T4; 11 files, 713 lines): assess `review_due: true` (`slice_budget_reached`), consent granted by the user, medium risk, lens `review-reliability`, approved and acknowledged (lineage `review-ca81fe86fc9dba05`, authority burned). The reviewed boundary is now `5584777`. One non-blocking SUGGESTION kept as a follow-up, a test gap and not a code defect:
  - `R3-unasserted-config-read-failure-log`: the use-case test for an unreadable config checks that the sync completes and that `BPAddresses` is not selected, but never that `logger.error` was called. If the log were dropped, address sync would be silently off for a tenant and no test would fail. Suggested one assertion, `expect(harness.logger.error).toHaveBeenCalledTimes(1)`, in the `repositoryError` test of `syncSapConfigAddressSync.test.js`. To be folded into the next commit.
- The review also noted what it could not verify from the patch: that nothing outside the candidate used `ADDRESS_SYNC_NOT_IMPLEMENTED`. It was checked with `rg` over `src` and `tests` before removal (only the definition, the repository re-export and a string literal in a new test).

- T5: `tests/unit/infrastructure/addressSyncJourney.test.js`, 36 tests (18 per object type for company and contact). It wires the real `AddressSyncConfigRepository`, `MappingSyncRepository.mapRecords`, `AddressSyncEnrichmentAdapter`, `withBpAddressesSelectField`, `buildServiceLayerUrl`, `sanitizeProperties` and the `buildBatchUpdateEntry` of the company and contact handlers, and fakes only Mongo and SAP. There is no FieldMapping row for the six properties: the config is the only thing that knows them. Synthetic data only.
- T5 covers: `BPAddresses` requested exactly once next to the base fields; the six properties from the row of the right type whatever the row order; `State` kept as the SAP code; city `null` in SAP (the AMC shape) left out; a BP with only a ship-to or with no addresses sends none of the missing ones; tenants that did not ask for it (no key, Printer's `{ required: false }`, `required: true` with nothing to write, a non-B1 tenant) keep sending only the base properties.
- T5 existing-record path, the finding in test form: with no `hubspotUpdateFields` an update that does happen carries only `idsap` and never an address; an address change alone does not even trigger the update; with the six listed they reach the record, an address that already matches is not sent again, only the properties listed are overwritten, and an empty SAP value never blanks what an advisor typed by hand.
- T5 found something: `COMPANY_ADD_FIELDS_URL_SAP=ContactEmployees,BPAddresses` is in `.env` and `.env.example`, so in a deployment with that variable the company `$select` already carries `BPAddresses` for every tenant. The first version of the journey test pinned the exact `$select` list, failed for company because of it, and was a test assumption, not a production bug; it now only requires `BPAddresses` once next to the base fields. Consequence: the injection of T3 matters mostly for contact (the variable has no `contact` entry) and for deployments without that variable; for company it is redundant and harmless, because `buildServiceLayerUrl` merges the select fields through a `Set` (checked with the variable set, empty and set to `BPAddresses` only).
- T5 mutation check (the tests were written after the code, so they had to be shown able to fail): with the enricher's `Object.assign` disabled and the unreadable-config log removed from the use case, 17 of 54 tests fail; restored with `git checkout` of those two files (empty diff in `src`), 54/54 pass again. This also closes the review suggestion `R3-unasserted-config-read-failure-log`: `syncSapConfigAddressSync.test.js` now asserts that `logger.error` is called once with the reason.
- Full suite after T5: 2439 passed, 10 failed in the same 5 pre-existing suites.

- T7: `configuration_examples.md` (section `requireAddress` rewritten with the real shape, `hubspotUpdateFields`, the `.env` finding), header comment of `address-sync.constants.js` rewritten in English, new spec `2026-10-13-amc-address-config-design.md`. Readback: `rg ADDRESS_SYNC_NOT_IMPLEMENTED` only remains in a test that asserts it is gone and in the August specs/plans, which are history.

- T9 RED (tests rewritten to the new shape first): the 9 address-sync suites ran 208 tests, 119 failed and 89 passed (the passing ones pin behavior that does not depend on the shape; 8 suites failed, `sapSyncComposition` passed). T9 GREEN: same 9 suites 208/208. Full suite: 2459 passed, 10 failed, exactly the 5 pre-existing suites (`lineItemPriceWebhook.service`, `sendMappedItemsToHubspot`, `serviceLayerFlow`, `serviceLayerService`, `internalTenant`).
- T9 what changed: `normalizeAddressSyncConfig` returns `{ required, addresses, issues }` with rules `{ addressType, addressName, sourceField, targetField }` and issues `{ entry: <index>, code }`; `DUPLICATE_ENTRY` was removed and `NO_VALID_FIELDS` became `INVALID_FIELD` (bad `sourceField` or `targetField`); `isAddressSyncEnabled` checks a non-empty array; `readSapAddressesToProperties` loops over the rules (a rule with no criteria still matches nothing, one with no `sourceField`/`targetField` is skipped); the repository, `withBpAddressesSelectField`, the enricher and the use case follow (`byName` renamed to `addresses`, comments and the warning text included). New tests: rules sharing one row, duplicate `targetField` (also case-insensitive), no criteria, invalid `sourceField`/`targetField`, a legacy `byName` document ignored (domain, repository, journey), the AMC street-only shape (projection, enricher, journey). `businessPartnerCreation.addresses.byName` and its files were not touched.
- T9 mutation check: with the enricher's `Object.assign` replaced by a no-op, `addressSyncEnrichmentAdapter` + `addressSyncJourney` failed 26 of 62; restored by hand, the 9 suites pass 208/208 again.
- T9 docs: `requireAddress` section and example of `configuration_examples.md` and the spec rewritten (shape, pieces, tests; the open questions about the `byName` name and street-only were dropped, T6 and `hubspotUpdateFields` stay). Size: well over the ~400-line heuristic because the config shape change touches every piece and every test file of the feature; no size-only rework.

## Next step

T6 stays blocked on Alejandro's decision (how the dropdown task finds its target properties). Meanwhile T7: rewrite the `requireAddress` section of `configuration_examples.md`, the header comment of `address-sync.constants.js` and the spec, which still describe the selector design and the old "not implemented" behavior. Old note: T5 end to end for company and contact, with the real `mapRecords`, the real enricher and `sanitizeProperties`, plus the existing-record path (`buildUpdatePayload` with and without `hubspotUpdateFields`), failing tests first. Failing tests first for `AddressSyncEnrichmentAdapter` (company and contact only, B1 only, silent failure, writes into `record.properties`), the composition entry and the use case (config read once, `$select` injection, the placeholder warning replaced by a warning for "required but nothing valid to write"), RED, then implement.
