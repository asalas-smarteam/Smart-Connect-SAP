export const SAP_ERROR_BYPASS_CONFIG_KEY = 'bypassSapErrors';

// Areas de la sincronizacion cuyo error de SAP se puede indultar. Hoy solo
// `contactEmployee`; agregar otra (bpAddress, businessPartnerUpdate, ...) es
// sumarla a esta lista y consultarla donde corresponda -- el normalizador y el
// default se derivan de aca, asi que no hay un segundo lugar que actualizar.
export const SAP_ERROR_BYPASS_AREAS = Object.freeze(['contactEmployee']);

export const DEFAULT_SAP_ERROR_BYPASS_CONFIG = Object.freeze(
  Object.fromEntries(SAP_ERROR_BYPASS_AREAS.map((area) => [area, false]))
);

function isEnabled(value) {
  return value === true || value === 'true';
}

/**
 * Falla cerrado: cualquier cosa que no sea `true` (o el string `'true'`) en un area
 * conocida deja esa area SIN bypass, o sea bloqueando el documento. Un value ausente,
 * de otro tipo, o con la llave mal escrita no puede activar un bypass por accidente:
 * el costo de equivocarse hacia el otro lado es sincronizar a SAP datos que el cliente
 * queria corregir primero.
 */
export function normalizeSapErrorBypassConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_SAP_ERROR_BYPASS_CONFIG };
  }

  return Object.fromEntries(
    SAP_ERROR_BYPASS_AREAS.map((area) => [area, isEnabled(value[area])])
  );
}

export default {
  SAP_ERROR_BYPASS_CONFIG_KEY,
  SAP_ERROR_BYPASS_AREAS,
  DEFAULT_SAP_ERROR_BYPASS_CONFIG,
  normalizeSapErrorBypassConfig,
};
