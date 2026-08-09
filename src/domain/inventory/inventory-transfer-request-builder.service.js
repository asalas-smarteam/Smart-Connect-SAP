import { mapHubspotToSapFields } from '#domain/orders/order-builder.service.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

// SAP B1 ObjectType for the Inventory Transfer Request (OWTQ).
export const INVENTORY_TRANSFER_REQUEST_BASE_TYPE = 1250000001;

// Design rule for this document, deliberately different from order-builder.service.js:
// every field on the SAP payload comes from a FieldMapping. Nothing is hardcoded, nothing
// gets a code-side default, and no HubSpot property is read directly. If a tenant did not
// map it, it is not sent — SAP applies its own defaults for anything omitted.
//
// The only two exceptions are CardCode (resolved by the Business Partner lookup/creation)
// and SalesPersonCode (resolved from the OwnerMapping collection): neither comes from a
// HubSpot property, so neither can go through FieldMapping.

// Each line is exactly the mapped output, plus the minimum validation SAP requires
// (ItemCode, a positive Quantity). No field is added, substituted, or inherited from the
// header: a line without its own warehouse mapping is sent without one, and SAP inherits
// FromWarehouse/ToWarehouse from the document header — which is the correct B1 behaviour.
export function mapStockTransferLines({ lineItems, lineMappings }) {
  const lines = [];

  for (const lineItem of Array.isArray(lineItems) ? lineItems : []) {
    const line = mapHubspotToSapFields(lineItem, lineMappings);

    const itemCode = toNonEmptyString(line.ItemCode);
    if (!itemCode) {
      throw new PermanentWebhookError(
        'ItemCode is required on every StockTransferLine. Map the HubSpot line item property '
        + '(e.g. hs_sku) to the SAP field ItemCode under objectType=product, '
        + 'sourceContext=inventory-transfer-request, and make sure it is not empty.'
      );
    }

    const quantity = normalizeNumber(line.Quantity, null);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new PermanentWebhookError(
        `Invalid or missing Quantity for item ${itemCode}. Map the HubSpot line item property `
        + '(e.g. quantity) to the SAP field Quantity under objectType=product, '
        + 'sourceContext=inventory-transfer-request, with a value greater than zero.'
      );
    }
    line.Quantity = quantity;

    lines.push(line);
  }

  return lines;
}

// The payload header is the spread of whatever the deal mapping produced. FromWarehouse and
// ToWarehouse are mandatory on OWTQ, so their absence fails loudly instead of letting SAP
// reject the document with an opaque error. CardCode/SalesPersonCode are applied last, as the
// two exceptions to the mapping-only rule, and only when resolved.
export function buildInventoryTransferRequestPayload({
  mappedDealFields = {},
  stockTransferLines,
  cardCode = null,
  slpCode = null,
}) {
  if (!Array.isArray(stockTransferLines) || !stockTransferLines.length) {
    throw new PermanentWebhookError(
      'At least one line_item is required to create SAP Inventory Transfer Request'
    );
  }

  const payload = { ...mappedDealFields };
  // Guard: a mapping copied from the orders/quotations flow must not inject the sales
  // document lines collection into an inventory document.
  delete payload.DocumentLines;

  const fromWarehouse = toNonEmptyString(payload.FromWarehouse);
  const toWarehouse = toNonEmptyString(payload.ToWarehouse);

  if (!fromWarehouse) {
    throw new PermanentWebhookError(
      'FromWarehouse (almacén origen) is required to create an Inventory Transfer Request. '
      + 'Map the HubSpot deal property (e.g. filler) to the SAP field FromWarehouse under '
      + 'objectType=deal, sourceContext=inventory-transfer-request, and make sure the property '
      + 'is not empty on the deal.'
    );
  }

  if (!toWarehouse) {
    throw new PermanentWebhookError(
      'ToWarehouse (almacén destino) is required to create an Inventory Transfer Request. '
      + 'Map the HubSpot deal property (e.g. towhscode) to the SAP field ToWarehouse under '
      + 'objectType=deal, sourceContext=inventory-transfer-request, and make sure the property '
      + 'is not empty on the deal.'
    );
  }

  if (fromWarehouse === toWarehouse) {
    throw new PermanentWebhookError(
      `Source and destination warehouse are the same (${fromWarehouse}) for this Inventory `
      + 'Transfer Request.'
    );
  }

  payload.FromWarehouse = fromWarehouse;
  payload.ToWarehouse = toWarehouse;
  payload.StockTransferLines = stockTransferLines;

  const resolvedCardCode = toNonEmptyString(cardCode);
  if (resolvedCardCode) {
    payload.CardCode = resolvedCardCode;
  }

  if (Number.isInteger(slpCode)) {
    payload.SalesPersonCode = slpCode;
  }

  return payload;
}
