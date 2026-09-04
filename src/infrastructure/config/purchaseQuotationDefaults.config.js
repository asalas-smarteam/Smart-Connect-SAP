export const PURCHASE_QUOTATION_DEFAULTS_CONFIG_KEY = 'purchaseQuotationDefaults';

export const DEFAULT_PURCHASE_QUOTATION_DEFAULTS = Object.freeze({});

// Campos de cabecera que el tenant NO puede fijar por configuración: los resuelve el builder
// (DocumentLines desde los line_items) o son la colección de otro documento que no debe
// entrar acá. Se filtran igual que se filtran en el builder, para que el error se vea en la
// configuración y no como un rechazo opaco de SAP.
const RESERVED_DEFAULT_FIELDS = new Set(['DocumentLines', 'StockTransferLines']);

// Solo escalares: los UDF de SAP que un tenant fija por default (U_TIPOOFECOMPRA = 3,
// U_TIPOENT = 'X', ...) son siempre valores planos. Rechazar objetos y arrays evita que una
// configuración mal escrita inyecte una estructura entera en la cabecera del documento.
function isScalar(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Falla abierto pero acotado: una configuración ausente o con forma inesperada deja el
 * documento SIN defaults, que es exactamente el comportamiento previo a que esta key
 * existiera. Lo que sí entra se copia tal cual, sin coerción de tipo: es el mismo trato que
 * reciben los valores mapeados desde HubSpot, y SAP aplica su propia conversión.
 */
export function normalizePurchaseQuotationDefaults(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_PURCHASE_QUOTATION_DEFAULTS };
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      ([field, fieldValue]) => !RESERVED_DEFAULT_FIELDS.has(field) && isScalar(fieldValue)
    )
  );
}

export default {
  PURCHASE_QUOTATION_DEFAULTS_CONFIG_KEY,
  DEFAULT_PURCHASE_QUOTATION_DEFAULTS,
  normalizePurchaseQuotationDefaults,
};
