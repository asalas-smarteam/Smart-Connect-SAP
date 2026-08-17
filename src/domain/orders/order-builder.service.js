import { calculateUnitPriceWithMisc } from '#domain/prices/misc-price-calculation.service.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { pickByPath } from '#shared/utils/object-path.utils.js';
import { normalizeInteger, normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

export function mapHubspotToSapFields(source, mappings) {
  const mapped = {};

  for (const mapping of Array.isArray(mappings) ? mappings : []) {
    if (mapping?.isActive === false) {
      continue;
    }

    const sourceField = String(mapping?.sourceField || '').trim();
    const targetField = String(mapping?.targetField || '').trim();
    if (!sourceField || !targetField) {
      continue;
    }

    const value = pickByPath(source, targetField);
    if (value !== null && typeof value !== 'undefined' && value !== '') {
      mapped[sourceField] = value;
    }
  }

  return mapped;
}

// Header fields owned by the builders (or with dedicated coercion, like PaymentGroupCode)
// are excluded from the generic deal-mapping spread so mapped raw values cannot clobber them.
const RESERVED_HEADER_FIELDS = new Set(['CardCode', 'DocDueDate', 'DocumentLines', 'PaymentGroupCode']);

// SAP expects DocumentSpecialLines as a collection of line objects, but a FieldMapping can only
// copy a scalar HubSpot property: `texto_gobierno` arrives as plain text. Service Layer does not
// reject the malformed value — it drops the collection and stores [], so the text is lost with
// no error anywhere. The string is reshaped here into the collection SAP actually expects.
//
// The whole text becomes a single line on purpose. Its newlines mix soft wraps ("Capacidad de \n
// hojas en bandeja") with real separators ("O.C: 111931\nCódigo Artículo: 36351"), so splitting
// on them would cut sentences in half.
export function normalizeDocumentSpecialLines(value) {
  if (Array.isArray(value)) {
    return value.length ? value : null;
  }

  const lineText = toNonEmptyString(value);

  return lineText ? [{ LineNum: 0, LineText: lineText }] : null;
}

function pickMappedHeaderFields(mappedDealFields) {
  const fields = {};

  for (const [field, value] of Object.entries(mappedDealFields || {})) {
    if (RESERVED_HEADER_FIELDS.has(field)) {
      continue;
    }

    if (field === 'DocumentSpecialLines') {
      const specialLines = normalizeDocumentSpecialLines(value);
      if (specialLines) {
        fields[field] = specialLines;
      }
      continue;
    }

    fields[field] = value;
  }

  return fields;
}

// Line fields owned by mapDocumentLines (or resolved through dedicated coercion, like TaxCode
// by rate or UnitPrice by misc calculation) are excluded from the generic line-mapping spread
// so mapped raw values cannot clobber them.
const RESERVED_LINE_FIELDS = new Set([
  'ItemCode',
  'Quantity',
  'UnitPrice',
  'WarehouseCode',
  'DiscountPercent',
  'TaxCode',
  'LineNum',
  'BaseType',
  'BaseEntry',
  'BaseLine',
]);

function pickMappedLineFields(mappedLineFields) {
  const fields = {};

  for (const [field, value] of Object.entries(mappedLineFields || {})) {
    if (!RESERVED_LINE_FIELDS.has(field)) {
      fields[field] = value;
    }
  }

  return fields;
}

// SAP wants a plain YYYY-MM-DD. HubSpot date properties reach us either already formatted
// (optionally with a time component) or as epoch millis, depending on how the workflow
// serializes them, so both shapes are normalized here. Anything else yields null.
function normalizeSapDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }

  const raw = toNonEmptyString(value);
  if (!raw) {
    return null;
  }

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/.exec(raw);
  if (isoMatch) {
    const [, year, month, day] = isoMatch.map(Number);
    // Rejects things like 2026-13-45 that match the shape but are not real dates.
    const parsed = new Date(Date.UTC(year, month - 1, day));
    const isRealDate = parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;

    return isRealDate ? parsed.toISOString().slice(0, 10) : null;
  }

  // Epoch millis (HubSpot stores date properties as midnight UTC). Seconds-precision
  // values are not accepted: they would silently resolve to 1970.
  if (/^\d{12,}$/.test(raw)) {
    const parsed = new Date(Number(raw));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }

  return null;
}

