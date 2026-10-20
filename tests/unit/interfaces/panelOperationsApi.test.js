import { jest } from '@jest/globals';
import Fastify from 'fastify';
import panelPlugin from '../../../src/interfaces/http/panel/panelPlugin.js';
import { buildPanelUseCases } from '../../../src/composition/panel.composition.js';
import HmacSessionToken from '../../../src/infrastructure/auth/HmacSessionToken.js';
import {
  FakeLoginAttempts,
  FakePasswordHasher,
  FakeRevokedSessions,
  FakeTenantDirectory,
  InMemoryPanelUserRepository,
  RecordingAuditLog,
  SequenceTemporaryPassword,
  TENANTS,
  clientUser,
  staffUser,
} from '../application/panel/panelFakes.js';
import { FakeAttachmentStore, FakeContextReader, InMemoryTicketRepository } from '../application/panel/ticketFakes.js';
import { FakeOperationsReader, OPS_IDS as I, sampleOperations } from '../application/panel/operationFakes.js';

const SECRET = 'panel-operations-api-secret-32-chars-min';
const ACME = 'sap_integration_acme';
const INITECH = 'sap_integration_initech';

async function buildApp() {
  const staff = staffUser();
  const ana = clientUser();
  const tokens = new HmacSessionToken({ secret: SECRET });
  const operationsReader = new FakeOperationsReader(sampleOperations());
  const useCases = buildPanelUseCases({
    secret: SECRET,
    userRepository: new InMemoryPanelUserRepository([staff, ana]),
    tenantDirectory: new FakeTenantDirectory(TENANTS),
    passwordHasher: new FakePasswordHasher(),
    temporaryPasswordGenerator: new SequenceTemporaryPassword(),
    loginAttempts: new FakeLoginAttempts(),
    auditLog: new RecordingAuditLog(),
    revokedSessions: new FakeRevokedSessions(),
    sessionToken: tokens,
    ticketRepository: new InMemoryTicketRepository(),
    attachmentStore: new FakeAttachmentStore(),
    contextReader: new FakeContextReader(),
    operationsReader,
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  });
  const app = Fastify();
  app.register(panelPlugin, { prefix: '/panel/api', secret: SECRET, useCases, logger: { warn: jest.fn(), error: jest.fn() } });
  await app.ready();
  const cookieFor = (user) => `panel_session=${tokens.sign({ sub: user.id, tv: 0, pwdChange: false })}`;
  return { app, operationsReader, staffUser: staff, cookies: { staff: cookieFor(staff), ana: cookieFor(ana) } };
}

function get(ctx, url, cookie) {
  return ctx.app.inject({ method: 'GET', url: `/panel/api${url}`, headers: cookie ? { cookie } : {} });
}

function hasKeyDeep(value, key) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Object.entries(value).some(([name, nested]) => name === key || hasKeyDeep(nested, key));
}

// Nombres de sistemas en las CLAVES de la respuesta (los valores pueden traer texto libre).
function keysMentionSystems(value, path = []) {
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value).flatMap(([key, nested]) => {
    if (key === 'payload' || key === 'audit') {
      return [];
    }
    const own = /sap|hubspot/i.test(key) ? [[...path, key].join('.')] : [];
    return [...own, ...keysMentionSystems(nested, [...path, key])];
  });
}

