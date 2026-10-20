import {
  TICKET_CONTEXT_TYPES,
  TICKET_LIMITS,
  TICKET_SIDES,
  TICKET_STATUSES,
  isTicketCategory,
  isTicketContextType,
  isTicketStatus,
  statusAfterClientMessage,
  statusAfterReopen,
  ticketCode,
} from '#domain/panel/tickets.js';
import { toEventView, toSyncView } from '#domain/panel/operationViews.js';
import { fail, panelReasons, validationError } from './panelReasons.js';
import { parsePagination } from './pagination.js';
import { toClientDetail, toClientListItem } from './ticketView.js';
import {
  applyTicketChange,
  checkImages,
  historyEntry,
  laterDate,
  messageEntry,
  openTicketAttachment,
  removeImages,
  requireText,
  storeImages,
  systemClock,
} from './ticketCommon.js';

const SIDE = TICKET_SIDES.CLIENTE;

// Tickets de una cuenta cliente. El tenant sale SIEMPRE de la sesión (user.tenantKey): ningún
// método recibe un tenantKey de afuera. Un ticket de otro tenant da not_found, como uno que no
// existe. Las respuestas usan las vistas de cliente, que nunca traen internalResolution.
export class ClientTickets {
  constructor({ ticketRepository, attachmentStore, contextReader, tenantDbPrefix = '', now = systemClock }) {
    this.ticketRepository = ticketRepository;
    this.attachmentStore = attachmentStore;
    this.contextReader = contextReader;
    this.tenantDbPrefix = tenantDbPrefix;
    this.now = now;
  }

  async loadTicket(user, id) {
    if (!user?.tenantKey || typeof id !== 'string') {
      return null;
    }
    return this.ticketRepository.findById(user.tenantKey, id);
  }

  async list({ user, query = {} }) {
    if (!user?.tenantKey) {
      return fail(panelReasons.NOT_FOUND);
    }
    const pagination = parsePagination(query);
    if (!pagination.ok) {
      return pagination;
    }
    const { status, category } = query;
    if (status !== undefined && status !== '' && !isTicketStatus(status)) {
      return validationError('Estado inválido.');
    }
    if (category !== undefined && category !== '' && !isTicketCategory(category)) {
      return validationError('Categoría inválida.');
    }

    const { page, pageSize } = pagination;
    const { items, total } = await this.ticketRepository.list(user.tenantKey, {
      status: status || undefined,
      category: category || undefined,
      skip: (page - 1) * pageSize,
      limit: pageSize,
    });
    return { ok: true, data: { items: items.map(toClientListItem), page, pageSize, total } };
  }

  async readContext(tenantKey, contextType, contextId) {
    if (contextType === TICKET_CONTEXT_TYPES.WEBHOOK_EVENT) {
      const snapshot = toEventView(await this.contextReader.readEvent(tenantKey, contextId));
      return snapshot ? { type: contextType, refId: snapshot.id, snapshot } : null;
    }
    const found = await this.contextReader.readSync(tenantKey, contextId);
    const snapshot = found ? toSyncView(found.sync, found.task) : null;
    return snapshot ? { type: contextType, refId: snapshot.id, snapshot } : null;
  }

  async create({ user, fields = {}, images = [] }) {
    if (!user?.tenantKey) {
      return fail(panelReasons.NOT_FOUND);
    }
    const tenantKey = user.tenantKey;

    const title = requireText(fields.title, { label: 'El título', max: TICKET_LIMITS.TITLE_MAX });
    if (!title.ok) {
      return title;
    }
    const description = requireText(fields.description, { label: 'La descripción' });
    if (!description.ok) {
      return description;
    }
    if (!isTicketCategory(fields.category)) {
      return validationError('Elige una categoría.');
    }

    let context = null;
    const { contextType, contextId } = fields;
    if (contextType || contextId) {
      if (!isTicketContextType(contextType) || typeof contextId !== 'string' || !contextId) {
        return validationError('Contexto inválido.');
      }
      // Solo registros del tenant de la sesión; si no está ahí, 404 (no se confirma que exista).
      context = await this.readContext(tenantKey, contextType, contextId);
      if (!context) {
        return fail(panelReasons.NOT_FOUND);
      }
    }

    const checkedImages = checkImages(images);
    if (!checkedImages.ok) {
      return checkedImages;
    }

    const at = this.now();
    const id = this.ticketRepository.newId();
    const attachments = await storeImages(this.attachmentStore, tenantKey, id, checkedImages.images);

    let ticket;
    try {
      ticket = await this.ticketRepository.create(tenantKey, {
        id,
        title: title.text,
        description: description.text,
        category: fields.category,
        status: TICKET_STATUSES.ABIERTO,
        context,
        createdBy: { userId: String(user.id), name: user.name ?? null, role: user.role ?? null },
        attachments,
        messages: [],
        internalResolution: null,
        statusHistory: [historyEntry({ from: null, to: TICKET_STATUSES.ABIERTO, side: SIDE, user, at })],
        openedAt: at,
        firstResponseAt: null,
        resolvedAt: null,
        reopenCount: 0,
        lastActivityAt: at,
        lastPublicAuthorType: SIDE,
        clientLastSeenAt: at,
        staffLastSeenAt: null,
      }, {
        codeFor: (number) => ticketCode(tenantKey, number, this.tenantDbPrefix),
      });
    } catch (error) {
      await removeImages(this.attachmentStore, tenantKey, attachments);
      throw error;
    }

    return { ok: true, statusCode: 201, data: toClientDetail(ticket) };
  }

