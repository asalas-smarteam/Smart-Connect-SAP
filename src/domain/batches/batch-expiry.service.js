import { QUANTITY_DECIMALS } from '#domain/warehouses/warehouse-stock-strategy.constants.js';
import { BATCH_STATUS } from './batch-expiry.constants.js';

const MS_PER_DAY = 86400000;

// Redondeo compartido con la estrategia de stock por bodega: las cantidades
// llegan de SAP como string y sumarlas produce 12.000000000000002, que nunca
// iguala al 12 que devuelve HubSpot -> todos los productos se "actualizan"
// en cada corrida para siempre.
export function roundQuantity(value) {
  const factor = 10 ** QUANTITY_DECIMALS;
  return Math.round((Number(value) || 0) * factor) / factor;
}

// Dias calendario entre dos instantes, comparando medianoche UTC contra
// medianoche UTC. Sin esto, un lote que vence hoy a las 00:00 daria -1 dia
// si el sync corre a las 14:37.
export function daysBetween(from, to) {
  const utcDay = (date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.round((utcDay(to) - utcDay(from)) / MS_PER_DAY);
}

export function classifyBatch({ expirationDate, now, horizonDays }) {
  if (!(expirationDate instanceof Date) || Number.isNaN(expirationDate.getTime())) {
    return { status: BATCH_STATUS.SIN_FECHA, daysToExpiry: null };
  }

  const daysToExpiry = daysBetween(now, expirationDate);

  if (daysToExpiry < 0) {
    return { status: BATCH_STATUS.VENCIDO, daysToExpiry };
  }

  // Borde inclusivo: un lote que vence exactamente dentro de horizonDays ya
  // entra en la ventana de accion, no queda "vigente" por un dia.
  if (daysToExpiry <= horizonDays) {
    return { status: BATCH_STATUS.POR_VENCER, daysToExpiry };
  }

  return { status: BATCH_STATUS.VIGENTE, daysToExpiry };
}

// Fecha ascendente; los lotes sin fecha van al final (no se pueden ordenar
// contra los que si la tienen, y no son accionables).
export function sortBatches(batches) {
  return [...(Array.isArray(batches) ? batches : [])].sort((a, b) => {
    const aTime = a?.expirationDate instanceof Date ? a.expirationDate.getTime() : Infinity;
    const bTime = b?.expirationDate instanceof Date ? b.expirationDate.getTime() : Infinity;

    if (aTime !== bTime) {
      return aTime - bTime;
    }

    return String(a?.batch ?? '').localeCompare(String(b?.batch ?? ''));
  });
}

// Agregados que alimentan las propiedades escalares.
//
// `proximo` IGNORA los vencidos a proposito: en este tenant el 39% de los lotes
// con stock ya vencio, algunos hace mas de cuatro anos. Si el minimo absoluto
// mandara, "el proximo a vencer" seria siempre un lote de 2021 y la propiedad
// quedaria inservible justo para el caso de uso que la motiva.
export function summarizeBatches(batches) {
  const list = Array.isArray(batches) ? batches : [];

  let cantidadPorVencer = 0;
  let cantidadVencida = 0;
  let lotesVigentes = 0;
  let proximo = null;

  for (const batch of list) {
    const quantity = Number(batch?.quantity ?? 0) || 0;

    if (batch?.status === BATCH_STATUS.VENCIDO) {
      cantidadVencida += quantity;
      continue;
    }

    lotesVigentes += 1;

    if (batch?.status === BATCH_STATUS.POR_VENCER) {
      cantidadPorVencer += quantity;
    }

    if (batch?.expirationDate instanceof Date
      && (proximo === null || batch.expirationDate < proximo.expirationDate)) {
      proximo = batch;
    }
  }

  return {
    proximo,
    cantidadPorVencer: roundQuantity(cantidadPorVencer),
    cantidadVencida: roundQuantity(cantidadVencida),
    lotesVigentes,
  };
}

export default {
  roundQuantity, daysBetween, classifyBatch, sortBatches, summarizeBatches,
};
