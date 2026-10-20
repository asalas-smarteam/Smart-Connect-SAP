import { TICKET_SIDES, hasNewsFor } from '#domain/panel/tickets.js';
import { clientSyncErrorMessage } from '#domain/panel/operationViews.js';
import { clientErrorText } from '#domain/panel/errorText.js';

// Snapshot del contexto para un cliente: se vuelve a sanear al leer, porque los tickets creados
// antes del plan 5 guardaron el texto crudo (lastError con IPs, errorMessage con payloads).
function clientSnapshot(context) {
  const snapshot = context.snapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }
  if (context.type === 'webhookEvent') {
    const { payload, audit, sapAudit, ...rest } = snapshot;
    return { ...rest, lastError: clientErrorText(snapshot.lastError) };
  }
  const { errors, ...rest } = snapshot;
  return { ...rest, errorMessage: clientSyncErrorMessage(snapshot.errorMessage) };
}

// Proyecciones de un ticket hacia el panel (contrato D1 a D5). Las vistas de cliente se arman
// campo por campo y nunca copian internalResolution: no hay forma de que se cuele.

function toIso(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toAttachmentView(attachment) {
  return {
    fileId: attachment.fileId,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
  };
}

function baseItem(ticket, side) {
  return {
    id: ticket.id,
    code: ticket.code,
    title: ticket.title,
    category: ticket.category,
    status: ticket.status,
    createdBy: { name: ticket.createdBy?.name ?? null, role: ticket.createdBy?.role ?? null },
    openedAt: toIso(ticket.openedAt),
    lastActivityAt: toIso(ticket.lastActivityAt),
    resolvedAt: toIso(ticket.resolvedAt),
    reopenCount: ticket.reopenCount ?? 0,
    hasNews: hasNewsFor(ticket, side),
    contextType: ticket.context?.type ?? null,
  };
}

function toMessageView(message) {
  return {
    id: message.id,
    authorType: message.authorType,
    authorName: message.authorName ?? null,
    body: message.body,
    attachments: (message.attachments ?? []).map(toAttachmentView),
    createdAt: toIso(message.createdAt),
  };
}

function toHistoryView(entry) {
  return {
    from: entry.from ?? null,
    to: entry.to,
    byType: entry.byType,
    byName: entry.byName ?? null,
    at: toIso(entry.at),
  };
}

function detail(ticket, side) {
  let snapshot = null;
  if (ticket.context) {
    snapshot = side === TICKET_SIDES.CLIENTE ? clientSnapshot(ticket.context) : (ticket.context.snapshot ?? null);
  }
  return {
    ...baseItem(ticket, side),
    description: ticket.description,
    attachments: (ticket.attachments ?? []).map(toAttachmentView),
    firstResponseAt: toIso(ticket.firstResponseAt),
    context: ticket.context
      ? { type: ticket.context.type, refId: ticket.context.refId, snapshot }
      : null,
    messages: (ticket.messages ?? []).map(toMessageView),
    statusHistory: (ticket.statusHistory ?? []).map(toHistoryView),
  };
}

// D1: ítem de la lista del cliente.
export function toClientListItem(ticket) {
  return baseItem(ticket, TICKET_SIDES.CLIENTE);
}

// D3: detalle del cliente (sin internalResolution).
export function toClientDetail(ticket) {
  return detail(ticket, TICKET_SIDES.CLIENTE);
}

// D2: ítem de la bandeja de Smarteam.
export function toStaffListItem(ticket, tenant) {
  return {
    ...baseItem(ticket, TICKET_SIDES.SMARTEAM),
    tenantKey: tenant.tenantKey,
    companyName: tenant.companyName ?? null,
    firstResponseAt: toIso(ticket.firstResponseAt),
  };
}

// D3: detalle de Smarteam, con la nota interna.
export function toStaffDetail(ticket, tenant) {
  const internal = ticket.internalResolution;
  return {
    ...detail(ticket, TICKET_SIDES.SMARTEAM),
    tenantKey: tenant.tenantKey,
    companyName: tenant.companyName ?? null,
    internalResolution: internal
      ? {
        text: internal.text,
        updatedAt: toIso(internal.updatedAt),
        updatedBy: { name: internal.updatedBy?.name ?? null },
      }
      : null,
  };
}
