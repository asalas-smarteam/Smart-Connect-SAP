// Documento Configuration por tenant que decide como se leen los lotes de SAP y
// como se proyectan a HubSpot. Ver src/domain/batches/sources/ y projections/.
export const BATCH_EXPIRY_CONFIG_KEY = 'batchExpiryStrategy';

export const BATCH_SOURCE_STRATEGIES = Object.freeze({
  // Null object: el tenant no maneja lotes. Es el default, y hace que un tenant
  // sin configurar no pague ni una llamada a SAP.
  NONE: 'none',
  // S/4HANA: el maestro de lotes vive en API_BATCH_SRV, separado del stock.
  S4_BATCH_MASTER: 's4_BatchMaster',
});

export const BATCH_PROJECTION_STRATEGIES = Object.freeze({
  // Propiedades sobre el propio registro de producto. Unica opcion viable sin
  // custom objects, que son exclusivos de los tiers Enterprise de HubSpot.
  HS_PRODUCT_PROPERTIES: 'hs_ProductProperties',
});

export const DEFAULT_BATCH_SOURCE = BATCH_SOURCE_STRATEGIES.NONE;
export const DEFAULT_BATCH_PROJECTION = BATCH_PROJECTION_STRATEGIES.HS_PRODUCT_PROPERTIES;

// Clave bajo la que el enricher adjunta las propiedades resueltas al rawSapData
// del producto. A diferencia de WAREHOUSE_STOCK_KEY, esta clave NO se escribe
// siempre: si la fuente falla o el tenant es 'none', se omite, y product.handler
// .js deja las propiedades intactas en vez de pisarlas. Escribir vacio es una
// afirmacion ("este producto no maneja lotes") que un fallo de red no autoriza.
export const BATCH_EXPIRY_KEY = '_batchExpiry';

export const BATCH_STATUS = Object.freeze({
  VIGENTE: 'vigente',
  POR_VENCER: 'porVencer',
  VENCIDO: 'vencido',
  SIN_FECHA: 'sinFecha',
});

// Ventana por default de "por vencer", en dias.
export const DEFAULT_HORIZON_DAYS = 90;

// '01' = Libre utilizacion. Un lote en calidad ('02') o bloqueado ('04') no se
// puede vender, asi que mostrarlo bajo "aprovecha a venderlo" seria enganoso.
export const DEFAULT_BATCH_STOCK_TYPES = Object.freeze(['01']);

export default {
  BATCH_EXPIRY_CONFIG_KEY,
  BATCH_SOURCE_STRATEGIES,
  BATCH_PROJECTION_STRATEGIES,
  DEFAULT_BATCH_SOURCE,
  DEFAULT_BATCH_PROJECTION,
  BATCH_EXPIRY_KEY,
  BATCH_STATUS,
  DEFAULT_HORIZON_DAYS,
  DEFAULT_BATCH_STOCK_TYPES,
};