// Precedence: mapped HubSpot value (FieldMapping DocDueDate -> docduedate) → today.
// DocDueDate is mandatory in SAP, so an absent or unusable value degrades to today
// rather than failing the document.
export function resolveDocDueDate({ mappedDeal = null, now = new Date() } = {}) {
  return normalizeSapDate(mappedDeal?.DocDueDate) ?? now.toISOString().slice(0, 10);
}

// Precedence: mapped HubSpot value → tenant config default (groupCodeDefauls) → null (omit).
export function resolvePaymentGroupCode({ mappedDeal, groupCodeDefaults }) {
  const mappedValue = normalizeInteger(mappedDeal?.PaymentGroupCode);
  if (mappedValue !== null) {
    return mappedValue;
  }

  return normalizeInteger(groupCodeDefaults?.PaymentGroupCode);
}

export function resolveHubspotPropertyNameBySapField(mappings, sapField, fallback = null) {
  const match = (Array.isArray(mappings) ? mappings : []).find(
    (mapping) => String(mapping?.sourceField || '').trim() === sapField
      && String(mapping?.targetField || '').trim()
  );

  return match ? String(match.targetField).trim() : fallback;
}

export function resolveContactDisplayName(contact) {
  const fullName = [
    toNonEmptyString(contact?.firstname),
    toNonEmptyString(contact?.lastname),
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  return toNonEmptyString(
    fullName
    || contact?.name
    || contact?.email
    || contact?.hs_object_id
  );
}

export function buildDefaultBusinessPartnerCardCode({ company, contact, companyExists }) {
  const sourceObjectId = toNonEmptyString(
    companyExists ? company?.hs_object_id : contact?.hs_object_id
  );
  const normalizedSource = String(sourceObjectId || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  const dynamicPart = (normalizedSource
    ? normalizedSource.slice(-12)
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(-12);

  return `CL${dynamicPart}`.slice(0, 15);
}

const DEFAULT_DISCOUNT_FIELD = 'hs_discount_percentage';

// Resolves the line discount from the configured HubSpot field. Discounts are gated on
// `requireDiscounts.isRequired`: when false (or unset) the discount is not applied and the
// caller's fallback is returned. The field to read comes from `fieldMappings.Discount`
// (default `hs_discount_percentage`).
function resolveLineDiscount(lineItem, discountConfig, fallback) {
  if (!discountConfig?.isRequired) {
    return fallback;
  }

  const field = toNonEmptyString(discountConfig?.fieldMappings?.Discount)
    || DEFAULT_DISCOUNT_FIELD;

  return normalizeNumber(lineItem?.[field], fallback);
}

function resolveTaxCodeByRate(taxCodes, taxRate) {
  const rawRate = toNonEmptyString(taxRate);
  if (!rawRate) {
    return null;
  }

  const normalizedRate = normalizeNumber(rawRate, null);
  if (!Number.isFinite(normalizedRate)) {
    throw new PermanentWebhookError(`Invalid hs_tax_rate ${rawRate}`);
  }

  const match = (Array.isArray(taxCodes) ? taxCodes : []).find((taxCode) => {
    const configuredRate = normalizeNumber(taxCode?.Rate, null);
    return Number.isFinite(configuredRate) && configuredRate === normalizedRate;
  });
  const taxCode = toNonEmptyString(match?.Code);

  if (!taxCode) {
    throw new PermanentWebhookError(`TaxCode is not configured for hs_tax_rate ${rawRate}`);
  }

  return taxCode;
}

function resolveUnitPrice({ mapped, lineItem, miscPriceCalculationConfig }) {
  const originalPriceTargetProperty = toNonEmptyString(
    miscPriceCalculationConfig?.originalPriceTargetProperty
  );
  const configuredOriginalPrice = originalPriceTargetProperty
    ? normalizeNumber(pickByPath(lineItem, originalPriceTargetProperty), null)
    : null;

  if (miscPriceCalculationConfig?.enableMiscPriceCalculation) {
    const priceCalculation = calculateUnitPriceWithMisc({
      sapPrice: configuredOriginalPrice,
      lineItem,
      config: miscPriceCalculationConfig,
    });

    return {
      unitPrice: priceCalculation.price,
      warning: priceCalculation.warning,
    };
  }

  return {
    unitPrice: normalizeNumber(
      mapped?.UnitPrice ?? lineItem?.hs_effective_unit_price ?? lineItem?.price,
      0
    ),
    warning: null,
  };
}

// `productMappings` (product/product) drive the SAP -> HubSpot product sync and are only read
// here to resolve ItemCode/Quantity/UnitPrice. `lineMappings` (product/orders-quotations) are
// the HubSpot -> SAP line fields and are the only ones spread into the line, so product sync
// fields like Price or QuantityOnStock can never reach DocumentLines.
export function mapDocumentLines({
  lineItems,
  productMappings,
  lineMappings = [],
  taxCodes = [],
  miscPriceCalculationConfig = null,
  discountConfig = null,
  logger = null,
}) {
  const lines = [];

  for (const lineItem of lineItems) {
    const mapped = mapHubspotToSapFields(lineItem, productMappings);
    const itemCode = toNonEmptyString(mapped?.ItemCode || lineItem?.hs_sku || lineItem?.itemCode);
    const quantity = normalizeNumber(mapped?.Quantity ?? lineItem?.quantity, 1);
    const discount = resolveLineDiscount(lineItem, discountConfig, 0);
    const { unitPrice, warning } = resolveUnitPrice({ mapped, lineItem, miscPriceCalculationConfig });

    if (!itemCode) {
      throw new PermanentWebhookError('ItemCode/hs_sku is required in line_items mapping');
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new PermanentWebhookError(`Invalid quantity for item ${itemCode}`);
    }

    if (warning) {
      logger?.warn?.({
        msg: warning,
        itemCode,
      });
    }

    const mappedLine = pickMappedLineFields(mapHubspotToSapFields(lineItem, lineMappings));
    const line = {
      ...mappedLine,
      ItemCode: itemCode,
      Quantity: quantity,
      WarehouseCode: lineItem.warehouses,
    };

    // B1 takes either the net price or the VAT-inclusive price, never both.
    if (!Object.prototype.hasOwnProperty.call(mappedLine, 'PriceAfterVAT')) {
      line.UnitPrice = Number.isFinite(unitPrice) ? unitPrice : 0;
    }

    if (discount !== 0) {
      line.DiscountPercent = discount;
    }

    const taxCode = resolveTaxCodeByRate(taxCodes, lineItem?.hs_tax_rate);

    if (taxCode) {
      line.TaxCode = taxCode;
    }

    lines.push(line);
  }

  return lines;
}

export function buildOrderPayload({
  cardCode,
  documentLines,
  slpCode = null,
  paymentGroupCode = null,
  mappedDealFields = {},
  comments = null,
  U_ACO_Telefono = null,
  U_ACO_Telefono2 = null,
  Address = null,
  Address2 = null,
}) {
  if (!documentLines.length) {
    throw new PermanentWebhookError('At least one line_item is required to create SAP Order');
  }

  const payload = {
    ...pickMappedHeaderFields(mappedDealFields),
    CardCode: cardCode,
    DocDueDate: resolveDocDueDate({ mappedDeal: mappedDealFields }),
    DocumentLines: documentLines,
  };

  if (Number.isInteger(slpCode)) {
    payload.SalesPersonCode = slpCode;
  }

  if (Number.isInteger(paymentGroupCode)) {
    payload.PaymentGroupCode = paymentGroupCode;
  }

  const resolvedComments = toNonEmptyString(comments);
  if (resolvedComments) {
    payload.Comments = resolvedComments;
  }

  const optionalFields = { U_ACO_Telefono, U_ACO_Telefono2, Address, Address2 };
  for (const [field, value] of Object.entries(optionalFields)) {
    const resolved = toNonEmptyString(value);
    if (resolved) {
      payload[field] = resolved;
    }
  }

  return payload;
}

// SAP BaseType for Sales Quotation (Oferta de Venta).
export const QUOTATION_BASE_TYPE = 23;

export function buildQuotationPayload({
  cardCode,
  documentLines,
  slpCode = null,
  paymentGroupCode = null,
  mappedDealFields = {},
  numAtCard = null,
  comments = null,
}) {
  if (!documentLines.length) {
    throw new PermanentWebhookError('At least one line_item is required to create SAP Quotation');
  }

  const payload = {
    ...pickMappedHeaderFields(mappedDealFields),
    CardCode: cardCode,
    DocDueDate: resolveDocDueDate({ mappedDeal: mappedDealFields }),
    DocumentLines: documentLines,
  };

  if (Number.isInteger(slpCode)) {
    payload.SalesPersonCode = slpCode;
  }

  if (Number.isInteger(paymentGroupCode)) {
    payload.PaymentGroupCode = paymentGroupCode;
  }

  const resolvedNumAtCard = toNonEmptyString(numAtCard);
  if (resolvedNumAtCard) {
    payload.NumAtCard = resolvedNumAtCard;
  }

  const resolvedComments = toNonEmptyString(comments);
  if (resolvedComments) {
    payload.Comments = resolvedComments;
  }

  return payload;
}

// Only DocDueDate is taken from mappedDealFields here: the rest of the header is copied by
// SAP from the base quotation, so the mapped fields are deliberately not spread in.
export function buildOrderFromQuotationPayload({
  cardCode,
  baseEntry,
  baseLines,
  slpCode = null,
  numAtCard = null,
  comments = null,
  mappedDealFields = {},
}) {
  const normalizedBaseEntry = baseEntry === null || typeof baseEntry === 'undefined'
    ? null
    : normalizeNumber(baseEntry, null);
  if (!Number.isFinite(normalizedBaseEntry)) {
    throw new PermanentWebhookError('A valid quotation BaseEntry is required to create SAP Order');
  }

  const documentLines = (Array.isArray(baseLines) ? baseLines : [])
    .map((line) => normalizeNumber(line?.sapLineNum ?? line, null))
    .filter((baseLine) => Number.isFinite(baseLine))
    .map((baseLine) => ({
      BaseType: QUOTATION_BASE_TYPE,
      BaseEntry: normalizedBaseEntry,
      BaseLine: baseLine,
    }));

  if (!documentLines.length) {
    throw new PermanentWebhookError(
      'At least one quotation line (BaseLine) is required to create SAP Order from Quotation'
    );
  }

  const payload = {
    CardCode: cardCode,
    DocDueDate: resolveDocDueDate({ mappedDeal: mappedDealFields }),
    DocumentLines: documentLines,
  };

  if (Number.isInteger(slpCode)) {
    payload.SalesPersonCode = slpCode;
  }

  const resolvedNumAtCard = toNonEmptyString(numAtCard);
  if (resolvedNumAtCard) {
    payload.NumAtCard = resolvedNumAtCard;
  }

  const resolvedComments = toNonEmptyString(comments);
  if (resolvedComments) {
    payload.Comments = resolvedComments;
  }

  return payload;
}

// Resolves the SAP LineNum for an incoming HubSpot line item against the stored link lines.
// HubSpot workflows are not consistent about which identifier they send (line item id vs
// product id), so we match in priority order: line item id -> product id -> SKU. Already
// matched LineNums are excluded to avoid emitting a duplicate LineNum in the PATCH.
function resolveQuotationLinkLine(lineItem, linkLines, usedLineNums) {
  const candidateIds = [
    toNonEmptyString(lineItem?.hubspot_id),
    toNonEmptyString(lineItem?.hubspotLineItemId),
    toNonEmptyString(lineItem?.hs_product_id),
    toNonEmptyString(lineItem?.hubspotProductId),
    toNonEmptyString(lineItem?.productId),
  ].filter(Boolean);
  const candidateSkus = [
    toNonEmptyString(lineItem?.hs_sku),
    toNonEmptyString(lineItem?.sku),
    toNonEmptyString(lineItem?.itemCode),
  ].filter(Boolean);

  const lines = (Array.isArray(linkLines) ? linkLines : []).filter((link) => {
    const lineNum = normalizeNumber(link?.sapLineNum, null);
    return Number.isFinite(lineNum) && !usedLineNums.has(lineNum);
  });

  const matchers = [
    (link) => candidateIds.includes(toNonEmptyString(link?.hubspotLineItemId)),
    (link) => candidateIds.includes(toNonEmptyString(link?.hubspotProductId)),
    (link) => candidateSkus.includes(toNonEmptyString(link?.sku)),
  ];

  for (const matcher of matchers) {
    const match = lines.find(matcher);
    if (match) {
      return { sapLineNum: normalizeNumber(match.sapLineNum, null) };
    }
  }

  return null;
}

// Builds the PATCH /Quotations(DocEntry) DocumentLines updating only existing lines
// (price / quantity / discount) matched by their SAP LineNum.
export function buildQuotationLineUpdates({ lineItems, productMappings, linkLines, taxCodes = [], miscPriceCalculationConfig = null, discountConfig = null, logger = null }) {
  const updates = [];
  const usedLineNums = new Set();

  for (const lineItem of Array.isArray(lineItems) ? lineItems : []) {
    const matchedLink = resolveQuotationLinkLine(lineItem, linkLines, usedLineNums);
    if (!matchedLink) {
      logger?.warn?.({
        msg: 'Skipping quotation line update: no stored LineNum for HubSpot line item',
        hubspotLineItemId: toNonEmptyString(lineItem?.hubspot_id),
        hubspotProductId: toNonEmptyString(lineItem?.hs_product_id),
        sku: toNonEmptyString(lineItem?.hs_sku),
      });
      continue;
    }

    usedLineNums.add(matchedLink.sapLineNum);

    const mapped = mapHubspotToSapFields(lineItem, productMappings);
    const quantity = normalizeNumber(mapped?.Quantity ?? lineItem?.quantity, null);
    const discount = resolveLineDiscount(lineItem, discountConfig, null);
    const { unitPrice, warning } = resolveUnitPrice({ mapped, lineItem, miscPriceCalculationConfig });

    if (warning) {
      logger?.warn?.({ msg: warning, sapLineNum: matchedLink.sapLineNum });
    }

    const line = { LineNum: matchedLink.sapLineNum };

    if (Number.isFinite(unitPrice)) {
      line.UnitPrice = unitPrice;
    }

    if (Number.isFinite(quantity) && quantity > 0) {
      line.Quantity = quantity;
    }

    if (Number.isFinite(discount)) {
      line.DiscountPercent = discount;
    }

    // Allow changing the warehouse on update (accepts both `warehouseCode` and `warehouses`).
    const warehouseCode = toNonEmptyString(lineItem?.warehouseCode || lineItem?.warehouses);
    if (warehouseCode) {
      line.WarehouseCode = warehouseCode;
    }

    const taxCode = resolveTaxCodeByRate(taxCodes, lineItem?.hs_tax_rate);
    if (taxCode) {
      line.TaxCode = taxCode;
    }

    updates.push(line);
  }

  if (!updates.length) {
    throw new PermanentWebhookError('No matching quotation lines found to update');
  }

  return updates;
}
