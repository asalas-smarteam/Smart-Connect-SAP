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

function buildContextLine({ customer, salesArea, priceListType }) {
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

  return `<p>${parts.join(' &middot; ')}</p>`;
}

// Áreas que el cliente SÍ tiene en SAP. Es lo único que le dice al asesor qué poner en el
// negocio, así que cuando no se pudieron leer se omite la frase entera en lugar de dejar un
// "las áreas son:" colgando.
function buildCustomerSalesAreasLine(customerSalesAreas) {
  const described = (Array.isArray(customerSalesAreas) ? customerSalesAreas : [])
    .map((area) => {
      const org = toNonEmptyString(area?.salesOrganization);
      const channel = toNonEmptyString(area?.distributionChannel);

      if (!org || !channel) {
        return null;
      }

      const list = toNonEmptyString(area?.priceListType);
      return `${org}/${channel}${list ? ` (lista ${list})` : ''}`;
    })
    .filter(Boolean);

  if (described.length === 0) {
    return '';
  }

  return '<p>Las áreas de ventas que este cliente tiene en SAP son:'
    + ` ${escapeHtml(described.join(', '))}.</p>`;
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
  priceListType = null,
  updatedCount = 0,
  skippedLineItems = [],
  fatalErrorMessage = null,
  reasonCode = null,
  customerSalesAreas = [],
} = {}) {
  const skipped = Array.isArray(skippedLineItems) ? skippedLineItems : [];
  const fatal = toNonEmptyString(fatalErrorMessage);

  if (!fatal && skipped.length === 0) {
    return null;
  }

  const context = buildContextLine({ customer, salesArea, priceListType });

  // El negocio no trae organización o canal. Los precios NO se tocaron (sin área no se consultó
  // nada en SAP), así que la nota no puede afirmar nada sobre las líneas: sólo pide el campo.
  if (reasonCode === 'salesAreaMissing') {
    return '<p><strong>Precios de SAP: falta la organización de ventas</strong></p>'
      + context
      + '<p>Este negocio no tiene Organización o Canal de distribución. Completá los dos campos y'
      + ' volvé a guardar una línea para recalcular los precios.</p>'
      + '<p>Los precios de las líneas quedaron como estaban.</p>';
  }

  // El cliente no está registrado en el área que declara el negocio. Acá los precios SÍ se
  // pusieron en 0, y la nota tiene que decirlo junto con las áreas reales del cliente.
  if (reasonCode === 'salesAreaNotFound') {
    return '<p><strong>Precios de SAP: el cliente no está registrado en esta área de ventas</strong></p>'
      + context
      + buildCustomerSalesAreasLine(customerSalesAreas)
      + '<p>Los precios de las líneas se pusieron en 0. Corregí la organización de ventas del'
      + ' negocio, o pedí que se registre el cliente en esta área en SAP.</p>';
  }

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