describe('/panel/api events and syncs', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('serves the client its own events without payload or audit (E1, E4)', async () => {
    const list = await get(ctx, '/events', ctx.cookies.ana);
    const detail = await get(ctx, `/events/${I.event1}`, ctx.cookies.ana);

    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual(expect.objectContaining({ page: 1, pageSize: 25, total: 2 }));
    expect(detail.json()).toEqual(expect.objectContaining({ id: I.event1, status: 'errored', reference: '18374652901' }));
    for (const body of [list.json(), detail.json()]) {
      expect(hasKeyDeep(body, 'payload')).toBe(false);
      expect(hasKeyDeep(body, 'audit')).toBe(false);
      expect(JSON.stringify(body)).not.toContain('interno');
    }
    expect(list.headers['cache-control']).toBe('no-store');
  });

  it('answers 404 for an event of another tenant or a report', async () => {
    expect((await get(ctx, `/events/${I.foreignEvent}`, ctx.cookies.ana)).statusCode).toBe(404);
    expect((await get(ctx, `/events/${I.report}`, ctx.cookies.ana)).statusCode).toBe(404);
  });

  it('ignores any tenant the client tries to pass', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/panel/api/events?tenantKey=${INITECH}`,
      headers: { cookie: ctx.cookies.ana, 'x-tenant-id': INITECH },
    });

    expect(response.json().items.map((event) => event.id)).toEqual([I.event2, I.event1]);
  });

  it('answers 403 to Smarteam on client routes and to a client on staff routes', async () => {
    expect((await get(ctx, '/events', ctx.cookies.staff)).statusCode).toBe(403);
    expect((await get(ctx, '/sync-tasks', ctx.cookies.staff)).statusCode).toBe(403);
    expect((await get(ctx, `/staff/tenants/${ACME}/events`, ctx.cookies.ana)).statusCode).toBe(403);
    expect((await get(ctx, `/staff/tenants/${ACME}/syncs`, ctx.cookies.ana)).json()).toEqual({ error: 'forbidden' });
  });

  it('gives Smarteam payload and audit with staff.events.raw', async () => {
    const detail = await get(ctx, `/staff/tenants/${ACME}/events/${I.event1}`, ctx.cookies.staff);

    expect(detail.json()).toEqual(expect.objectContaining({
      payload: { deal: { hs_object_id: '18374652901', amount: 10 } },
      audit: { request: 'interno' },
    }));
  });

  it('answers 404 for an unknown tenant without reading, and reads a suspended one', async () => {
    const unknown = await get(ctx, '/staff/tenants/sap_integration_fantasma/events', ctx.cookies.staff);
    expect(unknown.statusCode).toBe(404);
    expect(ctx.operationsReader.touchedTenants).toEqual([]);

    const suspended = await get(ctx, `/staff/tenants/${INITECH}/events`, ctx.cookies.staff);
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().total).toBe(1);
  });

  it('serves syncs with their task and paged errors (E5 to E8)', async () => {
    const list = await get(ctx, '/syncs?status=errored', ctx.cookies.ana);
    const detail = await get(ctx, `/syncs/${I.sync1}?errorsPage=2&errorsPageSize=10`, ctx.cookies.ana);
    const tasks = await get(ctx, '/sync-tasks', ctx.cookies.ana);
    const staffTasks = await get(ctx, `/staff/tenants/${ACME}/sync-tasks`, ctx.cookies.staff);

    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).not.toHaveProperty('errors');
    expect(detail.json().errors).toEqual(expect.objectContaining({ page: 2, pageSize: 10, total: 30 }));
    expect(detail.json().errors.items[0]).toEqual({ record: 'ITEM-10', message: 'Sin precio' });
    expect(tasks.json().items).toEqual([
      { id: I.task2, name: 'Listas', type: 'dropdown_options' },
      { id: I.task1, name: 'Productos', type: 'record_sync' },
      { id: 'event_queue', name: 'Cola de eventos', type: 'event_queue' },
    ]);
    expect(staffTasks.json()).toEqual(tasks.json());
    expect(JSON.stringify(tasks.json())).not.toContain('nunca');
  });

  it('never uses system names in the response keys', async () => {
    const bodies = [
      (await get(ctx, '/events', ctx.cookies.ana)).json(),
      (await get(ctx, `/staff/tenants/${ACME}/events/${I.event1}`, ctx.cookies.staff)).json(),
      (await get(ctx, '/syncs', ctx.cookies.ana)).json(),
      (await get(ctx, `/syncs/${I.sync1}`, ctx.cookies.ana)).json(),
      (await get(ctx, '/sync-tasks', ctx.cookies.ana)).json(),
    ];
    for (const body of bodies) {
      expect(keysMentionSystems(body)).toEqual([]);
    }
  });

  it('answers 400 with a readable message for invalid filters and timeouts', async () => {
    expect((await get(ctx, '/events?status=report', ctx.cookies.ana)).json()).toEqual({ error: 'validation_error', message: 'Estado inválido.' });
    expect((await get(ctx, '/events?from=ayer', ctx.cookies.ana)).json()).toEqual({ error: 'validation_error', message: 'Fecha inválida.' });
    expect((await get(ctx, '/syncs?taskId=abc', ctx.cookies.ana)).json()).toEqual({ error: 'validation_error', message: 'Tarea inválida.' });

    ctx.operationsReader.timeoutNext = true;
    const slow = await get(ctx, '/events', ctx.cookies.ana);
    expect(slow.statusCode).toBe(400);
    expect(slow.json()).toEqual({ error: 'validation_error', message: 'La consulta tardó demasiado. Acota el rango de fechas o agrega filtros.' });
  });
});

describe('/panel/api plan 5 — dashboards, metrics and client-safe errors', () => {
  let ctx;
  const period = 'from=2026-10-09T06:00:00.000Z&to=2026-10-12T06:00:00.000Z&tz=America%2FCosta_Rica';
  beforeEach(async () => {
    ctx = await buildApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('never sends a client the payloads stored in run errors, and sends them to Smarteam', async () => {
    ctx.operationsReader.syncs[ACME][0].errorMessage = [{ payload_SAP: { CardCode: 'C1' }, response_hubspot: { status: 500 } }];

    const client = await get(ctx, `/syncs/${I.sync1}`, ctx.cookies.ana);
    const staff = await get(ctx, `/staff/tenants/${ACME}/syncs/${I.sync1}`, ctx.cookies.staff);

    expect(client.json().errorMessage).toEqual({ summary: '1 error(es) en la corrida' });
    expect(JSON.stringify(client.json())).not.toMatch(/payload_|response_|CardCode/);
    expect(staff.json().errorMessage).toEqual([{ payload_SAP: { CardCode: 'C1' }, response_hubspot: { status: 500 } }]);
  });

  it('serves the integration dashboard to both scopes', async () => {
    const client = await get(ctx, `/dashboard/integration?${period}`, ctx.cookies.ana);
    const staff = await get(ctx, `/staff/tenants/${ACME}/dashboard/integration?${period}`, ctx.cookies.staff);

    expect(client.statusCode).toBe(200);
    expect(client.json().totals).toEqual(expect.objectContaining({ documents: 2 }));
    expect(staff.json()).toEqual(client.json());
    expect(JSON.stringify(client.json())).not.toMatch(/interno|payload|audit/);
    expect((await get(ctx, `/dashboard/integration?${period}`, ctx.cookies.staff)).statusCode).toBe(403);
    expect((await get(ctx, `/staff/tenants/${ACME}/dashboard/integration?${period}`, ctx.cookies.ana)).statusCode).toBe(403);
    expect((await get(ctx, `/staff/tenants/sap_integration_fantasma/dashboard/integration?${period}`, ctx.cookies.staff)).statusCode).toBe(404);
    expect((await get(ctx, '/dashboard/integration', ctx.cookies.ana)).json()).toEqual({ error: 'validation_error', message: 'Período o zona horaria inválidos.' });
  });

  it('serves ticket metrics, with byTenant only for Smarteam, and never as a ticket id', async () => {
    const client = await get(ctx, `/tickets/metrics?${period}`, ctx.cookies.ana);
    const staff = await get(ctx, `/staff/tickets/metrics?${period}`, ctx.cookies.staff);

    expect(client.statusCode).toBe(200);
    expect(client.json()).toEqual(expect.objectContaining({ totals: expect.any(Object), buckets: expect.any(Array) }));
    expect(client.json()).not.toHaveProperty('byTenant');
    expect(staff.json().byTenant.map((row) => row.tenantKey)).toEqual(expect.arrayContaining([ACME, INITECH]));
    expect((await get(ctx, `/tickets/metrics?${period}`, ctx.cookies.staff)).statusCode).toBe(403);
    expect((await get(ctx, `/staff/tickets/metrics?${period}`, ctx.cookies.ana)).statusCode).toBe(403);
    expect((await get(ctx, `/staff/tickets/metrics?${period}&category=ventas`, ctx.cookies.staff)).statusCode).toBe(400);
    expect((await get(ctx, `/staff/tickets/metrics?${period}&tenantKey=sap_integration_fantasma`, ctx.cookies.staff)).statusCode).toBe(404);
  });
});

describe('/panel/api event exchange (plan 5c)', () => {
  it('never sends a client credentials from the ERP response', async () => {
    const ctx = await buildApp();
    ctx.operationsReader.events[ACME][0].sapAudit = {
      payloadSap: { order: { CardCode: 'C1' } },
      responseSap: { contactEmployee: [{ Name: 'Ana', Password: '12017', token: 'abc' }] },
    };

    const client = await get(ctx, `/events/${I.event1}`, ctx.cookies.ana);
    const staff = await get(ctx, `/staff/tenants/${ACME}/events/${I.event1}`, ctx.cookies.staff);

    expect(client.json().exchange.response).toEqual({ contactEmployee: [{ Name: 'Ana' }] });
    expect(client.body).not.toMatch(/12017|"token"/);
    expect(staff.json().exchange.response.contactEmployee[0].Password).toBe('12017');
    await ctx.app.close();
  });
});

