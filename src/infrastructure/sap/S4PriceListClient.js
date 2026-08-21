import { toODataV2DateTime } from '#infrastructure/sap/s4ODataQueryBuilder.js';
import { escapeODataString, normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

// Lecturas de precio de venta en S/4. Dos pasos por material y no uno porque la entidad que
// permite filtrar (la de vigencia) no trae la tarifa, y la que trae la tarifa no permite
// filtrar por material ni por lista de precios.
export const CUSTOMER_SALES_AREA_PATH = '/API_BUSINESS_PARTNER/A_CustomerSalesArea';
export const CONDITION_VALIDITY_PATH = '/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgCndnRecdValidity';
export const CONDITION_RECORD_PATH = '/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgConditionRecord';

export const CUSTOMER_SALES_AREA_SELECT = [
  'Customer',
  'SalesOrganization',
  'DistributionChannel',
  'Division',
  'PriceListType',
  'Currency',
].join(',');

export const CONDITION_VALIDITY_SELECT = [
  'ConditionRecord',
  'ConditionType',
  // PriceListType vive SOLO acá, no en el registro de condición: es la mitad del join.
  'PriceListType',
  'Material',
  'SalesOrganization',
  'DistributionChannel',
  'ConditionValidityStartDate',
  'ConditionValidityEndDate',
].join(',');

export const CONDITION_RECORD_SELECT = [
  'ConditionRecord',
  // ConditionTable es lo que distingue un precio por lista (502) de un precio por defecto del
  // producto (501/504); no se puede filtrar por él, así que se clasifica en memoria.
  'ConditionTable',
  'ConditionType',
  'ConditionRateValue',
  'ConditionCurrency',
  'ConditionQuantity',
  'ConditionQuantityUnit',
  'ConditionIsDeleted',
].join(',');

const enc = encodeURIComponent;

function equalsLiteral(field, value) {
  return `${field} eq '${escapeODataString(value)}'`;
}

// Las fechas de vigencia de SAP son fechas puras: llegan siempre a medianoche UTC. Si el literal
// del filtro lleva la hora del momento, `ConditionValidityEndDate ge datetime'…T21:37:04'` es
// FALSO para el registro cuyo último día de vigencia es HOY (su valor es hoy 00:00:00), y el
// precio de la lista cae silenciosamente al default del producto: se escribe un precio
// equivocado en el CRM sin que nada falle. Truncar al inicio del día UTC pone los dos literales
// sobre el mismo día calendario que compara SAP.
//
// Lo que esto NO resuelve: para un tenant al oeste de UTC, `new Date()` de la noche local ya
// pertenece al día UTC siguiente, así que se aplica el día calendario UTC y no el local. Eso
// requiere la zona horaria del tenant en la config y queda fuera de alcance.
function toUtcStartOfDay(date) {
  const parsed = date instanceof Date ? date : new Date(date);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`date is required for fetchConditionCandidates; received: ${String(date)}`);
  }

  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

// Nunca se filtra por `PriceListType eq ''`: Gateway no devuelve los registros sin lista con
// ese filtro (verificado el 2026-08-18 con el registro 0000418745). Se traen todos los del
// material y se clasifican por ConditionTable.
function buildValidityFilter({ conditionType, material, salesArea, date }) {
  // salesArea debe tener ambos campos; si faltan, lanzamos error en lugar de omitir el filtro
  // silenciosamente, porque eso causaría que SAP devuelva tarifas de otros canales/org sin que
  // nada fallara.
  const salesOrg = toNonEmptyString(salesArea?.salesOrganization);
  const distChannel = toNonEmptyString(salesArea?.distributionChannel);

  if (!salesOrg) {
    throw new Error(
      'salesArea.salesOrganization is required for fetchConditionCandidates; received: '
      + JSON.stringify(salesArea)
    );
  }

  if (!distChannel) {
    throw new Error(
      'salesArea.distributionChannel is required for fetchConditionCandidates; received: '
      + JSON.stringify(salesArea)
    );
  }

  // El truncado vive acá, en el borde donde se arma el literal OData, porque es acá donde vive
  // la semántica de la comparación de SAP (ver toUtcStartOfDay).
  const literal = toODataV2DateTime(toUtcStartOfDay(date));
  const conditions = [
    equalsLiteral('ConditionType', conditionType),
    equalsLiteral('Material', material),
    equalsLiteral('SalesOrganization', salesOrg),
    equalsLiteral('DistributionChannel', distChannel),
  ];

  conditions.push(`ConditionValidityStartDate le ${literal}`);
  conditions.push(`ConditionValidityEndDate ge ${literal}`);

  return conditions.join(' and ');
}

