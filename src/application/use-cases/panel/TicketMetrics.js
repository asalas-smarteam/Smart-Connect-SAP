import { parsePeriod } from '#domain/panel/period.js';
import { isTicketCategory } from '#domain/panel/tickets.js';
import { metricsTicketWindow, ticketMetrics } from '#domain/panel/ticketMetrics.js';
import { fail, panelReasons, validationError } from './panelReasons.js';
import { DEFAULT_TENANT_TIMEOUT_MS, queryTenants } from './tenantFanOut.js';

const PERIOD_MESSAGE = 'Período o zona horaria inválidos.';

// Métricas de soporte (contrato 05, F7 a F9). Cliente: su empresa (tenant de la sesión), sin
// tabla por empresa. Smarteam: todas las empresas o una, con byTenant y warnings.
export class TicketMetrics {
  constructor({ ticketRepository, tenantDirectory, tenantTimeoutMs = DEFAULT_TENANT_TIMEOUT_MS, logger = null }) {
    this.ticketRepository = ticketRepository;
    this.tenantDirectory = tenantDirectory;
    this.tenantTimeoutMs = tenantTimeoutMs;
    this.logger = logger;
  }

  async forClient({ user, query = {} }) {
    if (!user?.tenantKey) {
      return fail(panelReasons.NOT_FOUND);
    }
    const period = parsePeriod(query);
    if (!period) {
      return validationError(PERIOD_MESSAGE);
    }
    const tickets = await this.ticketRepository.listForMetrics(user.tenantKey, { window: metricsTicketWindow(period) });
    return { ok: true, data: ticketMetrics(tickets, period) };
  }

  async forStaff({ query = {} } = {}) {
    const period = parsePeriod(query);
    if (!period) {
      return validationError(PERIOD_MESSAGE);
    }
    const { category, tenantKey } = query;
    if (category !== undefined && category !== '' && !isTicketCategory(category)) {
      return validationError('Categoría inválida.');
    }
    if (tenantKey !== undefined && tenantKey !== '' && typeof tenantKey !== 'string') {
      return validationError('Empresa inválida.');
    }

    let tenants;
    if (tenantKey) {
      const tenant = await this.tenantDirectory.findByKey(tenantKey);
      if (!tenant) {
        return fail(panelReasons.NOT_FOUND);
      }
      tenants = [tenant];
    } else {
      tenants = await this.tenantDirectory.listAll();
    }

    const window = metricsTicketWindow(period);
    const { results, warnings } = await queryTenants(
      tenants,
      (tenant) => this.ticketRepository.listForMetrics(tenant.tenantKey, { window, category: category || undefined }),
      { timeoutMs: this.tenantTimeoutMs, logger: this.logger, label: 'Panel ticket metrics' }
    );

    const perTenant = results.map(({ tenant, value }) => ({
      tenantKey: tenant.tenantKey,
      companyName: tenant.companyName ?? null,
      tickets: value,
    }));
    const data = ticketMetrics(perTenant.flatMap((tenant) => tenant.tickets), period, { tenants: perTenant });
    return { ok: true, data: { ...data, warnings } };
  }
}

export default TicketMetrics;
