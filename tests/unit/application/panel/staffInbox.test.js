import { jest } from '@jest/globals';
import StaffInbox from '../../../../src/application/use-cases/panel/StaffInbox.js';
import { FakeTenantDirectory, TENANTS } from './panelFakes.js';
import { InMemoryTicketRepository, nextObjectId } from './ticketFakes.js';

const ACME = 'sap_integration_acme';
const INITECH = 'sap_integration_initech';

function ticket(overrides) {
  return {
    id: nextObjectId(),
    code: 'X-0001',
    title: 't',
    description: 'd',
    category: 'documentos',
    status: 'abierto',
    context: null,
    createdBy: { userId: 'u', name: 'Ana', role: 'admin' },
    attachments: [],
    messages: [],
    internalResolution: { text: 'secreto', updatedAt: new Date(), updatedBy: { name: 'Dev' } },
    statusHistory: [],
    openedAt: new Date('2026-10-01T00:00:00Z'),
    firstResponseAt: null,
    resolvedAt: null,
    reopenCount: 0,
    lastPublicAuthorType: 'cliente',
    clientLastSeenAt: null,
    staffLastSeenAt: null,
    ...overrides,
  };
}

function build({ timeout = 5000 } = {}) {
  const ticketRepository = new InMemoryTicketRepository();
  ticketRepository.tickets(ACME).push(
    ticket({ code: 'ACME-0001', lastActivityAt: new Date('2026-10-10T00:00:00Z') }),
    ticket({ code: 'ACME-0002', status: 'resuelto', lastActivityAt: new Date('2026-10-12T00:00:00Z') }),
  );
  ticketRepository.tickets(INITECH).push(
    ticket({ code: 'INITECH-0001', category: 'precios', lastActivityAt: new Date('2026-10-11T00:00:00Z') }),
  );
  const logger = { warn: jest.fn() };
  const inbox = new StaffInbox({
    ticketRepository,
    tenantDirectory: new FakeTenantDirectory(TENANTS),
    tenantTimeoutMs: timeout,
    logger,
  });
  return { inbox, ticketRepository, logger };
}

describe('StaffInbox.list', () => {
  it('merges every tenant by last activity and adds the company', async () => {
    const { inbox } = build();

    const result = await inbox.list({ query: {} });

    expect(result.data.items.map((item) => item.code)).toEqual(['ACME-0002', 'INITECH-0001', 'ACME-0001']);
    expect(result.data.items[1]).toEqual(expect.objectContaining({ tenantKey: INITECH, companyName: 'Initech Servicios', hasNews: true }));
    expect(result.data).toEqual(expect.objectContaining({ page: 1, pageSize: 25, total: 3, warnings: [] }));
    expect(JSON.stringify(result.data)).not.toContain('secreto');
  });

  it('paginates over the merged list', async () => {
    const { inbox } = build();

    const result = await inbox.list({ query: { page: '2', pageSize: '2' } });

    expect(result.data.items.map((item) => item.code)).toEqual(['ACME-0001']);
    expect(result.data.total).toBe(3);
  });

  it('filters by tenant, status and category', async () => {
    const { inbox, ticketRepository } = build();

    expect((await inbox.list({ query: { tenantKey: INITECH } })).data.total).toBe(1);
    expect((await inbox.list({ query: { status: 'resuelto' } })).data.items.map((item) => item.code)).toEqual(['ACME-0002']);
    expect((await inbox.list({ query: { category: 'precios' } })).data.items.map((item) => item.code)).toEqual(['INITECH-0001']);

    ticketRepository.touchedTenants = [];
    const unknown = await inbox.list({ query: { tenantKey: 'sap_integration_fantasma' } });
    expect(unknown.data).toEqual(expect.objectContaining({ items: [], total: 0 }));
    expect(ticketRepository.touchedTenants).toEqual([]);
  });

  it('returns the other tenants plus a warning when one fails', async () => {
    const { inbox, ticketRepository, logger } = build();
    ticketRepository.failingTenants.add(INITECH);

    const result = await inbox.list({ query: {} });

    expect(result.data.items.map((item) => item.code)).toEqual(['ACME-0002', 'ACME-0001']);
    expect(result.data.warnings).toEqual([{ tenantKey: INITECH, error: 'No se pudo consultar la base del tenant' }]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('gives up on a slow tenant after the timeout', async () => {
    const { inbox, ticketRepository } = build({ timeout: 20 });
    ticketRepository.slowTenants.set(INITECH, 200);

    const result = await inbox.list({ query: {} });

    expect(result.data.total).toBe(2);
    expect(result.data.warnings.map((warning) => warning.tenantKey)).toEqual([INITECH]);
  });

  it('answers page_window_exceeded beyond 1000 tickets', async () => {
    const { inbox } = build();

    expect((await inbox.list({ query: { page: '11', pageSize: '100' } })).reason).toBe('PAGE_WINDOW_EXCEEDED');
    expect((await inbox.list({ query: { page: '10', pageSize: '100' } })).ok).toBe(true);
  });

  it.each([
    [{ status: 'cerrado' }],
    [{ category: ['precios'] }],
    [{ tenantKey: ['a', 'b'] }],
    [{ pageSize: '0' }],
  ])('rejects %j', async (query) => {
    const { inbox } = build();
    expect((await inbox.list({ query })).reason).toBe('VALIDATION_ERROR');
  });
});

describe('StaffInbox.summary', () => {
  it('always returns the four statuses, per tenant and in total', async () => {
    const { inbox } = build();

    const result = await inbox.summary();

    expect(result.data.byStatus).toEqual({ abierto: 2, en_progreso: 0, esperando_cliente: 0, resuelto: 1 });
    expect(result.data.byTenant).toEqual([
      { tenantKey: ACME, companyName: 'Acme Industrial', byStatus: { abierto: 1, en_progreso: 0, esperando_cliente: 0, resuelto: 1 } },
      { tenantKey: INITECH, companyName: 'Initech Servicios', byStatus: { abierto: 1, en_progreso: 0, esperando_cliente: 0, resuelto: 0 } },
    ]);
    expect(result.data.warnings).toEqual([]);
  });

  it('leaves a failing tenant out with a warning', async () => {
    const { inbox, ticketRepository } = build();
    ticketRepository.failingTenants.add(ACME);

    const result = await inbox.summary();

    expect(result.data.byTenant.map((row) => row.tenantKey)).toEqual([INITECH]);
    expect(result.data.warnings).toEqual([{ tenantKey: ACME, error: 'No se pudo consultar la base del tenant' }]);
  });
});
