// Graba el tráfico con SAP de UN evento de webhook: método, path, params, body enviado y
// respuesta (o error) de cada llamada al Service Layer.
//
// Por qué a nivel de transporte y no en el use case: el auditTrail se llenaba con el valor
// de RETORNO de cada adapter, así que la llamada que fallaba no dejaba rastro -- un
// `POST /BusinessPartners` rechazado por un stored procedure de SAP se perdía completo y el
// WebhookEvent quedaba con `lastError` y `sapAudit: null`. Grabando en `request` se captura
// la llamada antes de saber si va a fallar, y de paso quedan registradas las llamadas cuyo
// error hoy se traga a propósito (updateBusinessPartnerFields / updateContactEmployeeFields
// devuelven `{ error }` para no bloquear la creación del documento).
//
// Los adapters son singletons en composition, así que el grabador no puede ser una
// dependencia de constructor: `wrap` devuelve una vista por evento del adapter con `request`
// interceptado. `Object.create` mantiene la cadena de prototipos, así que el resto de los
// métodos (y los `this.request` internos) siguen funcionando igual.

// Tope defensivo: un ciclo inesperado no puede hacer crecer el documento del WebhookEvent
// sin límite. 40 alcanza de sobra para el flujo más largo (BP + N ContactEmployees + doc).
const DEFAULT_MAX_CALLS = 40;

// Nunca graba headers: la cookie de sesión de SAP viaja ahí, y el login sucede dentro del
// transporte (no pasa por `request`), así que ninguna credencial entra a la auditoría.
export function createSapCallRecorder({ maxCalls = DEFAULT_MAX_CALLS, now = () => Date.now() } = {}) {
  const calls = [];
  let droppedCalls = 0;

  function append(entry) {
    if (calls.length >= maxCalls) {
      droppedCalls += 1;
      return;
    }

    calls.push(entry);
  }

  async function record(options, run) {
    const startedAt = now();
    const base = {
      // `target` distingue SAP de HubSpot cuando un mismo grabador audita las dos patas
      // (el webhook de precios). Las entradas de los flujos que sólo hablan con SAP quedan
      // con `target: null`, y serializeSapCalls no la copia, así que sapAudit no cambia.
      target: options?.target ?? null,
      method: String(options?.method || 'get').toUpperCase(),
      path: options?.path ?? null,
      params: options?.params ?? null,
      request: options?.data ?? null,
    };

    try {
      const response = await run();
      append({ ...base, ok: true, status: null, response, durationMs: now() - startedAt });
      return response;
    } catch (error) {
      append({
        ...base,
        ok: false,
        status: error?.response?.status ?? null,
        // Se guarda el error crudo: quien serializa (buildWebhookSapAudit) lo pasa por
        // buildErrorResponseSnapshot, que sabe sacar el `{ lang, value }` de SAP.
        error,
        durationMs: now() - startedAt,
      });
      throw error;
    }
  }

  function wrap(adapter) {
    if (!adapter?.request) {
      return adapter;
    }

    return Object.create(adapter, {
      request: {
        value: function requestWithAudit(sapConfig, options) {
          return record(options, () => adapter.request(sapConfig, options));
        },
      },
    });
  }

  return {
    calls,
    record,
    wrap,
    get droppedCalls() {
      return droppedCalls;
    },
  };
}

export default createSapCallRecorder;
