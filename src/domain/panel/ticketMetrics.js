import { addDays, localDate, median, mondayOf, toMs } from './period.js';
import { TICKET_STATUSES } from './tickets.js';

// Métricas de soporte (contrato 05, F8 y F9), a partir de los tickets (sin mensajes ni nota
// interna). Tiempo corrido, en segundos. Misma lógica que la API simulada del front.

const HOUR = 3600;
const BUCKETS = Object.freeze([
  ['lt4h', 4 * HOUR],
  ['4h_24h', 24 * HOUR],
  ['1d_3d', 72 * HOUR],
  ['gt3d', Infinity],
]);

const resolutionSeconds = (ticket) => (toMs(ticket.resolvedAt) - toMs(ticket.openedAt)) / 1000;
const firstResponseSeconds = (ticket) => (toMs(ticket.firstResponseAt) - toMs(ticket.openedAt)) / 1000;
const isOpen = (ticket) => ticket.status !== TICKET_STATUSES.RESUELTO;

// F9: resueltos HOY cuya última resolución cae en [from, to).
function resolvedBetween(tickets, from, to) {
  return tickets.filter((ticket) => {
    const resolved = toMs(ticket.resolvedAt);
    return ticket.status === TICKET_STATUSES.RESUELTO && resolved >= from && resolved < to;
  });
}

// Fila de una empresa (y base de los totales).
export function metricsRow(tickets, { from, to }) {
  const resolved = resolvedBetween(tickets, from, to);
  const responded = tickets.filter((ticket) => {
    const opened = toMs(ticket.openedAt);
    return ticket.firstResponseAt && opened >= from && opened < to;
  });
  return {
    resolved: resolved.length,
    medianFirstResponseSeconds: median(responded.map(firstResponseSeconds)),
    medianResolutionSeconds: median(resolved.map(resolutionSeconds)),
    reopened: resolved.filter((ticket) => ticket.reopenCount > 0).length,
    open: tickets.filter(isOpen).length,
  };
}

// tenants: [{ tenantKey, companyName, tickets }] para la tabla por empresa (solo Smarteam).
export function ticketMetrics(tickets, { from, to, tz }, { tenants } = {}) {
  const row = metricsRow(tickets, { from, to });
  const resolved = resolvedBetween(tickets, from, to);
  const open = tickets.filter(isOpen);

  const weeks = new Map();
  const lastDay = localDate(to - 1, tz);
  for (let week = mondayOf(localDate(from, tz)); week <= lastDay; week = addDays(week, 7)) {
    weeks.set(week, []);
  }
  for (const ticket of resolved) {
    weeks.get(mondayOf(localDate(toMs(ticket.resolvedAt), tz)))?.push(ticket);
  }

  const categories = new Map();
  for (const ticket of resolved) {
    categories.set(ticket.category, [...(categories.get(ticket.category) ?? []), ticket]);
  }

  const body = {
    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), tz },
    totals: {
      resolved: row.resolved,
      resolvedPreviousPeriod: resolvedBetween(tickets, from - (to - from), from).length,
      reopened: row.reopened,
      open: open.length,
      openWithoutFirstResponse: open.filter((ticket) => !ticket.firstResponseAt).length,
      medianFirstResponseSeconds: row.medianFirstResponseSeconds,
      medianResolutionSeconds: row.medianResolutionSeconds,
    },
    byWeek: [...weeks].map(([weekStart, list]) => ({
      weekStart,
      resolved: list.length,
      reopened: list.filter((ticket) => ticket.reopenCount > 0).length,
      medianResolutionSeconds: median(list.map(resolutionSeconds)),
    })),
    buckets: BUCKETS.map(([key, limit], index) => {
      const lower = index === 0 ? 0 : BUCKETS[index - 1][1];
      return {
        key,
        count: resolved.filter((ticket) => {
          const seconds = resolutionSeconds(ticket);
          return seconds >= lower && seconds < limit;
        }).length,
      };
    }),
    byCategory: [...categories]
      .map(([category, list]) => ({
        category,
        resolved: list.length,
        medianResolutionSeconds: median(list.map(resolutionSeconds)),
      }))
      .sort((left, right) => right.resolved - left.resolved || left.category.localeCompare(right.category)),
  };

  if (tenants) {
    body.byTenant = tenants
      .map((tenant) => ({
        tenantKey: tenant.tenantKey,
        companyName: tenant.companyName ?? null,
        ...metricsRow(tenant.tickets, { from, to }),
      }))
      .sort((left, right) => right.resolved - left.resolved
        || String(left.companyName ?? '').localeCompare(String(right.companyName ?? ''), 'es'));
  }
  return body;
}

// Filtro de tickets que pueden importar a las métricas de un período: abiertos hoy, resueltos
// en el período o en el anterior de igual largo, o abiertos dentro del período.
export function metricsTicketWindow({ from, to }) {
  return { previousFrom: new Date(from - (to - from)), from: new Date(from), to: new Date(to) };
}
