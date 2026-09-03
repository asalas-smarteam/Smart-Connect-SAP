import { mapHubspotToSapFields } from '#domain/orders/order-builder.service.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

// SAP B1 ObjectType for the Purchase Quotation (OPQT).
export const PURCHASE_QUOTATION_BASE_TYPE = 540000006;

// Design rule for this document, copied from inventory-transfer-request-builder.service.js
// and deliberately different from order-builder.service.js: every field on the SAP payload
// comes from a FieldMapping under sourceContext=purchase-quotations. Nothing is hardcoded,
// nothing gets a code-side default, and no HubSpot property is read directly. If a tenant did
// not map it, it is not sent — SAP applies its own defaults for anything omitted.
//
// CardCode is NOT the exception it is on the other documents: a Purchase Quotation is a
// PURCHASING document, so its CardCode must be a SUPPLIER. The Business Partner
// resolution/creation path used by createQuotation and inventoryTransferRequest hardcodes
// CardType 'C' (see legacy-whitelist-bp-payload.strategy.js), so reusing it here would either
// be rejected by SAP or create a customer BP for a purchase. Instead the supplier code comes
// from a mapping like any other field, and this flow never touches Business Partners.
//
// SalesPersonCode stays the only exception, same as on the Inventory Transfer Request: it is
// resolved from the OwnerMapping collection and so cannot come from a HubSpot property.

// Each line is exactly the mapped output, plus the minimum validation SAP requires (ItemCode,
// a positive Quantity). No field is added, substituted, or inherited from the header: a line
// without its own warehouse mapping is sent without one and SAP inherits it from the document,
// and an unmapped price is left to SAP's own price-list resolution for the supplier.
export function mapPurchaseQuotationLines({ lineItems, lineMappings }) {
  const lines = [];

  for (const lineItem of Array.isArray(lineItems) ? lineItems : []) {
    const line = mapHubspotToSapFields(lineItem, lineMappings);

    const itemCode = toNonEmptyString(line.ItemCode);
    if (!itemCode) {
      throw new PermanentWebhookError(
        'ItemCode is required on every DocumentLine of a Purchase Quotation. Map the HubSpot '
        + 'line item property (e.g. hs_sku) to the SAP field ItemCode under objectType=product, '
        + 'sourceContext=purchase-quotations, and make sure it is not empty.'
      );
    }

    const quantity = normalizeNumber(line.Quantity, null);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new PermanentWebhookError(
        `Invalid or missing Quantity for item ${itemCode}. Map the HubSpot line item property `
        + '(e.g. quantity) to the SAP field Quantity under objectType=product, '
        + 'sourceContext=purchase-quotations, with a value greater than zero.'
      );
    }
    line.Quantity = quantity;

    lines.push(line);
  }

  return lines;
}

// The payload header is the spread of whatever the deal mapping produced. CardCode (the
// supplier) is mandatory on OPQT, so its absence fails loudly instead of letting SAP reject the
// document with an opaque error. SalesPersonCode is applied last, as the single exception to
// the mapping-only rule, and only when the OwnerMapping resolved one — otherwise a mapped
// SalesPersonCode is left untouched.
export function buildPurchaseQuotationPayload({
  mappedDealFields = {},
  documentLines,
  slpCode = null,
}) {
  if (!Array.isArray(documentLines) || !documentLines.length) {
    throw new PermanentWebhookError(
      'At least one line_item is required to create SAP Purchase Quotation'
    );
  }

  const payload = { ...mappedDealFields };
  // Guard: a mapping copied from the inventory transfer flow must not inject the stock
  // transfer lines collection into a purchasing document.
  delete payload.StockTransferLines;

  const cardCode = toNonEmptyString(payload.CardCode);

  if (!cardCode) {
    throw new PermanentWebhookError(
      'CardCode (código del proveedor) is required to create a Purchase Quotation. Map the '
      + 'HubSpot deal property that holds the supplier code to the SAP field CardCode under '
      + 'objectType=deal, sourceContext=purchase-quotations, and make sure the property is not '
      + 'empty on the deal. This flow does not create Business Partners: the supplier must '
      + 'already exist in SAP.'
    );
  }

  payload.CardCode = cardCode;
  payload.DocumentLines = documentLines;

  if (Number.isInteger(slpCode)) {
    payload.SalesPersonCode = slpCode;
  }

  return payload;
}
