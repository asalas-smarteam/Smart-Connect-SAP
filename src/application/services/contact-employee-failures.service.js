import { resolveErrorMessageText } from '#application/services/error-message.service.js';
import { toNonEmptyString } from '#shared/utils/string.utils.js';

// El alta de un ContactEmployee en SAP nunca tumba el documento: addContactEmployeeIfNeeded
// atrapa el error y sigue (ver SapWebhookOrderAdapter). Esa política es correcta -- la orden
// o el traslado ya son válidos sin ese contacto -- pero durante meses el error no se logueó,
// no entró al audit y no llegó a HubSpot: el evento quedaba `completed` y limpio, mientras
// dos ContactEmployees rechazados por SAP ("Value too long in property 'Title'") no existían
// en ninguna parte. Este servicio es el que hace visible ese fallo parcial sin cambiar la
// política de no bloquear el documento.

function resolveFailureIdentity({ requestPayload, contact }) {
  return {
    email: toNonEmptyString(requestPayload?.E_Mail) ?? toNonEmptyString(contact?.email) ?? null,
    name: toNonEmptyString(requestPayload?.Name) ?? toNonEmptyString(contact?.firstname) ?? null,
  };
}

/**
 * Convierte `contactEmployeeResult.errors` en una lista legible, la loguea contacto por
 * contacto y la deja en `auditTrail.response_SAP.contactEmployeeErrors` para que caiga en el
 * `sapAudit` del WebhookEvent. Devuelve la lista para que el caso de uso la propague en su
 * resultado y el batch pueda avisar a HubSpot.
 *
 * No escribe la clave del audit cuando no hubo fallos, así los eventos sanos siguen
 * guardando exactamente el mismo documento que hoy.
 */
export function recordContactEmployeeFailures({
  contactEmployeeResult,
  auditTrail,
  logger,
  cardCode = null,
  dealId = null,
} = {}) {
  const rawErrors = Array.isArray(contactEmployeeResult?.errors)
    ? contactEmployeeResult.errors
    : [];

  if (rawErrors.length === 0) {
    return [];
  }

  const failures = rawErrors.map((entry) => ({
    ...resolveFailureIdentity(entry),
    message: resolveErrorMessageText(entry?.error),
  }));

  for (const failure of failures) {
    logger?.error?.({
      msg: 'ContactEmployee rechazado por SAP: el documento sigue adelante sin el',
      dealId,
      cardCode,
      email: failure.email,
      name: failure.name,
      error: failure.message,
    });
  }

  if (auditTrail?.response_SAP) {
    auditTrail.response_SAP.contactEmployeeErrors = failures;
  }

  return failures;
}

// `lastError` se trunca a 2000 caracteres en error-message.service.js, y CADA mensaje de
// SAP puede venir de ese largo. Sin tope propio, con dos contactos el texto se cortaba
// aguas abajo y se perdía justo el final -- que es donde va la lista. Se acotan las dos
// dimensiones: cuántos contactos se detallan y el largo total.
const MAX_DETAILED_FAILURES = 5;
const MAX_MESSAGE_LENGTH = 2000;

function describeFailure(failure) {
  const who = [failure?.name, failure?.email ? `<${failure.email}>` : null]
    .filter(Boolean)
    .join(' ') || 'contacto sin identificar';
  return `- ${who}: ${failure?.message}`;
}

function buildBody(header, list) {
  const detailed = list.slice(0, MAX_DETAILED_FAILURES).map(describeFailure);
  const omitted = list.length - detailed.length;
  const lines = omitted > 0 ? [...detailed, `- (y ${omitted} más)`] : detailed;
  const body = [header, ...lines].join('\n');

  return body.length > MAX_MESSAGE_LENGTH ? `${body.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : body;
}

/**
 * Mensaje del `PermanentWebhookError` cuando el fallo BLOQUEA el documento (el caso por
 * default). Viaja a `lastError` del WebhookEvent y de ahí a la nota del deal, así que es
 * lo único que va a leer quien tiene que corregir la data: dice explícitamente que no se
 * sincronizó y que hay que reenviar.
 */
export function buildContactEmployeeFailureMessage(failures) {
  const list = Array.isArray(failures) ? failures : [];

  if (list.length === 0) {
    return null;
  }

  const count = list.length === 1 ? '1 contacto' : `${list.length} contactos`;

  return buildBody(
    `No se sincronizó a SAP: SAP rechazó ${count} del negocio. `
    + 'Corregí los datos en HubSpot y volvé a enviar el negocio.',
    list
  );
}

/**
 * Cuerpo de la nota cuando el tenant tiene el BYPASS activo: ahí el documento sí se creó
 * y el evento queda `completed`, así que el texto dice lo contrario que el de bloqueo.
 * Texto plano con un salto por contacto: el notificador ya manda `lastError` en plano y
 * no quiero arriesgar que un `<br>` se vea literal en HubSpot.
 */
export function buildContactEmployeeFailureNote({ failures, docNum = null } = {}) {
  const list = Array.isArray(failures) ? failures : [];

  if (list.length === 0) {
    return null;
  }

  const document = docNum ? `El documento se creó en SAP (DocNum ${docNum})` : 'El documento se creó en SAP';
  const count = list.length === 1
    ? '1 contacto no se creó'
    : `${list.length} contactos no se crearon`;

  return buildBody(`${document}, pero ${count} como ContactEmployee:`, list);
}

export default {
  recordContactEmployeeFailures,
  buildContactEmployeeFailureMessage,
  buildContactEmployeeFailureNote,
};
