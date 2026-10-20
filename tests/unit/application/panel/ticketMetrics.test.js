import TicketMetrics from '../../../../src/application/use-cases/panel/TicketMetrics.js';
import { FakeTenantDirectory, TENANTS } from './panelFakes.js';
import { InMemoryTicketRepository, nextObjectId } from './ticketFakes.js';

const ACME = 'sap_integration_acme';
const INITECH = 'sap_integration_initech';
const query = { from: '2026-09-28T06:00:00.000Z', to: '2026-10-12T06:00:00.000Z', tz: 'America/Costa_Rica' };

function ticket(overrides) {
  return {
    id: nextObjectId(),
    status: 'resuelto',
    category: 'documentos',
    reopenCount: 0,
    openedAt: new Date('2026-10-01T14:00:00Z'),
    firstResponseAt: new Date('2026-10-01T15:00:00Z'),
    resolvedAt: new Date('2026-10-01T18:00:00Z'),
    messages: [],
    internalResolution: { text: 'secreto' },
    ...overrides,
  };
}

function build({ timeout = 5000 } = {}) {
  const ticketRepository = new InMemoryTicketRepository();
  ticketRepository.tickets(ACME).push(ticket(), ticket({ status: 'abierto', firstResponseAt: null, resolvedAt: null }));
  ticketRepository.tickets(INITECH).push(ticket({ category: 'precios' }));
  const metrics = new TicketMetrics({ ticketRepository, tenantDirectory: new FakeTenantDirectory(TENANTS), tenantTimeoutMs: timeout });
  return { metrics, ticketRepository };
}

describe('TicketMetrics', () => {
  it('serves the client its own tenant without byTenant', async () => {
    const { metrics } = build();

    const result = await metrics.forClient({ user: { tenantKey: ACME }, query });

    expect(result.data.totals).toEqual(expect.objectContaining({ resolved: 1, open: 1, openWithoutFirstResponse: 1 }));
    expect(result.data).not.toHaveProperty('byTenant');
    expect(result.data).not.toHaveProperty('warnings');
    expect(JSON.stringify(result.data)).not.toContain('secreto');
  });

  it('serves Smarteam every tenant with byTenant and warnings', async () => {
    const { metrics, ticketRepository } = build();
    ticketRepository.failingTenants.add(INITECH);

    const result = await metrics.forStaff({ query });

    expect(result.data.totals.resolved).toBe(1);
    expect(result.data.byTenant).toEqual([
      expect.objectContaining({ tenantKey: ACME, companyName: 'Acme Industrial', resolved: 1, open: 1 }),
    ]);
    expect(result.data.warnings).toEqual([{ tenantKey: INITECH, error: 'No se pudo consultar la base del tenant' }]);
  });

  it('filters by tenant and category', async () => {
    const { metrics } = build();

    expect((await metrics.forStaff({ query: { ...query, tenantKey: INITECH } })).data.byTenant.map((row) => row.tenantKey)).toEqual([INITECH]);
    expect((await metrics.forStaff({ query: { ...query, category: 'precios' } })).data.totals.resolved).toBe(1);
  });

  it('validates the period, the category and the tenant', async () => {
    const { metrics, ticketRepository } = build();

    expect((await metrics.forClient({ user: { tenantKey: ACME }, query: { ...query, tz: undefined } })).reason).toBe('VALIDATION_ERROR');
    expect((await metrics.forStaff({ query: { ...query, category: 'ventas' } })).message).toBe('Categoría inválida.');
    ticketRepository.touchedTenants = [];
    expect(await metrics.forStaff({ query: { ...query, tenantKey: 'sap_integration_fantasma' } })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(ticketRepository.touchedTenants).toEqual([]);
  });
});
