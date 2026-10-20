import { jest } from '@jest/globals';
import PanelOperations from '../../../../src/application/use-cases/panel/PanelOperations.js';
import { FakeTenantDirectory, TENANTS } from './panelFakes.js';
import { FakeOperationsReader, OPS_IDS as I, sampleOperations } from './operationFakes.js';

const ACME = 'sap_integration_acme';
const client = { id: 'u1', accountType: 'cliente', tenantKey: ACME };
const staff = { id: 'u2', accountType: 'smarteam', tenantKey: null };
const clientScope = { user: client, routeTenantKey: undefined };
const staffScope = (tenantKey = ACME) => ({ user: staff, routeTenantKey: tenantKey });

function build() {
  const reader = new FakeOperationsReader(sampleOperations());
  const logger = { warn: jest.fn() };
  const operations = new PanelOperations({
    operationsReader: reader,
    tenantDirectory: new FakeTenantDirectory(TENANTS),
    logger,
  });
  return { operations, reader, logger };
}

describe('PanelOperations — tenant scope', () => {
  it('uses the session tenant on client routes', async () => {
    const { operations, reader } = build();
    await operations.listEvents({ scope: clientScope });
    expect(reader.touchedTenants).toEqual([ACME]);
  });

  it('answers not_found for an unknown staff tenant without reading', async () => {
    const { operations, reader } = build();
    for (const call of [
      () => operations.listEvents({ scope: staffScope('sap_integration_fantasma') }),
      () => operations.getEvent({ scope: staffScope({ $ne: 1 }), id: I.event1 }),
      () => operations.listSyncs({ scope: staffScope('') }),
      () => operations.getSync({ scope: staffScope('x'), id: I.sync1 }),
      () => operations.listTasks({ scope: staffScope('x') }),
    ]) {
      expect(await call()).toEqual({ ok: false, reason: 'NOT_FOUND' });
    }
    expect(reader.touchedTenants).toEqual([]);
  });

  it('lets Smarteam read a suspended tenant', async () => {
    const { operations } = build();
    expect((await operations.listEvents({ scope: staffScope('sap_integration_initech') })).data.total).toBe(1);
  });
});

describe('PanelOperations — events', () => {
  it('lists generic events newest first, without reports, payload or audit', async () => {
    const { operations } = build();

    const result = await operations.listEvents({ scope: clientScope, query: {} });

    expect(result.data).toEqual(expect.objectContaining({ page: 1, pageSize: 25, total: 2 }));
    expect(result.data.items.map((event) => event.id)).toEqual([I.event2, I.event1]);
    expect(result.data.items[1]).toEqual({
      id: I.event1,
      type: 'createQuotation',
      status: 'errored',
      retries: 3,
      maxRetries: 3,
      lastError: 'El artículo no existe.',
      cause: { key: 'item_not_found', label: 'Artículo inexistente en destino', group: 'destination_validation' },
      reference: '18374652901',
      createdAt: '2026-10-10T14:00:00.000Z',
      updatedAt: '2026-10-10T14:06:00.000Z',
    });
    expect(result.data.items[0]).toEqual(expect.objectContaining({ status: 'destination_created', reference: '555' }));
  });

  it('filters by status, type, reference and dates', async () => {
    const { operations } = build();
    const list = async (query) => (await operations.listEvents({ scope: clientScope, query })).data.items.map((event) => event.id);

    expect(await list({ status: 'errored' })).toEqual([I.event1]);
    expect(await list({ type: 'createDeal' })).toEqual([I.event2]);
    expect(await list({ reference: '555' })).toEqual([I.event2]);
    expect(await list({ from: '2026-10-11T00:00:00.000Z' })).toEqual([I.event2]);
    expect(await list({ to: '2026-10-11T09:00:00.000Z' })).toEqual([I.event1]);
  });

  it('rejects invalid filters and pagination', async () => {
    const { operations } = build();
    expect((await operations.listEvents({ scope: clientScope, query: { status: 'x' } })).reason).toBe('VALIDATION_ERROR');
    expect((await operations.listEvents({ scope: clientScope, query: { pageSize: '101' } })).reason).toBe('VALIDATION_ERROR');
  });

  it('returns the detail with payload and audit only when asked', async () => {
    const { operations } = build();

    const plain = await operations.getEvent({ scope: clientScope, id: I.event1 });
    const raw = await operations.getEvent({ scope: staffScope(), id: I.event1, withRaw: true });

    expect(plain.data).not.toHaveProperty('payload');
    expect(plain.data).not.toHaveProperty('audit');
    expect(raw.data.payload).toEqual({ deal: { hs_object_id: '18374652901', amount: 10 } });
    expect(raw.data.audit).toEqual({ request: 'interno' });
  });

  it('answers not_found for reports, other tenants and malformed ids', async () => {
    const { operations } = build();
    for (const id of [I.report, I.foreignEvent, 'nope']) {
      expect(await operations.getEvent({ scope: clientScope, id })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    }
  });

  it('logs an unmapped internal status', async () => {
    const { operations, reader, logger } = build();
    reader.events[ACME].push({ _id: '6711a0b1c2d3e4f5000000aa', status: 'nuevo_estado', createdAt: new Date() });

    const result = await operations.listEvents({ scope: clientScope });

    expect(result.data.items[0].status).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ status: 'nuevo_estado' }));
  });

  it('turns a query timeout into a readable validation error', async () => {
    const { operations, reader } = build();
    reader.timeoutNext = true;

    expect(await operations.listEvents({ scope: clientScope })).toEqual({
      ok: false,
      reason: 'QUERY_TIMEOUT',
      message: 'La consulta tardó demasiado. Acota el rango de fechas o agrega filtros.',
    });
  });
});

