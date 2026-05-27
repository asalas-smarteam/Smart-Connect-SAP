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

export function mapDocumentLines({ lineItems, productMappings, taxCodes = [] }) {
  const lines = [];

  for (const lineItem of lineItems) {
    const mapped = mapHubspotToSapFields(lineItem, productMappings);
    const itemCode = toNonEmptyString(mapped?.ItemCode || lineItem?.hs_sku || lineItem?.itemCode);
    const quantity = normalizeNumber(mapped?.Quantity ?? lineItem?.quantity, 1);
    const unitPrice = normalizeNumber(
      lineItem?.hs_effective_unit_price,
      0
    );

    if (!itemCode) {
      throw new PermanentWebhookError('ItemCode/hs_sku is required in line_items mapping');
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new PermanentWebhookError(`Invalid quantity for item ${itemCode}`);
    }

    const line = {
      ItemCode: itemCode,
      Quantity: quantity,
      UnitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
      WarehouseCode: lineItem.warehouses,
    };
    const taxCode = resolveTaxCodeByRate(taxCodes, lineItem?.hs_tax_rate);

    if (taxCode) {
      line.TaxCode = taxCode;
    }

    lines.push(line);
  }

  return lines;
}

export function buildOrderPayload({ cardCode, documentLines }) {
  if (!documentLines.length) {
    throw new PermanentWebhookError('At least one line_item is required to create SAP Order');
  }

  return {
    CardCode: cardCode,
    DocDueDate: new Date().toISOString().slice(0, 10),
    DocumentLines: documentLines,
  };
}
