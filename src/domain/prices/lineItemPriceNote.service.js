import { toNonEmptyString } from '#shared/utils/string.utils.js';

// Cuerpo de la nota que se deja en el negocio de HubSpot con el resultado de la valorización.
// Es el ÚNICO canal por el que el asesor se entera de por qué una línea quedó sin precio: el
// audit del WebhookEvent y el SyncLog viven en Mongo y no los ve nadie fuera de soporte.
//
// Puro a propósito (ni HubSpot ni Mongo acá): el texto es lo que hay que poder revisar sin
// levantar nada, y así el caso de uso no tiene que armar HTML.

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function describeSalesArea(salesArea) {
  return [
    salesArea?.salesOrganization,
    salesArea?.distributionChannel,
    salesArea?.division,
  ].map((part) => toNonEmptyString(part) ?? '-').join('/');
}

function buildContextLine({ customer, salesArea, priceListType, salesAreaSource }) {
  const parts = [];

  if (toNonEmptyString(customer)) {
    parts.push(`Cliente SAP: ${escapeHtml(customer)}`);
  }

  if (salesArea) {
    parts.push(`Área de ventas: ${escapeHtml(describeSalesArea(salesArea))}`);
  }

  if (toNonEmptyString(priceListType)) {
    parts.push(`Lista de precios: ${escapeHtml(priceListType)}`);
  }

  if (parts.length === 0) {
    return '';
  }

  let line = `<p>${parts.join(' &middot; ')}</p>`;

  // El asesor tiene que saber que el precio NO salió de la ficha del cliente: si el cliente no
  // tiene área de ventas en SAP (o su código no existe allá), el precio es el de la lista por
  // defecto y puede no ser el que le corresponde negociado.
  if (salesAreaSource === 'configuredDefault') {
    line += '<p>El cliente no tiene área de ventas registrada en SAP, así que se usaron el área'
      + ' y la lista de precios configuradas por defecto. Verificá el código SAP del cliente.</p>';
  }

  return line;
}

function buildSkippedList(skippedLineItems) {
  const items = skippedLineItems
    .map((item) => {
      const code = toNonEmptyString(item?.itemCode);
      const reason = toNonEmptyString(item?.reason) ?? 'sin precio en SAP';
      const label = code ? `<strong>${escapeHtml(code)}</strong>` : 'Línea sin código de producto';
      return `<li>${label}: ${escapeHtml(reason)}</li>`;
    })
    .join('');

  return `<p>Estas líneas quedaron sin precio:</p><ul>${items}</ul>`;
}

/**
 * Devuelve el HTML de la nota, o `null` cuando no hay nada que contarle al asesor (todas las
 * líneas se valorizaron y no hubo error). Devolver null y no un texto vacío es a propósito: el
 * llamador usa eso para no crear una nota por cada corrida exitosa.
 */
export function buildLineItemPriceNoteBody({
  customer = null,
  salesArea = null,
  salesAreaSource = null,
  priceListType = null,
  updatedCount = 0,
  skippedLineItems = [],
  fatalErrorMessage = null,
} = {}) {
  const skipped = Array.isArray(skippedLineItems) ? skippedLineItems : [];
  const fatal = toNonEmptyString(fatalErrorMessage);

  if (!fatal && skipped.length === 0) {
    return null;
  }

  const context = buildContextLine({ customer, salesArea, priceListType, salesAreaSource });

  if (fatal) {
    return '<p><strong>Precios de SAP: no se pudieron actualizar</strong></p>'
      + context
      + `<p>Motivo: ${escapeHtml(fatal)}</p>`
      + (skipped.length > 0 ? buildSkippedList(skipped) : '')
      + '<p>Las líneas del negocio quedaron con el precio que ya tenían.</p>';
  }

  return '<p><strong>Precios de SAP: actualización parcial</strong></p>'
    + context
    + `<p>${updatedCount} de ${updatedCount + skipped.length} líneas se actualizaron con el`
    + ' precio de SAP.</p>'
    + buildSkippedList(skipped);
}

export default { buildLineItemPriceNoteBody };