  async get({ user, id }) {
    const ticket = await this.loadTicket(user, id);
    if (!ticket) {
      return fail(panelReasons.NOT_FOUND);
    }

    const at = this.now();
    await this.ticketRepository.markSeen(user.tenantKey, ticket.id, SIDE, at);
    const seen = { ...ticket, clientLastSeenAt: laterDate(ticket.clientLastSeenAt, at) };
    return { ok: true, data: toClientDetail(seen) };
  }

  async reply({ user, id, fields = {}, images = [] }) {
    const ticket = await this.loadTicket(user, id);
    if (!ticket) {
      return fail(panelReasons.NOT_FOUND);
    }
    // Un ticket resuelto se reabre con "Sigue fallando", no con un mensaje.
    const nextStatus = statusAfterClientMessage(ticket.status);
    if (!nextStatus) {
      return fail(panelReasons.INVALID_TRANSITION);
    }

    const body = requireText(fields.body, { label: 'El mensaje' });
    if (!body.ok) {
      return body;
    }
    const checkedImages = checkImages(images);
    if (!checkedImages.ok) {
      return checkedImages;
    }

    const tenantKey = user.tenantKey;
    const at = this.now();
    const attachments = await storeImages(this.attachmentStore, tenantKey, ticket.id, checkedImages.images);
    const change = {
      set: {
        lastActivityAt: at,
        lastPublicAuthorType: SIDE,
        clientLastSeenAt: at,
        ...(nextStatus !== ticket.status ? { status: nextStatus } : {}),
      },
      pushMessage: messageEntry({
        id: this.ticketRepository.newId(),
        side: SIDE,
        user,
        body: body.text,
        attachments,
        at,
      }),
      pushHistory: nextStatus !== ticket.status
        ? [historyEntry({ from: ticket.status, to: nextStatus, side: SIDE, user, at })]
        : [],
    };

    const result = await applyTicketChange({
      ticketRepository: this.ticketRepository,
      attachmentStore: this.attachmentStore,
      tenantKey,
      ticket,
      change,
      uploaded: attachments,
    });
    return result.ok ? { ok: true, statusCode: 201, data: toClientDetail(result.ticket) } : result;
  }

  async reopen({ user, id, message }) {
    const ticket = await this.loadTicket(user, id);
    if (!ticket) {
      return fail(panelReasons.NOT_FOUND);
    }
    const nextStatus = statusAfterReopen(ticket.status);
    if (!nextStatus) {
      return fail(panelReasons.INVALID_TRANSITION);
    }
    const text = requireText(message, { label: 'El mensaje' });
    if (!text.ok) {
      return text;
    }

    const at = this.now();
    const result = await applyTicketChange({
      ticketRepository: this.ticketRepository,
      attachmentStore: this.attachmentStore,
      tenantKey: user.tenantKey,
      ticket,
      change: {
        set: {
          status: nextStatus,
          lastActivityAt: at,
          lastPublicAuthorType: SIDE,
          clientLastSeenAt: at,
        },
        inc: { reopenCount: 1 },
        pushMessage: messageEntry({
          id: this.ticketRepository.newId(),
          side: SIDE,
          user,
          body: text.text,
          attachments: [],
          at,
        }),
        pushHistory: [historyEntry({ from: ticket.status, to: nextStatus, side: SIDE, user, at })],
      },
    });
    return result.ok ? { ok: true, data: toClientDetail(result.ticket) } : result;
  }

  async attachment({ user, id, fileId }) {
    const ticket = await this.loadTicket(user, id);
    if (!ticket) {
      return fail(panelReasons.NOT_FOUND);
    }
    return openTicketAttachment({ attachmentStore: this.attachmentStore, tenantKey: user.tenantKey, ticket, fileId });
  }
}

export default ClientTickets;
