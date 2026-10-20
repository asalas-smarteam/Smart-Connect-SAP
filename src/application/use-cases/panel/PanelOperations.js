import {
  EVENT_QUEUE_TASK,
  VIEW_SIDES,
  clientSyncErrorItem,
  toEventView,
  toSyncTaskView,
  toSyncView,
} from '#domain/panel/operationViews.js';
import { integrationSummary } from '#domain/panel/integrationSummary.js';
import { exchangeView } from '#domain/panel/exchangeView.js';
import { deriveQueueErrorItem, isQueueErrorList, queueEntryRecord } from '#domain/panel/queueRunErrors.js';
import { parsePeriod } from '#domain/panel/period.js';
import { fail, panelReasons, validationError } from './panelReasons.js';
import { parsePagination } from './pagination.js';
import { parseEventFilters, parseSyncFilters } from './operationFilters.js';

const TIMEOUT_MESSAGE = 'La consulta tardó demasiado. Acota el rango de fechas o agrega filtros.';
// Tope de desplazamiento (página × tamaño) en listas y en los errores de una sync: una página
// absurda se rechaza con 400 en vez de llegar a la base.
export const MAX_OFFSET = 10000;
const OFFSET_MESSAGE = 'La página pedida es demasiado alta. Usa los filtros para acotar la lista.';

export const MAX_SUMMARY_EVENTS = 20000;
const PERIOD_MESSAGE = 'Período o zona horaria inválidos.';
const TOO_MANY_EVENTS_MESSAGE = 'El período tiene demasiados eventos; acórtalo.';

// Ruta de cliente (sin :tenantKey) → vista de cliente; ruta de staff → vista de Smarteam.
function sideOf(scope) {
  return scope?.routeTenantKey === undefined ? VIEW_SIDES.CLIENTE : VIEW_SIDES.SMARTEAM;
}

// Margen alrededor de la corrida para encontrar el evento de cada fallo (plan 5b).
const QUEUE_EVENT_MARGIN_MS = 60 * 1000;

