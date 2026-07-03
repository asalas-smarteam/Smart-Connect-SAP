import { calculateUnitPriceWithMisc } from '#domain/prices/misc-price-calculation.service.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { pickByPath } from '#shared/utils/object-path.utils.js';
import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

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

export function mapDocumentLines({
  lineItems,
  productMappings,
  taxCodes = [],
  miscPriceCalculationConfig = null,
  logger = null,
}) {
  const lines = [];

  for (const lineItem of lineItems) {
    const mapped = mapHubspotToSapFields(lineItem, productMappings);
    const itemCode = toNonEmptyString(mapped?.ItemCode || lineItem?.hs_sku || lineItem?.itemCode);
    const quantity = normalizeNumber(mapped?.Quantity ?? lineItem?.quantity, 1);
    const discount = normalizeNumber(lineItem?.hs_discount_percentage, 0);
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

    const line = {
      ItemCode: itemCode,
      Quantity: quantity,
      UnitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
      WarehouseCode: lineItem.warehouses,
    };

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
    CardCode: cardCode,
    DocDueDate: new Date().toISOString().slice(0, 10),
    DocumentLines: documentLines,
  };

  if (Number.isInteger(slpCode)) {
    payload.SalesPersonCode = slpCode;
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
  numAtCard = null,
  comments = null,
}) {
  if (!documentLines.length) {
    throw new PermanentWebhookError('At least one line_item is required to create SAP Quotation');
  }

  const payload = {
    CardCode: cardCode,
    DocDueDate: new Date().toISOString().slice(0, 10),
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

export function buildOrderFromQuotationPayload({
  cardCode,
  baseEntry,
  baseLines,
  slpCode = null,
  numAtCard = null,
  comments = null,
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
    DocDueDate: new Date().toISOString().slice(0, 10),
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
export function buildQuotationLineUpdates({ lineItems, productMappings, linkLines, taxCodes = [], miscPriceCalculationConfig = null, logger = null }) {
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
    const discount = normalizeNumber(lineItem?.hs_discount_percentage, null);
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
