import {
  TICKET_SIDES,
  TICKET_STATUSES,
  canResolve,
  parseTicketCode,
  statusAfterStaffMessage,
  ticketCodePrefix,
} from '#domain/panel/tickets.js';
import {
  checkIdempotencyKey,
  checkWorkLogInput,
  toWorkLogEntryView,
  workLogFingerprintSource,
} from '#domain/panel/workLog.js';
import { AUDIT_ACTIONS } from '#domain/panel/auditActions.js';
import { fail, panelReasons, validationError } from './panelReasons.js';
import { NO_AUDIT_LOG, recordAudit, actorOf, buildAuditEntry } from './panelAudit.js';
import { historyEntry, messageEntry, systemClock } from './ticketCommon.js';

const SIDE = TICKET_SIDES.SMARTEAM;
const SESSION_AUTH = Object.freeze({ via: 'session', tokenId: null, prefix: null });
// Un pending más nuevo que esto es otro request en curso; uno más viejo está abandonado (M5).
const PENDING_STALE_MS = 60 * 1000;
const CREATED_STATUS = 201;
const RESOLVED_MESSAGE = 'El ticket ya está resuelto. Pásalo a en progreso desde el panel para registrar más trabajo.';

function toIso(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toMs(value) {
  return (value instanceof Date ? value : new Date(value)).getTime();
}

function findEntry(ticket, predicate) {
  return (ticket?.workLog ?? []).find(predicate) ?? null;
}

function entryId(entry) {
  return String(entry.id ?? entry._id);
}

// Cuerpo del 201 (M5). Sale igual en la publicación y en el replay: ticket.status es el estado
// justo después de esa publicación (statusAfter), no el actual.
function createdResponse(entry) {
  return {
    ok: true,
    statusCode: CREATED_STATUS,
    data: { entry: toWorkLogEntryView(entry), ticket: { status: entry.statusAfter } },
  };
}

// Registro de trabajo de Smarteam desde la skill de Claude (contrato 12, M4 y M5): buscar un
// ticket por su código y publicar un resumen público con horas internas, con idempotencia.
export class StaffWorkLog {
  constructor({
    ticketRepository,
    tenantDirectory,
    idempotencyStore,
    apiTokenCodec,
    tenantDbPrefix = '',
    auditLog = NO_AUDIT_LOG,
    logger = null,
    now = systemClock,
  }) {
    this.ticketRepository = ticketRepository;
    this.tenantDirectory = tenantDirectory;
    this.idempotencyStore = idempotencyStore;
    // Solo para el SHA-256 de la huella de idempotencia.
    this.apiTokenCodec = apiTokenCodec;
    this.tenantDbPrefix = tenantDbPrefix;
    this.auditLog = auditLog;
    this.logger = logger;
    this.now = now;
  }

  // Código → { ok, tenant, ticket } (M4). Solo se abren tenants que salieron del directorio y
  // cuyo prefijo coincide; en cada uno se busca por número y se confirma el código guardado.
  async resolveCode(code) {
    const parsed = parseTicketCode(code);
    if (!parsed) {
      return fail(panelReasons.NOT_FOUND);
    }

    const tenants = (await this.tenantDirectory.listAll())
      .filter((tenant) => ticketCodePrefix(tenant.tenantKey, this.tenantDbPrefix) === parsed.prefix);
    const found = await Promise.all(tenants.map(async (tenant) => {
      const ticket = await this.ticketRepository.findByNumber(tenant.tenantKey, parsed.number);
      return ticket && ticket.code === parsed.code ? { tenant, ticket } : null;
    }));
    const matches = found.filter(Boolean);

    if (matches.length === 0) {
      return fail(panelReasons.NOT_FOUND);
    }
    if (matches.length > 1) {
      this.logger?.warn?.({
        msg: 'Panel work log: ambiguous ticket code',
        code: parsed.code,
        tenantKeys: matches.map(({ tenant }) => tenant.tenantKey),
      });
      return fail(panelReasons.AMBIGUOUS_CODE);
    }
    return { ok: true, tenant: matches[0].tenant, ticket: matches[0].ticket };
  }

  // GET …/by-code/:code. No marca el ticket como visto por Smarteam.
  async findByCode({ code } = {}) {
    const resolved = await this.resolveCode(code);
    if (!resolved.ok) {
      return resolved;
    }
    const { tenant, ticket } = resolved;
    return {
      ok: true,
      data: {
        tenantKey: tenant.tenantKey,
        id: ticket.id,
        code: ticket.code,
        title: ticket.title,
        companyName: tenant.companyName ?? null,
        status: ticket.status,
        openedAt: toIso(ticket.openedAt),
      },
    };
  }

  // POST …/by-code/:code/work-log (M5, pasos 1 a 7). auth = { via: 'token' | 'session',
  // tokenId, prefix } lo deja el guard; con cookie es { via: 'session' }.
  async publish({ user, auth = SESSION_AUTH, code, body, idempotencyKey, ip = null } = {}) {
    // Paso 1: validar y normalizar todo antes de tocar el registro de claves o el ticket.
    const keyCheck = checkIdempotencyKey(idempotencyKey);
    if (!keyCheck.ok) {
      return validationError(keyCheck.message);
    }
    const checked = checkWorkLogInput(body);
    if (!checked.ok) {
      return validationError(checked.message);
    }

    const via = auth?.via === 'token' ? 'token' : 'session';
    const context = {
      user,
      via,
      tokenId: via === 'token' ? String(auth.tokenId) : null,
      tokenPrefix: via === 'token' ? (auth.prefix ?? null) : null,
      input: checked.input,
      at: this.now(),
      ip,
      reservation: null,
      guardKey: null,
      fingerprint: null,
    };

    // Sin Idempotency-Key no hay deduplicación: dos llamadas crean dos entradas.
    if (!keyCheck.key) {
      return this.#publishTicket(code, context);
    }

    const ownerKey = via === 'token' ? `token:${context.tokenId}` : `user:${String(user.id)}`;
    const key = keyCheck.key;
    const fingerprint = this.apiTokenCodec.hash(workLogFingerprintSource({ code, input: checked.input }));

    // Paso 2.
    const claim = await this.#claim({ ownerKey, key, fingerprint, at: context.at });
    if (claim.done) {
      return this.#replay(claim.done);
    }
    if (!claim.ok) {
      return claim;
    }

    context.reservation = { ownerKey, key, createdAt: claim.createdAt };
    context.guardKey = `${ownerKey}:${key}`;
    context.fingerprint = fingerprint;

    // Paso 7: si después de reservar sale un 4xx o una excepción, se libera la reserva.
    let result;
    try {
      result = await this.#publishTicket(code, context);
    } catch (error) {
      await this.#release(context.reservation);
      throw error;
    }
    if (!result.ok) {
      await this.#release(context.reservation);
    }
    return result;
  }

  // Paso 2 de M5. Devuelve { ok: true, createdAt } (reserva propia), { done: registro } (replay)
  // o el fallo (422 o 409).
  async #claim({ ownerKey, key, fingerprint, at }, retried = false) {
    // Con la hora del request: una clave vencida que el índice TTL aún no borró no cuenta.
    const existing = await this.idempotencyStore.find({ ownerKey, key, now: at });

    if (!existing) {
      const reserved = await this.idempotencyStore.reserve({ ownerKey, key, fingerprint, at });
      if (reserved) {
        return { ok: true, createdAt: reserved.createdAt };
      }
      // Otro request insertó la misma clave en el medio: se vuelve a leer, una vez.
      return retried
        ? fail(panelReasons.REQUEST_IN_PROGRESS)
        : this.#claim({ ownerKey, key, fingerprint, at }, true);
    }

    if (existing.fingerprint !== fingerprint) {
      return fail(panelReasons.IDEMPOTENCY_KEY_REUSED);
    }
    if (existing.state === 'done') {
      return { done: existing };
    }

    const staleBefore = new Date(toMs(at) - PENDING_STALE_MS);
    if (toMs(existing.createdAt) > staleBefore.getTime()) {
      return fail(panelReasons.REQUEST_IN_PROGRESS);
    }
    // Pending abandonado: se retoma. Si otro lo retomó primero, está en curso.
    const taken = await this.idempotencyStore.takeOver({ ownerKey, key, fingerprint, staleBefore, at });
    return taken ? { ok: true, createdAt: taken.createdAt } : fail(panelReasons.REQUEST_IN_PROGRESS);
  }

  // Pasos 3 a 5.
  async #publishTicket(code, context) {
    const resolved = await this.resolveCode(code);
    if (!resolved.ok) {
      return resolved;
    }
    const { tenant } = resolved;
    let { ticket } = resolved;

    // Primer intento y, si la escritura no aplicó, un solo reintento con el ticket releído.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Paso 4, red de seguridad antes de evaluar transiciones: el intento anterior ya escribió.
      // Si la entrada guardó otra huella (la clave se reusó con otro cuerpo, por ejemplo pasadas
      // las 24 h) es 422; publish libera la reserva propia. Sin huella (entradas anteriores), como
      // antes.
      if (context.guardKey) {
        const previous = findEntry(ticket, (entry) => entry.idempotencyKey === context.guardKey);
        if (previous?.idempotencyFingerprint && previous.idempotencyFingerprint !== context.fingerprint) {
          return fail(panelReasons.IDEMPOTENCY_KEY_REUSED);
        }
        if (previous) {
          await this.#complete(context, tenant.tenantKey, ticket.id, previous);
          return createdResponse(previous);
        }
      }

      const plan = this.#plan(ticket, context);
      if (!plan) {
        return fail(panelReasons.INVALID_TRANSITION, RESOLVED_MESSAGE);
      }

      const updated = await this.ticketRepository.update(tenant.tenantKey, ticket.id, plan.change);
      if (updated) {
        await this.#complete(context, tenant.tenantKey, ticket.id, plan.entry);
        await this.#auditPublish(context, tenant, ticket, plan.entry);
        return createdResponse(plan.entry);
      }

      ticket = await this.ticketRepository.findById(tenant.tenantKey, ticket.id);
      if (!ticket) {
        return fail(panelReasons.NOT_FOUND);
      }
    }

    return fail(panelReasons.INVALID_TRANSITION);
  }

  // Reglas de "Responder" y "Resolver" de Smarteam sobre el estado actual, y el cambio completo
  // en una sola escritura: mensaje, estado, resolución interna y entrada de horas. null si el
  // ticket no admite la publicación (resuelto).
  #plan(ticket, context) {
    const { user, input, at, guardKey, fingerprint } = context;
    const nextStatus = input.resolve
      ? (canResolve(ticket.status) ? TICKET_STATUSES.RESUELTO : null)
      : statusAfterStaffMessage(ticket.status);
    if (!nextStatus) {
      return null;
    }

    const changesStatus = nextStatus !== ticket.status;
    const message = messageEntry({
      id: this.ticketRepository.newId(),
      side: SIDE,
      user,
      body: input.summary,
      attachments: [],
      at,
    });
    const entry = {
      id: this.ticketRepository.newId(),
      authorId: String(user.id),
      authorName: user.name ?? null,
      hours: input.hours,
      internalNote: input.internalNote,
      crmProjectId: input.crmProjectId,
      messageId: message.id,
      resolved: input.resolve,
      statusAfter: nextStatus,
      via: context.via,
      tokenId: context.tokenId,
      idempotencyKey: guardKey ?? null,
      idempotencyFingerprint: guardKey ? fingerprint : null,
      createdAt: at,
    };

    const set = {
      lastActivityAt: at,
      lastPublicAuthorType: SIDE,
      staffLastSeenAt: at,
      ...(changesStatus ? { status: nextStatus } : {}),
    };
    if (input.resolve) {
      set.resolvedAt = at;
      // Reemplaza la que hubiera, como el botón Resolver.
      set.internalResolution = {
        text: input.internalNote,
        updatedAt: at,
        updatedBy: { userId: String(user.id), name: user.name ?? null },
      };
    }

    const change = {
      expectedStatus: ticket.status,
      set,
      setIfNull: { firstResponseAt: at },
      pushMessage: message,
      pushHistory: changesStatus
        ? [historyEntry({ from: ticket.status, to: nextStatus, side: SIDE, user, at })]
        : [],
      pushWorkLog: entry,
    };
    if (guardKey) {
      change.idempotencyGuard = guardKey;
    }
    return { change, entry };
  }

  // Marca la clave como terminada. Si falla, la respuesta igual es 201: el registro queda
  // pending, se retoma a los 60 s y el paso 4 encuentra la entrada.
  async #complete(context, tenantKey, ticketId, entry) {
    if (!context.reservation) {
      return;
    }
    try {
      await this.idempotencyStore.complete({
        ...context.reservation,
        tenantKey,
        ticketId: String(ticketId),
        entryId: entryId(entry),
        status: CREATED_STATUS,
      });
    } catch (error) {
      this.logger?.warn?.({ msg: 'Panel work log: idempotency key not completed', tenantKey, ticketId: String(ticketId), error: error?.message });
    }
  }

  async #release(reservation) {
    try {
      await this.idempotencyStore.release(reservation);
    } catch (error) {
      // Queda pending abandonado: se retoma a los 60 s y el paso 4 evita duplicar.
      this.logger?.warn?.({ msg: 'Panel work log: idempotency key not released', error: error?.message });
    }
  }

  // Paso 6: rearma el 201 desde la entrada guardada. No escribe ni audita.
  async #replay(record) {
    const ticket = await this.ticketRepository.findById(record.tenantKey, record.ticketId);
    const entry = findEntry(ticket, (candidate) => entryId(candidate) === String(record.entryId));
    if (!entry) {
      return fail(panelReasons.NOT_FOUND);
    }
    return createdResponse(entry);
  }

  // Después de escribir y best effort. Ni la nota interna, ni el resumen, ni el token.
  async #auditPublish(context, tenant, ticket, entry) {
    await recordAudit(this.auditLog, buildAuditEntry({
      action: AUDIT_ACTIONS.TICKET_WORK_LOGGED,
      actor: actorOf(context.user),
      target: null,
      details: {
        tenantKey: tenant.tenantKey,
        ticketId: String(ticket.id),
        ticketCode: ticket.code,
        entryId: entryId(entry),
        hours: entry.hours,
        resolved: entry.resolved,
        via: context.via,
        tokenPrefix: context.tokenPrefix,
      },
      ip: context.ip,
      at: context.at,
    }));
  }
}

export default StaffWorkLog;