function toTime(value) {
  if (!value) {
    return Number.NaN;
  }
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function checkOffset({ page, pageSize }) {
  return page * pageSize > MAX_OFFSET ? validationError(OFFSET_MESSAGE) : null;
}

function timeoutAware(error) {
  if (error?.code === 'PANEL_QUERY_TIMEOUT') {
    return fail(panelReasons.QUERY_TIMEOUT, TIMEOUT_MESSAGE);
  }
  throw error;
}

// Eventos, syncs y tareas de una empresa (contrato 03, E1 a E10). Solo lectura.
// El tenant llega por scope: el de la sesión (rutas de cliente) o el :tenantKey de la ruta de
// staff, que se valida contra el directorio de empresas antes de abrir la base.
export class PanelOperations {
  constructor({ operationsReader, tenantDirectory, logger = null }) {
    this.reader = operationsReader;
    this.tenantDirectory = tenantDirectory;
    this.logger = logger;
  }

  // scope: { user, routeTenantKey }. Devuelve { ok, tenantKey } o el fallo.
  async resolveTenant({ user, routeTenantKey }) {
    if (routeTenantKey === undefined) {
      return user?.tenantKey ? { ok: true, tenantKey: user.tenantKey } : fail(panelReasons.NOT_FOUND);
    }
    if (typeof routeTenantKey !== 'string' || !routeTenantKey) {
      return fail(panelReasons.NOT_FOUND);
    }
    const tenant = await this.tenantDirectory.findByKey(routeTenantKey);
    return tenant ? { ok: true, tenantKey: tenant.tenantKey } : fail(panelReasons.NOT_FOUND);
  }

  warnUnknownStatus(tenantKey, raw, view) {
    if (view && view.status === null) {
      this.logger?.warn?.({ msg: 'Panel events: unknown internal event status', tenantKey, status: raw.status });
    }
  }

  toEvent(tenantKey, raw, options) {
    const view = toEventView(raw, options);
    // options.side siempre viene de sideOf(scope).
    this.warnUnknownStatus(tenantKey, raw, view);
    return view;
  }

  async taskMap(tenantKey, syncs) {
    const ids = syncs.map((sync) => sync.clientConfigId).filter(Boolean).map(String);
    if (ids.length === 0) {
      return new Map();
    }
    const tasks = await this.reader.findTasks(tenantKey, ids);
    return new Map(tasks.map((task) => [String(task._id ?? task.id), task]));
  }

  async listEvents({ scope, query = {} }) {
    try {
      const tenant = await this.resolveTenant(scope);
      if (!tenant.ok) {
        return tenant;
      }
      const pagination = parsePagination(query);
      if (!pagination.ok) {
        return pagination;
      }
      const tooFar = checkOffset(pagination);
      if (tooFar) {
        return tooFar;
      }
      const parsed = parseEventFilters(query);
      if (!parsed.ok) {
        return parsed;
      }
      const { page, pageSize } = pagination;
      const { items, total } = await this.reader.listEvents(tenant.tenantKey, {
        filters: parsed.filters,
        skip: (page - 1) * pageSize,
        limit: pageSize,
      });
      return {
        ok: true,
        data: {
          items: items.map((raw) => this.toEvent(tenant.tenantKey, raw, { side: sideOf(scope) })).filter(Boolean),
          page,
          pageSize,
          total,
        },
      };
    } catch (error) {
      return timeoutAware(error);
    }
  }

  // withRaw: solo lo pide la ruta de staff, y solo con staff.events.raw.
  async getEvent({ scope, id, withRaw = false }) {
    try {
      const tenant = await this.resolveTenant(scope);
      if (!tenant.ok) {
        return tenant;
      }
      const side = sideOf(scope);
      const raw = await this.reader.findEvent(tenant.tenantKey, id, { withRaw, withExchange: true });
      const view = raw ? this.toEvent(tenant.tenantKey, raw, { withRaw, side }) : null;
      if (!view) {
        return fail(panelReasons.NOT_FOUND);
      }
      // Plan 5c (H1): intercambio solo en el detalle; saneado para el cliente.
      return { ok: true, data: { ...view, exchange: exchangeView(raw, { side }) } };
    } catch (error) {
      return timeoutAware(error);
    }
  }

  async listSyncs({ scope, query = {} }) {
    try {
      const tenant = await this.resolveTenant(scope);
      if (!tenant.ok) {
        return tenant;
      }
      const pagination = parsePagination(query);
      if (!pagination.ok) {
        return pagination;
      }
      const tooFar = checkOffset(pagination);
      if (tooFar) {
        return tooFar;
      }
      const parsed = parseSyncFilters(query);
      if (!parsed.ok) {
        return parsed;
      }
      const { page, pageSize } = pagination;
      const { items, total } = await this.reader.listSyncs(tenant.tenantKey, {
        filters: parsed.filters,
        skip: (page - 1) * pageSize,
        limit: pageSize,
      });
      const tasks = await this.taskMap(tenant.tenantKey, items);
      return {
        ok: true,
        data: {
          items: items.map((sync) => toSyncView(sync, tasks.get(String(sync.clientConfigId)) ?? null, { side: sideOf(scope) })),
          page,
          pageSize,
          total,
        },
      };
    } catch (error) {
      return timeoutAware(error);
    }
  }

  // E7: detalle con los errores paginados (?errorsPage=&errorsPageSize=, 25 por defecto, máx 100).
  async getSync({ scope, id, query = {} }) {
    try {
      const tenant = await this.resolveTenant(scope);
      if (!tenant.ok) {
        return tenant;
      }
      const pagination = parsePagination({ page: query.errorsPage, pageSize: query.errorsPageSize });
      if (!pagination.ok) {
        return pagination;
      }
      const tooFar = checkOffset(pagination);
      if (tooFar) {
        return tooFar;
      }
      const { page, pageSize } = pagination;
      const found = await this.reader.findSync(tenant.tenantKey, id, {
        errorsSkip: (page - 1) * pageSize,
        errorsLimit: pageSize,
      });
      if (!found) {
        return fail(panelReasons.NOT_FOUND);
      }
      const tasks = await this.taskMap(tenant.tenantKey, [found.sync]);
      const { errors = [], ...sync } = found.sync;
      const side = sideOf(scope);
      const view = toSyncView(sync, tasks.get(String(sync.clientConfigId)) ?? null, { side });

      // Plan 5b: corrida de la cola sin errors propios → los ítems salen de errorMessage.
      if (!found.errorsTotal && isQueueErrorList(sync.errorMessage)) {
        const entries = sync.errorMessage;
        const pageEntries = entries.slice((page - 1) * pageSize, page * pageSize);
        const eventIds = await this.queueEventIds(tenant.tenantKey, sync, pageEntries, entries);
        return {
          ok: true,
          data: {
            ...view,
            errors: {
              items: pageEntries.map((entry) => deriveQueueErrorItem(entry, {
                side,
                eventId: eventIds.get(queueEntryRecord(entry)) ?? null,
              })),
              page,
              pageSize,
              total: entries.length,
            },
          },
        };
      }

      // Cliente (G4): cada error reducido a { record, message } saneado; staff, crudo.
      const items = side === VIEW_SIDES.CLIENTE ? errors.map(clientSyncErrorItem) : errors;
      return {
        ok: true,
        data: {
          ...view,
          errors: { items, page, pageSize, total: found.errorsTotal ?? 0 },
        },
      };
    } catch (error) {
      return timeoutAware(error);
    }
  }

  // Id del evento de cada negocio fallido: el único evento con error de esa referencia que se
  // actualizó durante la corrida. Cero o varios → sin id (no se adivina).
  async queueEventIds(tenantKey, sync, entries, allEntries = entries) {
    // Un negocio que falló dos veces en la misma corrida no se puede atribuir a un solo evento.
    const repeated = new Map();
    for (const reference of allEntries.map(queueEntryRecord).filter(Boolean)) {
      repeated.set(reference, (repeated.get(reference) ?? 0) + 1);
    }
    const references = [...new Set(entries.map(queueEntryRecord).filter(Boolean))]
      .filter((reference) => repeated.get(reference) === 1);
    const started = toTime(sync.startedAt);
    if (references.length === 0 || !Number.isFinite(started)) {
      return new Map();
    }
    const finished = toTime(sync.finishedAt);
    const end = Number.isFinite(finished) ? finished : Date.now();
    const found = await this.reader.findQueueEventIds(tenantKey, {
      references,
      from: new Date(started - QUEUE_EVENT_MARGIN_MS),
      to: new Date(end + QUEUE_EVENT_MARGIN_MS),
    });
    const byReference = new Map();
    for (const { id, reference } of found) {
      byReference.set(reference, [...(byReference.get(reference) ?? []), id]);
    }
    return new Map([...byReference].filter(([, ids]) => ids.length === 1).map(([reference, ids]) => [reference, ids[0]]));
  }

  // E8: tareas para el filtro de syncs. Solo id, name y type.
  async listTasks({ scope }) {
    try {
      const tenant = await this.resolveTenant(scope);
      if (!tenant.ok) {
        return tenant;
      }
      const tasks = await this.reader.listTasks(tenant.tenantKey);
      // G1: la cola de eventos va al final, para poder filtrar sus corridas.
      return { ok: true, data: { items: [...tasks.map(toSyncTaskView), { ...EVENT_QUEUE_TASK }] } };
    } catch (error) {
      return timeoutAware(error);
    }
  }

  // F1 a F6: resumen de integración del Inicio. from, to y tz obligatorios (F4).
  async dashboard({ scope, query = {} }) {
    try {
      const tenant = await this.resolveTenant(scope);
      if (!tenant.ok) {
        return tenant;
      }
      const period = parsePeriod(query);
      if (!period) {
        return validationError(PERIOD_MESSAGE);
      }
      const { items, truncated } = await this.reader.listEventsForSummary(tenant.tenantKey, {
        from: new Date(period.from),
        to: new Date(period.to),
        limit: MAX_SUMMARY_EVENTS,
      });
      if (truncated) {
        return validationError(TOO_MANY_EVENTS_MESSAGE);
      }
      const unknown = new Set();
      const data = integrationSummary(items, period, { onUnknownStatus: (status) => unknown.add(status) });
      for (const status of unknown) {
        this.logger?.warn?.({ msg: 'Panel dashboard: unknown internal event status', tenantKey: tenant.tenantKey, status });
      }
      return { ok: true, data };
    } catch (error) {
      return timeoutAware(error);
    }
  }
}

export default PanelOperations;
