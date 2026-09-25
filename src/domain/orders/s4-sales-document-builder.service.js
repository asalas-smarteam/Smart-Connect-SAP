import { mapHubspotToSapFields } from './order-builder.service.js';
import { expandS4ODataKeys } from '#domain/sap/s4-odata-payload.service.js';
import { parseS4WarehouseCode } from '#domain/warehouses/strategies/s4-plant-storage-location.strategy.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

// Lista propia de S/4: NO se reusa RESERVED_HEADER_FIELDS de order-builder.service.js, que
// nombra campos de B1 (CardCode, DocumentLines, PaymentGroupCode) y no significa nada acá.
export const S4_RESERVED_HEADER_FIELDS = new Set([
  'SoldToParty',
  'SalesQuotation',
  'to_Item',
  'to_Partner',
  'to_PricingElement',
]);

export const S4_RESERVED_LINE_FIELDS = new Set([
  'SalesQuotationItem',
  'Material',
  'RequestedQuantity',
  'to_PricingElement',
  // Mismo motivo que WarehouseCode en RESERVED_LINE_FIELDS de order-builder.service.js (B1):
  // Plant lo resuelve resolveS4Plant traduciendo la bodega de HubSpot (fieldsWareHouseHS), no
  // un mapeo crudo. Sin reservarlo, un lineMapping con sourceField 'Plant' se derramaba dentro
  // del ítem y sobrevivía tal cual cuando resolveS4Plant no lograba resolver el centro (warn +
  // omitir), colando un value de HubSpot sin traducir donde SAP espera un código de centro.
  'Plant',
]);

function pickUnreserved(mappedFields, reserved) {
  const fields = {};

  for (const [field, value] of Object.entries(mappedFields || {})) {
    // Solo el primer segmento se compara: un mapeo `to_Item.Foo` tiene que quedar fuera igual
    // que `to_Item` pelado, o se cuela por debajo de la reserva.
    if (reserved.has(field.split('.')[0])) {
      continue;
    }
    fields[field] = value;
  }

  return fields;
}

// Precedencia mapeo del negocio -> default de configuración, en UN solo lugar. Antes esta
// misma decisión estaba escrita dos veces (con `??` en el caso de uso al armar el área de
// ventas y con `||` acá), y coincidían solo por casualidad: `??` deja pasar la cadena vacía
// que `||` descarta.
export function resolveS4HeaderFieldValue(mappedDealFields, configValue, sapField) {
  return toNonEmptyString(mappedDealFields?.[sapField]) || toNonEmptyString(configValue);
}

// S/4 exige estos cuatro en toda oferta. La clave de configuración va al lado del campo de SAP
// porque el caso de uso valida los cuatro ANTES de dar de alta al cliente y necesita la misma
// tabla.
export const S4_REQUIRED_HEADER_FIELDS = Object.freeze([
  { sapField: 'SalesQuotationType', configKey: 'quotationType' },
  { sapField: 'SalesOrganization', configKey: 'salesOrganization' },
  { sapField: 'DistributionChannel', configKey: 'distributionChannel' },
  { sapField: 'OrganizationDivision', configKey: 'division' },
]);

// Se resuelven mapeo -> default -> error, y el error NOMBRA el campo: sin eso el rechazo del
// gateway llega como un texto genérico que no dice cuál de los cuatro faltaba.
//
// Se exporta para que el caso de uso lo llame antes de resolver al cliente: la clase de
// documento solo se validaba acá, en el builder, que corre DESPUÉS del alta, así que a un
// tenant al que solo le faltara ese dato le quedaba un BusinessPartner huérfano en el maestro
// de clientes de SAP por cada intento (y el error es permanente, no hay reintento que lo
// limpie). Validar es una sola función, no una comprobación duplicada en dos capas.
export function resolveS4RequiredHeaderFields({ mappedDealFields, salesDocumentConfig }) {
  const resolved = {};

  for (const { sapField, configKey } of S4_REQUIRED_HEADER_FIELDS) {
    const value = resolveS4HeaderFieldValue(
      mappedDealFields,
      salesDocumentConfig?.[configKey],
      sapField
    );

    if (!value) {
      throw new PermanentWebhookError(
        `${sapField} es requerido para crear la oferta en S/4: no vino en el mapeo deal/orders-quotations ni en la configuración s4SalesDocument`
      );
    }

    resolved[sapField] = value;
  }

  return resolved;
}

// La propiedad `warehouses` del line item trae el VALUE de HubSpot (p.ej. 'mqgt_0008_stock'),
// no el código de SAP. fieldsWareHouseHS es la tabla que traduce value -> valueSAP, y de ahí
// parseS4WarehouseCode saca el centro.
export function resolveS4Plant({ lineItem, warehouseFields = [], logger = null }) {
  const warehouseValue = toNonEmptyString(lineItem?.warehouses);

  if (!warehouseValue) {
    return null;
  }

  const entry = (Array.isArray(warehouseFields) ? warehouseFields : []).find(
    (candidate) => toNonEmptyString(candidate?.value) === warehouseValue
  );

  const parsed = entry ? parseS4WarehouseCode(entry.valueSAP) : null;

  if (!parsed?.plant) {
    logger?.warn?.({
      msg: 'Posición sin Plant: la bodega de HubSpot no está en fieldsWareHouseHS o su valueSAP es inválido',
      warehouseValue,
      valueSAP: entry?.valueSAP ?? null,
    });
    return null;
  }

  return parsed.plant;
}

