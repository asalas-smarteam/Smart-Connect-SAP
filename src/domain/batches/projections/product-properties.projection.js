import { BATCH_STATUS } from '../batch-expiry.constants.js';
import { summarizeBatches } from '../batch-expiry.service.js';

// Una entrada = una propiedad a crear en el portal antes del primer run. Si
// falta cualquiera, batchCreateProducts falla el lote de 100 entero y degrada a
// secuencial: ~8,000 requests fallidos.
export const BATCH_PRODUCT_PROPERTIES = Object.freeze([
  { objectType: 'products', name: 'lotes_detalle', label: 'Lotes (detalle)', type: 'string', fieldType: 'textarea' },
  { objectType: 'products', name: 'lote_proximo_vencer', label: 'Lote próximo a vencer', type: 'string', fieldType: 'text' },
  { objectType: 'products', name: 'fecha_vencimiento_proxima', label: 'Fecha de vencimiento más próxima', type: 'date', fieldType: 'date' },
  { objectType: 'products', name: 'dias_para_vencer', label: 'Días para vencer', type: 'number', fieldType: 'number' },
  { objectType: 'products', name: 'cantidad_por_vencer', label: 'Cantidad por vencer', type: 'number', fieldType: 'number' },
  { objectType: 'products', name: 'cantidad_vencida', label: 'Cantidad vencida', type: 'number', fieldType: 'number' },
  { objectType: 'products', name: 'lotes_vigentes', label: 'Lotes vigentes', type: 'number', fieldType: 'number' },
]);

// Agrupado manual en vez de toLocaleString: el resultado de toLocaleString
// depende de como se compilo el ICU de Node, asi que el mismo codigo puede
// emitir "9,654.000" en desarrollo y "9654.000" en el contenedor -> el diff de
// idempotencia ve un cambio que no existe y reescribe todos los productos.
export function formatQuantity(value) {
  const [whole, decimals] = (Number(value) || 0).toFixed(3).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimals}`;
}

// HubSpot acepta YYYY-MM-DD para propiedades de tipo date.
export function formatDate(date) {
  return date instanceof Date ? date.toISOString().slice(0, 10) : '';
}

function renderLine(batch) {
  const bodegas = (batch.locations ?? [])
    .map((location) => `${location.plant}/${location.storageLocation}`)
    .join(', ');

  const fecha = batch.status === BATCH_STATUS.SIN_FECHA
    ? 'sin fecha'
    : `${batch.status === BATCH_STATUS.VENCIDO ? 'VENCIDO' : 'vence'} ${formatDate(batch.expirationDate)}`;

  return `${batch.batch} · ${fecha} · ${formatQuantity(batch.quantity)} · ${bodegas}`;
}

// Todas las propiedades se escriben SIEMPRE, con '' cuando no aplica. Omitirlas
// dejaria valores viejos de una corrida anterior en un producto que ya no tiene
// lotes; escribir 0 se leeria como "no hay stock por vencer" en vez de "este
// producto no maneja lotes". HubSpot limpia una propiedad con ''.
const EMPTY_PROPERTIES = Object.freeze(
  Object.fromEntries(BATCH_PRODUCT_PROPERTIES.map((property) => [property.name, '']))
);

export class ProductPropertiesProjection {
  requiredProperties() {
    return BATCH_PRODUCT_PROPERTIES;
  }

  project({ batches, config }) {
    const list = Array.isArray(batches) ? batches : [];

    if (list.length === 0) {
      return { ...EMPTY_PROPERTIES };
    }

    const { proximo, cantidadPorVencer, cantidadVencida, lotesVigentes } = summarizeBatches(list);

    const visibles = config?.includeExpired === true
      ? list
      : list.filter((batch) => batch.status !== BATCH_STATUS.VENCIDO);

    return {
      lotes_detalle: visibles.map(renderLine).join('\n'),
      lote_proximo_vencer: proximo?.batch ?? '',
      fecha_vencimiento_proxima: proximo ? formatDate(proximo.expirationDate) : '',
      dias_para_vencer: proximo ? proximo.daysToExpiry : '',
      cantidad_por_vencer: cantidadPorVencer,
      cantidad_vencida: cantidadVencida,
      lotes_vigentes: lotesVigentes,
    };
  }
}

export default ProductPropertiesProjection;
