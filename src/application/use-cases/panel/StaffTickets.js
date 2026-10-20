import {
  TICKET_SIDES,
  TICKET_STATUSES,
  canResolve,
  canStaffSetStatus,
  statusAfterStaffMessage,
} from '#domain/panel/tickets.js';
import { fail, panelReasons } from './panelReasons.js';
import { toStaffDetail } from './ticketView.js';
import {
  applyTicketChange,
  checkImages,
  historyEntry,
  laterDate,
  messageEntry,
  openTicketAttachment,
  requireText,
  storeImages,
  systemClock,
} from './ticketCommon.js';

const SIDE = TICKET_SIDES.SMARTEAM;

// Acciones de Smarteam sobre el ticket de una empresa. El :tenantKey de la ruta se valida
// contra el directorio de empresas (SaaSClients) ANTES de tocar la base del tenant: un tenantKey
// inventado da not_found y nunca abre una conexión.
export class StaffTickets {
  constructor({ ticketRepository, attachmentStore, tenantDirectory, now = systemClock }) {
    this.ticketRepository = ticketRepository;
    this.attachmentStore = attachmentStore;
    this.tenantDirectory = tenantDirectory;
    this.now = now;
  }

  async load(tenantKey, id) {
    if (typeof tenantKey !== 'string' || !tenantKey || typeof id !== 'string') {
      return fail(panelReasons.NOT_FOUND);
    }
    const tenant = await this.tenantDirectory.findByKey(tenantKey);
    if (!tenant) {
      return fail(panelReasons.NOT_FOUND);
    }
    const ticket = await this.ticketRepository.findById(tenant.tenantKey, id);
    if (!ticket) {
      return fail(panelReasons.NOT_FOUND);
    }
    return { ok: true, tenant, ticket };
  }

  change(tenant, ticket, change, uploaded = []) {
    return applyTicketChange({
      ticketRepository: this.ticketRepository,
      attachmentStore: this.attachmentStore,
      tenantKey: tenant.tenantKey,
      ticket,
      change,
      uploaded,
    });
  }

  async get({ tenantKey, id }) {
    const loaded = await this.load(tenantKey, id);
    if (!loaded.ok) {
      return loaded;
    }
    const { tenant, ticket } = loaded;
    const at = this.now();
    await this.ticketRepository.markSeen(tenant.tenantKey, ticket.id, SIDE, at);
    const seen = { ...ticket, staffLastSeenAt: laterDate(ticket.staffLastSeenAt, at) };
    return { ok: true, data: toStaffDetail(seen, tenant) };
  }

  // Responder. El primer mensaje sobre un ticket abierto lo pasa a en_progreso, y el primer
  // mensaje de Smarteam fija firstResponseAt.
  async reply({ user, tenantKey, id, fields = {}, images = [] }) {
    const loaded = await this.load(tenantKey, id);
    if (!loaded.ok) {
      return loaded;
    }
    const { tenant, ticket } = loaded;
    const nextStatus = statusAfterStaffMessage(ticket.status);
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

    const at = this.now();
    const attachments = await storeImages(this.attachmentStore, tenant.tenantKey, ticket.id, checkedImages.images);
    const changesStatus = nextStatus !== ticket.status;
    const result = await this.change(tenant, ticket, {
      set: {
        lastActivityAt: at,
        lastPublicAuthorType: SIDE,
        staffLastSeenAt: at,
        ...(changesStatus ? { status: nextStatus } : {}),
      },
      setIfNull: { firstResponseAt: at },
      pushMessage: messageEntry({ id: this.ticketRepository.newId(), side: SIDE, user, body: body.text, attachments, at }),
      pushHistory: changesStatus
        ? [historyEntry({ from: ticket.status, to: nextStatus, side: SIDE, user, at })]
        : [],
    }, attachments);
    return result.ok ? { ok: true, statusCode: 201, data: toStaffDetail(result.ticket, tenant) } : result;
  }

