import { TICKET_LIMITS, checkRequiredText } from '#domain/panel/tickets.js';
import { detectImageType, safeAttachmentFilename } from '#domain/panel/imageType.js';
import { fail, panelReasons, validationError } from './panelReasons.js';

// Piezas compartidas por los casos de uso de tickets de cliente y de Smarteam.

export function systemClock() {
  return new Date();
}

// Texto obligatorio: { ok: true, text } o el fallo validation_error con un mensaje legible.
export function requireText(value, { label, max = TICKET_LIMITS.TEXT_MAX }) {
  const checked = checkRequiredText(value, { label, max });
  return checked.message ? validationError(checked.message) : { ok: true, text: checked.text };
}

// images: [{ filename, data }]. Cantidad, tamaño y tipo por los primeros bytes (contrato D9).
export function checkImages(images = []) {
  const list = Array.isArray(images) ? images : [];
  if (list.length > TICKET_LIMITS.MAX_IMAGES) {
    return fail(panelReasons.TOO_MANY_IMAGES, `Máximo ${TICKET_LIMITS.MAX_IMAGES} imágenes por mensaje.`);
  }

  const checked = [];
  for (const image of list) {
    const data = image?.data;
    if (data && data.length > TICKET_LIMITS.MAX_IMAGE_BYTES) {
      return fail(panelReasons.IMAGE_TOO_LARGE, 'Cada imagen puede pesar hasta 5 MB.');
    }
    const contentType = data ? detectImageType(data) : null;
    if (!contentType) {
      return fail(panelReasons.INVALID_IMAGE, 'Solo se aceptan imágenes PNG, JPEG o WebP.');
    }
    checked.push({ filename: safeAttachmentFilename(image.filename, contentType), contentType, data });
  }

  return { ok: true, images: checked };
}

// Sube las imágenes ya validadas. Si una falla, borra las que alcanzó a subir y relanza.
export async function storeImages(attachmentStore, tenantKey, ticketId, images) {
  const stored = [];
  try {
    for (const image of images) {
      stored.push(await attachmentStore.put(tenantKey, { ticketId, ...image }));
    }
  } catch (error) {
    await removeImages(attachmentStore, tenantKey, stored);
    throw error;
  }
  return stored;
}

export async function removeImages(attachmentStore, tenantKey, attachments) {
  if (attachments.length === 0) {
    return;
  }
  try {
    await attachmentStore.remove(tenantKey, attachments.map((attachment) => attachment.fileId));
  } catch (error) {
    // El adaptador ya loguea; la limpieza nunca cambia la respuesta.
  }
}

// Aplica un cambio con compare-and-set sobre el estado. Si no se pudo (el ticket cambió de
// estado en el medio o ya no existe), borra las imágenes subidas para ese cambio.
export async function applyTicketChange({ ticketRepository, attachmentStore, tenantKey, ticket, change, uploaded = [] }) {
  let updated;
  try {
    updated = await ticketRepository.update(tenantKey, ticket.id, { expectedStatus: ticket.status, ...change });
  } catch (error) {
    await removeImages(attachmentStore, tenantKey, uploaded);
    throw error;
  }

  if (updated) {
    return { ok: true, ticket: updated };
  }

  await removeImages(attachmentStore, tenantKey, uploaded);
  const current = await ticketRepository.findById(tenantKey, ticket.id);
  return current ? fail(panelReasons.INVALID_TRANSITION) : fail(panelReasons.NOT_FOUND);
}

export function findTicketAttachment(ticket, fileId) {
  const all = [
    ...(ticket.attachments ?? []),
    ...(ticket.messages ?? []).flatMap((message) => message.attachments ?? []),
  ];
  return all.find((attachment) => attachment.fileId === fileId) ?? null;
}

// Archivo del ticket: primero se confirma que el fileId está en el ticket, después el almacén
// vuelve a exigir que sea de ese ticket.
export async function openTicketAttachment({ attachmentStore, tenantKey, ticket, fileId }) {
  if (typeof fileId !== 'string' || !findTicketAttachment(ticket, fileId)) {
    return fail(panelReasons.NOT_FOUND);
  }
  const file = await attachmentStore.open(tenantKey, { ticketId: ticket.id, fileId });
  return file ? { ok: true, data: file } : fail(panelReasons.NOT_FOUND);
}

export function historyEntry({ from, to, side, user, at }) {
  return {
    from,
    to,
    byType: side,
    byId: user?.id ? String(user.id) : null,
    byName: user?.name ?? null,
    at,
  };
}

export function messageEntry({ id, side, user, body, attachments, at }) {
  return {
    id,
    authorType: side,
    authorId: user?.id ? String(user.id) : null,
    authorName: user?.name ?? null,
    body,
    attachments,
    createdAt: at,
  };
}

export function laterDate(current, next) {
  if (!current) {
    return next;
  }
  return new Date(current).getTime() >= next.getTime() ? current : next;
}