function buildItems({
  lineItems,
  productMappings,
  lineMappings,
  warehouseFields,
  priceConditionType,
  transactionCurrency,
  logger,
}) {
  const items = [];

  for (const [index, lineItem] of (Array.isArray(lineItems) ? lineItems : []).entries()) {
    const mappedProduct = mapHubspotToSapFields(lineItem, productMappings, { logger });
    const material = toNonEmptyString(mappedProduct?.ItemCode || lineItem?.hs_sku);
    const quantity = normalizeNumber(mappedProduct?.Quantity ?? lineItem?.quantity, 1);

    if (!material) {
      throw new PermanentWebhookError('Material/hs_sku es requerido en el mapeo de line_items');
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new PermanentWebhookError(`Cantidad inválida para el material ${material}`);
    }

    const mappedLine = pickUnreserved(
      mapHubspotToSapFields(lineItem, lineMappings, { logger }),
      S4_RESERVED_LINE_FIELDS
    );

    const item = {
      ...expandS4ODataKeys(mappedLine, { logger }),
      SalesQuotationItem: String((index + 1) * 10).padStart(6, '0'),
      Material: material,
      // Gateway OData v2 quiere los Edm.Decimal como string; un number se serializa sin
      // decimales y SAP lo rechaza o lo trunca.
      RequestedQuantity: String(quantity),
    };

    const plant = resolveS4Plant({ lineItem, warehouseFields, logger });
    if (plant) {
      item.Plant = plant;
    }

    if (priceConditionType) {
      const unitPrice = normalizeNumber(lineItem?.hs_effective_unit_price ?? lineItem?.price, null);

      if (Number.isFinite(unitPrice)) {
        item.to_PricingElement = [{
          ConditionType: priceConditionType,
          ConditionRateValue: String(unitPrice),
          ...(transactionCurrency ? { ConditionCurrency: transactionCurrency } : {}),
        }];
      }
    }

    items.push(item);
  }

  if (!items.length) {
    throw new PermanentWebhookError('Se requiere al menos un line_item para crear la oferta en S/4');
  }

  return items;
}

export function buildS4QuotationPayload({
  soldToParty,
  lineItems,
  productMappings,
  lineMappings = [],
  mappedDealFields = {},
  salesDocumentConfig,
  warehouseFields = [],
  salesPersonId = null,
  logger = null,
}) {
  const resolvedSoldToParty = toNonEmptyString(soldToParty);

  if (!resolvedSoldToParty) {
    throw new PermanentWebhookError('SoldToParty es requerido para crear la oferta en S/4');
  }

  const transactionCurrency = toNonEmptyString(mappedDealFields?.TransactionCurrency);

  const to_Item = buildItems({
    lineItems,
    productMappings,
    lineMappings,
    warehouseFields,
    priceConditionType: salesDocumentConfig?.priceConditionType ?? null,
    transactionCurrency,
    logger,
  });

  // Se resuelve DESPUÉS de to_Item para no cambiar cuál error sale primero cuando el evento
  // tiene además una posición inválida. El orden de las claves del payload tampoco cambia:
  // S4_REQUIRED_HEADER_FIELDS las devuelve en el mismo orden en que se escribían acá.
  const requiredHeaderFields = resolveS4RequiredHeaderFields({
    mappedDealFields,
    salesDocumentConfig,
  });

  const payload = {
    ...expandS4ODataKeys(pickUnreserved(mappedDealFields, S4_RESERVED_HEADER_FIELDS), { logger }),
    ...requiredHeaderFields,
    SoldToParty: resolvedSoldToParty,
    to_Item,
  };

  const partnerFunction = toNonEmptyString(salesDocumentConfig?.salesPersonPartnerFunction);
  const personnel = toNonEmptyString(salesPersonId);

  // Mismo criterio que DocumentsOwner en B1: si no se resuelve, la clave no viaja. Mandarla
  // en null deja el documento sin asignar igual, pero además ensucia el payload.
  if (partnerFunction && personnel) {
    payload.to_Partner = [{ PartnerFunction: partnerFunction, Personnel: personnel }];
  }

  return payload;
}

export default {
  buildS4QuotationPayload,
  resolveS4Plant,
  resolveS4HeaderFieldValue,
  resolveS4RequiredHeaderFields,
  S4_REQUIRED_HEADER_FIELDS,
  S4_RESERVED_HEADER_FIELDS,
  S4_RESERVED_LINE_FIELDS,
};