  // Cambio manual: en_progreso → esperando_cliente y resuelto → en_progreso. Lo demás, 409.
  async setStatus({ user, tenantKey, id, to }) {
    const loaded = await this.load(tenantKey, id);
    if (!loaded.ok) {
      return loaded;
    }
    const { tenant, ticket } = loaded;
    if (!canStaffSetStatus(ticket.status, to)) {
      return fail(panelReasons.INVALID_TRANSITION);
    }

    const at = this.now();
    const result = await this.change(tenant, ticket, {
      set: { status: to, lastActivityAt: at },
      pushHistory: [historyEntry({ from: ticket.status, to, side: SIDE, user, at })],
    });
    return result.ok ? { ok: true, data: toStaffDetail(result.ticket, tenant) } : result;
  }

  // Resolver: exige el mensaje al cliente y la resolución interna.
  async resolve({ user, tenantKey, id, fields = {}, images = [] }) {
    const loaded = await this.load(tenantKey, id);
    if (!loaded.ok) {
      return loaded;
    }
    const { tenant, ticket } = loaded;
    if (!canResolve(ticket.status)) {
      return fail(panelReasons.INVALID_TRANSITION);
    }
    const message = requireText(fields.message, { label: 'El mensaje al cliente' });
    if (!message.ok) {
      return message;
    }
    const internal = requireText(fields.internalResolution, { label: 'La resolución interna' });
    if (!internal.ok) {
      return internal;
    }
    const checkedImages = checkImages(images);
    if (!checkedImages.ok) {
      return checkedImages;
    }

    const at = this.now();
    const attachments = await storeImages(this.attachmentStore, tenant.tenantKey, ticket.id, checkedImages.images);
    const result = await this.change(tenant, ticket, {
      set: {
        status: TICKET_STATUSES.RESUELTO,
        resolvedAt: at,
        lastActivityAt: at,
        lastPublicAuthorType: SIDE,
        staffLastSeenAt: at,
        internalResolution: {
          text: internal.text,
          updatedAt: at,
          updatedBy: { userId: String(user.id), name: user.name ?? null },
        },
      },
      setIfNull: { firstResponseAt: at },
      pushMessage: messageEntry({ id: this.ticketRepository.newId(), side: SIDE, user, body: message.text, attachments, at }),
      pushHistory: [historyEntry({ from: ticket.status, to: TICKET_STATUSES.RESUELTO, side: SIDE, user, at })],
    }, attachments);
    return result.ok ? { ok: true, data: toStaffDetail(result.ticket, tenant) } : result;
  }

  // Completar o corregir la nota interna, en cualquier estado. Si el estado cambió en el medio,
  // se reintenta una vez con el estado nuevo (la nota no depende del estado).
  async setInternalResolution({ user, tenantKey, id, text }) {
    const loaded = await this.load(tenantKey, id);
    if (!loaded.ok) {
      return loaded;
    }
    const { tenant } = loaded;
    const checked = requireText(text, { label: 'La resolución interna' });
    if (!checked.ok) {
      return checked;
    }

    const set = {
      internalResolution: {
        text: checked.text,
        updatedAt: this.now(),
        updatedBy: { userId: String(user.id), name: user.name ?? null },
      },
    };
    let ticket = loaded.ticket;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.change(tenant, ticket, { set });
      if (result.ok || result.reason !== panelReasons.INVALID_TRANSITION) {
        return result.ok ? { ok: true, data: toStaffDetail(result.ticket, tenant) } : result;
      }
      ticket = await this.ticketRepository.findById(tenant.tenantKey, ticket.id);
      if (!ticket) {
        return fail(panelReasons.NOT_FOUND);
      }
    }
    return fail(panelReasons.INVALID_TRANSITION);
  }

  async attachment({ tenantKey, id, fileId }) {
    const loaded = await this.load(tenantKey, id);
    if (!loaded.ok) {
      return loaded;
    }
    return openTicketAttachment({
      attachmentStore: this.attachmentStore,
      tenantKey: loaded.tenant.tenantKey,
      ticket: loaded.ticket,
      fileId,
    });
  }
}

export default StaffTickets;