describe('PanelOperations — syncs and tasks', () => {
  it('lists syncs with their task in one lookup and null for a deleted task', async () => {
    const { operations, reader } = build();

    const result = await operations.listSyncs({ scope: clientScope });

    expect(result.data.items.map((sync) => sync.id)).toEqual([I.sync2, I.sync1]);
    expect(result.data.items[0]).toEqual(expect.objectContaining({ status: 'running', task: null, objectType: 'contact' }));
    expect(result.data.items[1].task).toEqual({ id: I.task1, name: 'Productos', type: 'record_sync' });
    expect(result.data.items[1]).not.toHaveProperty('errors');
    expect(reader.calls.filter((call) => call.method === 'findTasks')).toHaveLength(1);
    expect(JSON.stringify(result.data)).not.toContain('nunca');
  });

  it('filters by running and by task', async () => {
    const { operations } = build();
    expect((await operations.listSyncs({ scope: clientScope, query: { status: 'running' } })).data.items.map((s) => s.id)).toEqual([I.sync2]);
    expect((await operations.listSyncs({ scope: clientScope, query: { taskId: I.task1 } })).data.items.map((s) => s.id)).toEqual([I.sync1]);
  });

  it('pages the errors of a sync detail', async () => {
    const { operations } = build();

    const first = await operations.getSync({ scope: clientScope, id: I.sync1 });
    const last = await operations.getSync({ scope: clientScope, id: I.sync1, query: { errorsPage: '2', errorsPageSize: '25' } });

    expect(first.data.errors).toEqual(expect.objectContaining({ page: 1, pageSize: 25, total: 30 }));
    expect(first.data.errors.items).toHaveLength(25);
    expect(last.data.errors.items.map((error) => error.record)).toEqual(['ITEM-25', 'ITEM-26', 'ITEM-27', 'ITEM-28', 'ITEM-29']);
    expect(first.data.task.name).toBe('Productos');
  });

  it('rejects absurd pages before reading', async () => {
    const { operations, reader } = build();

    expect((await operations.listEvents({ scope: clientScope, query: { page: '99999999999' } })).reason).toBe('VALIDATION_ERROR');
    expect((await operations.listSyncs({ scope: clientScope, query: { page: '101', pageSize: '100' } })).reason).toBe('VALIDATION_ERROR');
    expect((await operations.getSync({ scope: clientScope, id: I.sync1, query: { errorsPage: '1000000' } })).reason).toBe('VALIDATION_ERROR');
    expect(reader.calls).toEqual([]);
  });

  it('validates the errors pagination and answers not_found', async () => {
    const { operations } = build();
    expect((await operations.getSync({ scope: clientScope, id: I.sync1, query: { errorsPageSize: '101' } })).reason).toBe('VALIDATION_ERROR');
    expect(await operations.getSync({ scope: clientScope, id: 'x' })).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('lists the tasks with id, name and type only', async () => {
    const { operations } = build();

    expect((await operations.listTasks({ scope: clientScope })).data).toEqual({
      items: [
        { id: I.task2, name: 'Listas', type: 'dropdown_options' },
        { id: I.task1, name: 'Productos', type: 'record_sync' },
        { id: 'event_queue', name: 'Cola de eventos', type: 'event_queue' },
      ],
    });
  });
});

describe('PanelOperations — plan 5', () => {
  it('gives client routes sanitized errors and staff routes the raw ones', async () => {
    const { operations, reader } = build();
    reader.events[ACME][0].lastError = 'connect ETIMEDOUT 18.213.238.80:443';
    reader.syncs[ACME][0].errorMessage = [{ payload_SAP: { CardCode: 'C1' }, response_SAP: { message: 'x' } }];

    const clientEvent = (await operations.getEvent({ scope: clientScope, id: I.event1 })).data;
    const staffEvent = (await operations.getEvent({ scope: staffScope(), id: I.event1 })).data;
    const clientSync = (await operations.getSync({ scope: clientScope, id: I.sync1 })).data;
    const staffSync = (await operations.getSync({ scope: staffScope(), id: I.sync1 })).data;

    expect(clientEvent.lastError).toBe('Tiempo de espera agotado.');
    expect(staffEvent.lastError).toBe('connect ETIMEDOUT 18.213.238.80:443');
    expect(clientSync.errorMessage).toEqual({ summary: '1 error en la corrida: x' });
    expect(JSON.stringify(clientSync)).not.toMatch(/payload_|response_|CardCode/);
    expect(staffSync.errorMessage).toEqual(reader.syncs[ACME][0].errorMessage);
    expect(clientSync.errors.items[0]).toEqual({ record: 'ITEM-0', message: 'Sin precio' });
  });

  it('shows runs without a task as the event queue and filters them', async () => {
    const { operations, reader } = build();
    reader.syncs[ACME].push({ _id: '6711d0e1f2a3b4c5000000ee', objectType: 'Deal', status: 'completed', recordsProcessed: 0, startedAt: new Date('2026-10-12T06:00:00Z') });

    const queue = await operations.listSyncs({ scope: clientScope, query: { taskId: 'event_queue' } });
    const nonEmpty = await operations.listSyncs({ scope: clientScope, query: { hideEmpty: 'true' } });

    expect(queue.data.items.map((sync) => sync.task)).toEqual([{ id: 'event_queue', name: 'Cola de eventos', type: 'event_queue' }]);
    expect(nonEmpty.data.items.map((sync) => sync.id)).toEqual([I.sync1]);
  });

  it('builds the integration dashboard for the period', async () => {
    const { operations } = build();

    const result = await operations.dashboard({
      scope: clientScope,
      query: { from: '2026-10-09T06:00:00.000Z', to: '2026-10-12T06:00:00.000Z', tz: 'America/Costa_Rica' },
    });

    expect(result.data.totals).toEqual(expect.objectContaining({ documents: 2, created: 1, errored: 1 }));
    expect(result.data.byDay).toHaveLength(3);
  });

  it('rejects an invalid period and a period with too many events', async () => {
    const { operations, reader } = build();
    const query = { from: '2026-10-09T06:00:00.000Z', to: '2026-10-12T06:00:00.000Z', tz: 'America/Costa_Rica' };

    expect(await operations.dashboard({ scope: clientScope, query: { ...query, tz: 'x' } }))
      .toEqual({ ok: false, reason: 'VALIDATION_ERROR', message: 'Período o zona horaria inválidos.' });

    reader.listEventsForSummary = async () => ({ items: [], truncated: true });
    expect(await operations.dashboard({ scope: clientScope, query }))
      .toEqual({ ok: false, reason: 'VALIDATION_ERROR', message: 'El período tiene demasiados eventos; acórtalo.' });
  });

  it('answers not_found on the dashboard of an unknown tenant', async () => {
    const { operations, reader } = build();
    expect(await operations.dashboard({ scope: staffScope('sap_integration_fantasma'), query: {} })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(reader.touchedTenants).toEqual([]);
  });
});

describe('PanelOperations — queue run errors (plan 5b)', () => {
  const RUN = '6711d0e1f2a3b4c5000000ab';
  const entry = (reference, message) => ({
    payload_Hubspot: { deal: { hs_object_id: reference } },
    payload_SAP: { CardCode: 'C1' },
    response_hubspot: null,
    response_SAP: { error: { message } },
  });

  function withQueueRun(reader, errorMessage) {
    reader.syncs[ACME].push({
      _id: RUN,
      objectType: 'Deal',
      status: 'errored',
      recordsProcessed: 3,
      failed: errorMessage.length,
      errorMessage,
      errors: [],
      startedAt: new Date('2026-10-12T10:00:00Z'),
      finishedAt: new Date('2026-10-12T10:00:30Z'),
    });
    reader.events[ACME].push(
      { _id: '6711a0b1c2d3e4f5000000e1', status: 'errored', payload: { deal: { hs_object_id: '111' } }, createdAt: new Date('2026-10-12T09:00:00Z'), updatedAt: new Date('2026-10-12T10:00:20Z') },
      { _id: '6711a0b1c2d3e4f5000000e2', status: 'errored', payload: { deal: { hs_object_id: '222' } }, createdAt: new Date('2026-10-12T09:00:00Z'), updatedAt: new Date('2026-10-12T10:00:21Z') },
      { _id: '6711a0b1c2d3e4f5000000e3', status: 'errored', payload: { deal: { hs_object_id: '222' } }, createdAt: new Date('2026-10-12T09:00:00Z'), updatedAt: new Date('2026-10-12T10:00:22Z') },
      { _id: '6711a0b1c2d3e4f5000000e4', status: 'errored', payload: { deal: { hs_object_id: '333' } }, createdAt: new Date('2026-10-01T09:00:00Z'), updatedAt: new Date('2026-10-01T10:00:00Z') },
    );
  }

  it('derives the items from errorMessage with total, sanitized messages and event ids', async () => {
    const { operations, reader } = build();
    withQueueRun(reader, [entry('111', 'connect ETIMEDOUT 10.0.0.1:443'), entry('222', 'El Correo Electrónico del Socio no puede ser omitido.'), entry('333', 'Otro')]);

    const client = await operations.getSync({ scope: clientScope, id: RUN });
    const staff = await operations.getSync({ scope: staffScope(), id: RUN });

    expect(client.data.errors).toEqual({
      items: [
        { record: '111', message: 'Tiempo de espera agotado.', eventId: '6711a0b1c2d3e4f5000000e1' },
        { record: '222', message: 'El Correo Electrónico del Socio no puede ser omitido.', eventId: null },
        { record: '333', message: 'Otro', eventId: null },
      ],
      page: 1,
      pageSize: 25,
      total: 3,
    });
    expect(client.data.errors.total).toBe(client.data.counts.failed);
    expect(client.data.errorMessage).toEqual({ summary: '3 errores en la corrida: Tiempo de espera agotado.' });
    expect(JSON.stringify(client.data)).not.toMatch(/payload_|response_|CardCode|10\.0\.0\.1/);
    expect(staff.data.errors.items[0]).toEqual({ record: '111', message: 'connect ETIMEDOUT 10.0.0.1:443', eventId: '6711a0b1c2d3e4f5000000e1' });
    expect(staff.data.errorMessage).toHaveLength(3);
  });

  it('pages the derived items', async () => {
    const { operations, reader } = build();
    withQueueRun(reader, [entry('111', 'a'), entry('222', 'b'), entry('333', 'c')]);

    const second = await operations.getSync({ scope: clientScope, id: RUN, query: { errorsPage: '2', errorsPageSize: '2' } });

    expect(second.data.errors.items.map((item) => item.record)).toEqual(['333']);
    expect(second.data.errors.total).toBe(3);
  });

  it('does not guess an event for a deal that failed twice in the same run', async () => {
    const { operations, reader } = build();
    withQueueRun(reader, [entry('111', 'a'), entry('111', 'b')]);

    const result = await operations.getSync({ scope: clientScope, id: RUN });

    expect(result.data.errors.items.map((item) => item.eventId)).toEqual([null, null]);
  });

  it('leaves runs with their own errors as before', async () => {
    const { operations } = build();
    const result = await operations.getSync({ scope: clientScope, id: I.sync1 });
    expect(result.data.errors.items[0]).toEqual({ record: 'ITEM-0', message: 'Sin precio' });
  });
});

describe('PanelOperations — exchange (plan 5c)', () => {
  it('adds a sanitized exchange to the client detail and a raw one for Smarteam', async () => {
    const { operations, reader } = build();
    reader.events[ACME][0].sapAudit = {
      payloadSap: { quotation: { CardCode: 'C1' } },
      responseSap: { businessPartner: { ContactEmployees: [{ Name: 'Ana', Password: '12017' }] } },
      sapCalls: [{ path: '/b1s/v1/Quotations' }],
    };

    const client = (await operations.getEvent({ scope: clientScope, id: I.event1 })).data;
    const staff = (await operations.getEvent({ scope: staffScope(), id: I.event1 })).data;

    expect(reader.calls.find((call) => call.method === 'findEvent').args.withExchange).toBe(true);
    expect(client.exchange).toEqual({
      received: { deal: { hs_object_id: '18374652901', amount: 10 } },
      sent: { quotation: { CardCode: 'C1' } },
      response: { businessPartner: { ContactEmployees: [{ Name: 'Ana' }] } },
    });
    expect(client).not.toHaveProperty('payload');
    expect(client).not.toHaveProperty('audit');
    expect(JSON.stringify(client)).not.toMatch(/12017|sapCalls|b1s/);
    expect(staff.exchange.response.businessPartner.ContactEmployees[0].Password).toBe('12017');
  });

  it('returns null parts for an event without audit and never adds exchange to lists', async () => {
    const { operations } = build();

    const detail = (await operations.getEvent({ scope: clientScope, id: I.event2 })).data;
    const list = (await operations.listEvents({ scope: clientScope })).data;

    expect(detail.exchange).toEqual({ received: { deal: { hs_object_id: 555 } }, sent: null, response: null });
    expect(list.items.every((item) => !('exchange' in item))).toBe(true);
  });
});

