import { calculateUnitPriceWithMisc } from '#domain/prices/misc-price-calculation.service.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { pickByPath } from '#shared/utils/object-path.utils.js';
import { normalizeInteger, normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

// Un workflow de HubSpot mal configurado serializa una propiedad vacia como el TEXTO 'null' o
// 'undefined' en vez de omitirla. Verificado en produccion: el tenant noelito manda "null" en
// numero_de_contacto_secundario y direccion_de_facturacion, y hoy eso se escribe literal en
// U_ACO_Telefono2 y Address de sus ordenes de SAP.
//
// El descarte NO va en toNonEmptyString a proposito: esa funcion tiene 208 usos en 34 archivos,
// la mayoria identificadores (hs_object_id, portalId, hs_sku, cardCode), asi que cambiarle la
// semantica exige su propia rama para poder atribuir cualquier regresion.
const EMPTY_TEXT_SENTINELS = new Set(['null', 'undefined']);

function isEmptyTextSentinel(value) {
  return typeof value === 'string' && EMPTY_TEXT_SENTINELS.has(value.trim().toLowerCase());
}

// Un valor de puros espacios (o tabs/saltos de linea) es la misma clase de basura que ''
// o los textos "null"/"undefined": la propiedad de HubSpot esta vacia mas alla de como el
// workflow la haya serializado. Se descarta en silencio igual que '', sin warn: no es un
// texto reconocible como error de configuracion, es simplemente vacio.
//
// El valor que SI viaja no se recorta aca: esta funcion solo decide si la clave se agrega,
// nunca transforma el valor guardado. Un 'texto ' con espacio final tiene que llegar a SAP
// tal cual. Solo strings entran a este chequeo; numeros, booleanos (incluido 0 y false) y
// arrays no son texto y siguen viajando sin tocar.
function isBlankString(value) {
  return typeof value === 'string' && value.trim() === '';
}

export function mapHubspotToSapFields(source, mappings, { logger = null } = {}) {
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

    // Se avisa en vez de descartar en silencio: el valor sucio viene de un workflow mal
    // configurado, y este warn es lo que hace que alguien lo corrija en HubSpot, que es donde
    // corresponde. Un null real no pasa por aca, asi que el log no se llena de ruido.
    if (isEmptyTextSentinel(value)) {
      logger?.warn?.({
        msg: 'Propiedad de HubSpot descartada por llegar como el texto "null"/"undefined"',
        sapField: sourceField,
        hubspotProperty: targetField,
        value,
      });
      continue;
    }

    if (value !== null && typeof value !== 'undefined' && !isBlankString(value)) {
      mapped[sourceField] = value;
    }
  }

  return mapped;
}

// Header fields owned by the builders (or with dedicated coercion, like PaymentGroupCode)
// are excluded from the generic deal-mapping spread so mapped raw values cannot clobber them.
const RESERVED_HEADER_FIELDS = new Set(['CardCode', 'DocDueDate', 'DocumentLines', 'PaymentGroupCode']);

// BoDocSpecialLineType member for a free-text special line (the alternative is dslt_Subtotal).
const SPECIAL_LINE_TYPE_TEXT = 'dslt_Text';

// SAP expects DocumentSpecialLines as a collection of line objects, but a FieldMapping can only
// copy a scalar HubSpot property: `texto_gobierno` arrives as plain text. Service Layer does not
// reject a malformed entry — it drops the whole collection and stores [], so the text is lost
// with no error anywhere. The string is reshaped here into the collection SAP actually expects.
//
// Both LineType and AfterLineNumber are required: a special line is positioned relative to the
// document lines, so without an anchor SAP has nowhere to put it and discards it in silence.
// This was verified against the DocumentSpecialLine ComplexType in the Service Layer $metadata
// after a first attempt sending only LineNum + LineText came back as [] on a GET by key.
//
// The whole text becomes a single line on purpose. Its newlines mix soft wraps ("Capacidad de \n
// hojas en bandeja") with real separators ("O.C: 111931\nCódigo Artículo: 36351"), so splitting
// on them would cut sentences in half.
export function normalizeDocumentSpecialLines(value, { afterLineNumber = 0 } = {}) {
  if (Array.isArray(value)) {
    return value.length ? value : null;
  }

  const lineText = toNonEmptyString(value);

  if (!lineText) {
    return null;
  }

  return [
    {
      LineType: SPECIAL_LINE_TYPE_TEXT,
      AfterLineNumber: afterLineNumber,
      LineText: lineText,
    },
  ];
}

