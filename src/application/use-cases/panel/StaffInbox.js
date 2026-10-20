import {
  TICKET_LIMITS,
  TICKET_STATUS_VALUES,
  isTicketCategory,
  isTicketStatus,
} from '#domain/panel/tickets.js';
import { fail, panelReasons, validationError } from './panelReasons.js';
import { parsePagination } from './pagination.js';
import { toStaffListItem } from './ticketView.js';

export const DEFAULT_TENANT_TIMEOUT_MS = 5000;
const TENANT_ERROR = 'No se pudo consultar la base del tenant';

function emptyCounts() {
  return Object.fromEntries(TICKET_STATUS_VALUES.map((status) => [status, 0]));
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Tenant query timed out after ${ms} ms`)), ms);
  });
  // Si la consulta termina mal después del timeout, que no quede como rechazo sin manejar.
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function byLastActivityDesc(left, right) {
  const difference = new Date(right.ticket.lastActivityAt).getTime() - new Date(left.ticket.lastActivityAt).getTime();
  if (difference !== 0) {
    return difference;
  }
  return String(right.ticket.id).localeCompare(String(left.ticket.id));
}

// Bandeja global de Smarteam y su resumen. Cada tenant tiene su base: se consultan todos en
// paralelo, con un tiempo máximo por tenant. Un tenant caído o lento no deja sin bandeja: sale
// en warnings y se devuelven los demás.
export class StaffInbox {
  constructor({ ticketRepository, tenantDirectory, tenantTimeoutMs = DEFAULT_TENANT_TIMEOUT_MS, logger = null }) {
    this.ticketRepository = ticketRepository;
    this.tenantDirectory = tenantDirectory;
    this.tenantTimeoutMs = tenantTimeoutMs;
    this.logger = logger;
  }

  async forEachTenant(tenants, query) {
    const settled = await Promise.allSettled(
      tenants.map((tenant) => withTimeout(Promise.resolve().then(() => query(tenant)), this.tenantTimeoutMs))
    );
    const results = [];
    const warnings = [];
    settled.forEach((outcome, index) => {
      const tenant = tenants[index];
      if (outcome.status === 'fulfilled') {
        results.push({ tenant, value: outcome.value });
        return;
      }
      warnings.push({ tenantKey: tenant.tenantKey, error: TENANT_ERROR });
      this.logger?.warn?.({
        msg: 'Panel inbox: tenant query failed',
        tenantKey: tenant.tenantKey,
        error: outcome.reason?.message,
      });
    });
    return { results, warnings };
  }

  async list({ query = {} } = {}) {
    const pagination = parsePagination(query);
    if (!pagination.ok) {
      return pagination;
    }
    const { page, pageSize } = pagination;
    if (page * pageSize > TICKET_LIMITS.INBOX_PAGE_WINDOW) {
      return fail(panelReasons.PAGE_WINDOW_EXCEEDED, 'Usa los filtros para acotar la bandeja.');
    }

    const { status, category, tenantKey } = query;
    if (status !== undefined && status !== '' && !isTicketStatus(status)) {
      return validationError('Estado inválido.');
    }
    if (category !== undefined && category !== '' && !isTicketCategory(category)) {
      return validationError('Categoría inválida.');
    }
    if (tenantKey !== undefined && typeof tenantKey !== 'string') {
      return validationError('Empresa inválida.');
    }

    // Todos los tenants, incluidos los suspendidos. Un tenantKey desconocido da lista vacía.
    const tenants = (await this.tenantDirectory.listAll())
      .filter((tenant) => !tenantKey || tenant.tenantKey === tenantKey);

    const limit = page * pageSize;
    const { results, warnings } = await this.forEachTenant(tenants, (tenant) =>
      this.ticketRepository.list(tenant.tenantKey, {
        status: status || undefined,
        category: category || undefined,
        skip: 0,
        limit,
      })
    );

    const merged = results.flatMap(({ tenant, value }) => value.items.map((ticket) => ({ tenant, ticket })));
    merged.sort(byLastActivityDesc);
    const total = results.reduce((sum, { value }) => sum + value.total, 0);
    const items = merged
      .slice((page - 1) * pageSize, page * pageSize)
      .map(({ tenant, ticket }) => toStaffListItem(ticket, tenant));

    return { ok: true, data: { items, page, pageSize, total, warnings } };
  }

  async summary() {
    const tenants = await this.tenantDirectory.listAll();
    const { results, warnings } = await this.forEachTenant(tenants, (tenant) =>
      this.ticketRepository.countByStatus(tenant.tenantKey)
    );

    const byStatus = emptyCounts();
    const byTenant = results.map(({ tenant, value }) => {
      const counts = emptyCounts();
      for (const status of TICKET_STATUS_VALUES) {
        const count = Number(value?.[status] ?? 0);
        counts[status] = count;
        byStatus[status] += count;
      }
      return { tenantKey: tenant.tenantKey, companyName: tenant.companyName ?? null, byStatus: counts };
    });

    return { ok: true, data: { byStatus, byTenant, warnings } };
  }
}

export default StaffInbox;
