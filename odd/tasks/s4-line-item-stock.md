# S/4 line item warehouse stock

Branch: `feat/s4-line-item-stock` (from main f019e0f). Locator: `odd/tasks/s4-line-item-stock.md`.

## Objective

The S/4 line item price webhook (`POST /webhooks/hubspot/line-items/prices/s4`) writes only the price on each
HubSpot line item. Make it also write the per-warehouse stock properties configured in `fieldsWareHouseHS`,
in the same write, the way the Business One flow does.

## Findings (from a read-only map of the code)

- The S/4 use case `SyncS4LineItemPricesByPriceList` already writes through `HubspotLineItemPriceClient.updateLineItems`,
  which spreads `lineItem.warehouseStockProperties` into the batch update. Attaching that field to each enriched line item
  is enough; the client needs no change.
- The S/4 stock pieces exist but are used only by the product sync: `S4StockResolver` (fetches by plant and storage
  location, no Material filter), `S4PlantStorageLocationStrategy` (parses `valueSAP` such as `MQGT/0008` and `TMDO/*`,
  default stock type `01`), `WarehouseStockConfigRepository`.
- The transport is built from the same `sapConfig` as the price client (`createSapTransport`), so a stock call reuses the
  tenant credentials and the default sap-client params.

## Decisions

- The stock call must never break the price: any stock error is logged, recorded in the audit and swallowed.
- HubSpot rejects the WHOLE batch when one property does not exist. Stock properties are filtered against the writable
  line item properties of the portal; missing or invalid names are skipped and reported as a warning in the audit.
- Property names are not changed (the integration does not alter customer data); invalid ones are skipped with a warning.
- Stock is computed only when the tenant strategy is `s4_PlantStorageLocation` and fields are configured. Otherwise nothing
  changes, so tenants without the configuration are unaffected.
- The stock query is filtered by the Material of the deal's line items (one request per plant target, materials in chunks).
  The OData filter on Material is an assumption to verify live against S/4.
- The no-sales-area fallback path does not touch stock.

## Tasks

- [x] T1 `S4StockResolver.fetchStockRows`: optional `materials` argument added to the filter, chunked. Tests first.
- [x] T2 Adapter adds materials to the strategy query targets (strategy file unchanged), new adapter `S4LineItemStockAdapter`
      (`resolveStockProperties({ sapConfig, tenantModels, itemCodes })` returning a Map itemCode to properties; empty map
      when not configured). Tests first.
- [ ] T3 Use case: optional `lineItemStockResolver` and a writable-property filter dependency; one stock call after the price loop,
      assign `warehouseStockProperties`, audit the call and the skipped properties, swallow errors. Tests first.
- [ ] T4 Composition wiring explicit (not a silent default) with a composition test asserting the wiring.
- [ ] T5 Verify: unit suites green; manual run against the real S/4 is done by the user with the VPN.

## Acceptance

- With stock configured and the properties present, the line item batch update carries the price and the stock values.
- With a configured property that does not exist in the portal, the price is still written and the audit lists the skipped property.
- With a stock error, the price is still written and the error is audited.
- With no stock configuration, the behavior is identical to today.

## Progress

Not started.