// Exportada porque el PATCH de ProcessHubspotUpdateQuotation la necesita: sin ella, un mapeo
// podria pisar CardCode o DocumentLines en la actualizacion de una oferta, y DocumentSpecialLines
// llegaria como texto plano en vez de como la coleccion que SAP espera.
export function pickMappedHeaderFields(mappedDealFields, { documentLineCount = 0 } = {}) {
  const fields = {};

  for (const [field, value] of Object.entries(mappedDealFields || {})) {
    if (RESERVED_HEADER_FIELDS.has(field)) {
      continue;
    }

    if (field === 'DocumentSpecialLines') {
      // Anchor the text after the last document line: SAP numbers lines from 0.
      const specialLines = normalizeDocumentSpecialLines(value, {
        afterLineNumber: Math.max(documentLineCount - 1, 0),
      });
      if (specialLines) {
        fields[field] = specialLines;
      }
      continue;
    }

    fields[field] = value;
  }

  return fields;
}

// This is a DIFFERENT criterion from RESERVED_HEADER_FIELDS above, hence its own Set: that one
// is "the builder already owns this field" (CardCode, DocDueDate, DocumentLines, PaymentGroupCode
// are computed elsewhere when a document is CREATED), while this one is "SAP will not let you
// change this on a document that already exists". Series/DocNum/DocType/DocEntry identify the
// document itself, and DocDate/TaxDate are posting dates fixed at creation. None of that applies
// while creating: mixing the two lists would also strip these fields from buildOrderPayload and
// buildQuotationPayload, where they DO need to travel.
//
// Verified against production data: tenant printer has Series, DocumentSpecialLines, TaxDate and
// DocDate mapped in dealOrdersQuotationsMappings (a single list shared by order/quotation
// creation, conversion, AND the quotation PATCH). It does not use updateQuotation today, but any
// tenant that maps one of these and later edits quotation lines would send it in a PATCH; Service
// Layer rejects the whole PATCH rather than the offending field, so line sync would silently stop
// landing with a symptom that does not point back to the mapping.
export const IMMUTABLE_ON_PATCH_FIELDS = new Set(['Series', 'DocNum', 'DocDate', 'TaxDate', 'DocType', 'DocEntry']);

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
}) {
  if (!documentLines.length) {
    throw new PermanentWebhookError('At least one line_item is required to create SAP Order');
  }

  const payload = {
    ...pickMappedHeaderFields(mappedDealFields, { documentLineCount: documentLines.length }),
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
}) {
  if (!documentLines.length) {
    throw new PermanentWebhookError('At least one line_item is required to create SAP Quotation');
  }

  const payload = {
    ...pickMappedHeaderFields(mappedDealFields, { documentLineCount: documentLines.length }),
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

  return payload;
}

// La cabecera la copia SAP de la cotización base, así que aquí sólo viajan los campos que el
// tenant mapeó en el contexto deal/orders-quotations. Ese derrame es la ÚNICA fuente de
// NumAtCard, Comments y de cualquier campo extra que el workflow de HubSpot agregue después.
//
// No hay parámetros numAtCard/comments a propósito: un parámetro se aplica DESPUÉS del derrame
// y por lo tanto le gana al mapeo. Eso es exactamente lo que hacía que este builder mandara un
// literal del integrador en Comments y un HS-DEAL-<dealId> fabricado en NumAtCard.
export function buildOrderFromQuotationPayload({
  cardCode,
  baseEntry,
  baseLines,
  slpCode = null,
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
    ...pickMappedHeaderFields(mappedDealFields, { documentLineCount: documentLines.length }),
    CardCode: cardCode,
    DocDueDate: resolveDocDueDate({ mappedDeal: mappedDealFields }),
    DocumentLines: documentLines,
  };

  if (Number.isInteger(slpCode)) {
    payload.SalesPersonCode = slpCode;
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