function toCandidate(validityRow, recordRow) {
  return {
    conditionRecord: toNonEmptyString(validityRow.ConditionRecord),
    conditionTable: toNonEmptyString(recordRow.ConditionTable),
    priceListType: toNonEmptyString(validityRow.PriceListType),
    material: toNonEmptyString(validityRow.Material),
    conditionRateValue: normalizeNumber(recordRow.ConditionRateValue, 0),
    conditionCurrency: toNonEmptyString(recordRow.ConditionCurrency),
    conditionQuantity: normalizeNumber(recordRow.ConditionQuantity, 1),
    conditionQuantityUnit: toNonEmptyString(recordRow.ConditionQuantityUnit),
    conditionIsDeleted: recordRow.ConditionIsDeleted === true,
  };
}

export class S4PriceListClient {
  constructor({ transport } = {}) {
    if (!transport) {
      throw new Error('transport is required for S4PriceListClient');
    }

    this.transport = transport;
  }

  async fetchCustomerSalesAreas(customer) {
    const normalized = toNonEmptyString(customer);

    if (!normalized) {
      return [];
    }

    return this.transport.fetchAll({
      path: CUSTOMER_SALES_AREA_PATH,
      query: {
        $select: CUSTOMER_SALES_AREA_SELECT,
        $filter: enc(equalsLiteral('Customer', normalized)),
      },
    });
  }

  async fetchConditionCandidates({ conditionType, material, salesArea, date }) {
    const validityRows = await this.transport.fetchAll({
      path: CONDITION_VALIDITY_PATH,
      query: {
        $select: CONDITION_VALIDITY_SELECT,
        $filter: enc(buildValidityFilter({ conditionType, material, salesArea, date })),
      },
    });

    const conditionRecords = (Array.isArray(validityRows) ? validityRows : [])
      .map((row) => toNonEmptyString(row?.ConditionRecord))
      .filter((id, index, ids) => id && ids.indexOf(id) === index);

    if (conditionRecords.length === 0) {
      return [];
    }

    // Una sola llamada para todas las tarifas del material: los datos reales muestran un puñado
    // de registros por material/área (las 4 listas más los defaults del producto), por lo que el
    // `or` mantiene URLs manejables. Esta es una expectativa de volumen, no un límite del código.
    const recordRows = await this.transport.fetchAll({
      path: CONDITION_RECORD_PATH,
      query: {
        $select: CONDITION_RECORD_SELECT,
        $filter: enc(
          conditionRecords.map((id) => equalsLiteral('ConditionRecord', id)).join(' or ')
        ),
      },
    });

    const recordsById = new Map(
      (Array.isArray(recordRows) ? recordRows : [])
        .map((row) => [toNonEmptyString(row?.ConditionRecord), row])
        .filter(([id]) => id)
    );

    return (Array.isArray(validityRows) ? validityRows : [])
      .map((validityRow) => {
        const recordRow = recordsById.get(toNonEmptyString(validityRow?.ConditionRecord));
        return recordRow ? toCandidate(validityRow, recordRow) : null;
      })
      .filter(Boolean);
  }
}

export default S4PriceListClient;
