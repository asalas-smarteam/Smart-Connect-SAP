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
import {
  FakeOperationsReader,
  FakeOwnerMappingReader,
  OWNER_IDS as O,
  sampleOperations,
  sampleOwnerMappings,
} from '../application/panel/operationFakes.js';
import {
  ACME_CREDENTIAL_2,
  InMemoryOwnerMappingWriter,
  sampleCrmDirectory,
} from '../application/panel/ownerMappingWriteFakes.js';

const SECRET = 'panel-owner-mappings-api-secret-32-chars';
const ACME = 'sap_integration_acme';
const INITECH = 'sap_integration_initech';
const VERSION = '2026-07-03T02:03:51.125Z';

async function buildApp() {
  const staff = staffUser();
  const ana = clientUser();
  // Plan 12: rol usuario (sin owners.write) y admin de otra empresa.
  const usuario = clientUser({ email: 'usuario@acme.test', role: 'usuario' });
  const initech = clientUser({ email: 'admin@initech.test', tenantKey: INITECH });
  const tokens = new HmacSessionToken({ secret: SECRET });
  const ownerMappingReader = new FakeOwnerMappingReader(sampleOwnerMappings());
  const ownerMappingWriter = new InMemoryOwnerMappingWriter();
  const crmOwnerDirectory = sampleCrmDirectory();
  const useCases = buildPanelUseCases({
    secret: SECRET,
    userRepository: new InMemoryPanelUserRepository([staff, ana, usuario, initech]),
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
    operationsReader: new FakeOperationsReader(sampleOperations()),
    ownerMappingReader,
    ownerMappingWriter,
    crmOwnerDirectory,
    ownerSyncAttempts: new FakeLoginAttempts(1),
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  });
  const app = Fastify();
  app.register(panelPlugin, { prefix: '/panel/api', secret: SECRET, useCases, logger: { warn: jest.fn(), error: jest.fn() } });
  await app.ready();
  const cookieFor = (user) => `panel_session=${tokens.sign({ sub: user.id, tv: 0, pwdChange: false })}`;
  return {
    app,
    ownerMappingReader,
    ownerMappingWriter,
    crmOwnerDirectory,
    cookies: { staff: cookieFor(staff), ana: cookieFor(ana), usuario: cookieFor(usuario), initech: cookieFor(initech) },
  };
}

function get(ctx, url, cookie) {
  return ctx.app.inject({ method: 'GET', url: `/panel/api${url}`, headers: cookie ? { cookie } : {} });
}

describe('/panel/api owner mappings (plan 11, contract 13)', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('serves the client the records of its own company (N1, N2)', async () => {
    const response = await get(ctx, '/owner-mappings', ctx.cookies.ana);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body)).toEqual(['items']);
    expect(body.items.map((item) => item.id)).toEqual([O.erick, O.ana, O.legacy]);
    expect(body.items[0]).toEqual({
      id: O.erick,
      crmOwnerId: '82929225',
      crmOwnerName: 'Erick Figueroa',
      crmOwnerEmail: 'ventas8@acme.test',
      erpOwnerId: '53',
      erpOwnerName: null,
      erpEmployeeId: '67',
      active: true,
      source: 'crm_seed',
      createdAt: '2026-07-03T02:03:51.125Z',
      updatedAt: '2026-07-03T02:03:51.125Z',
    });
    expect(ctx.ownerMappingReader.touchedTenants).toEqual(['sap_integration_acme']);
  });

  it('never sends internal fields or system names in the keys', async () => {
    const response = await get(ctx, '/owner-mappings', ctx.cookies.ana);

    expect(response.body).not.toMatch(/hubspotCredentialId|__v|hubspot_seed|"sapOwner|"hubspotOwner/);
  });

  it('serves Smarteam the same list by company and 404 for an unknown one', async () => {
    const asClient = await get(ctx, '/owner-mappings', ctx.cookies.ana);
    const asStaff = await get(ctx, `/staff/tenants/${ACME}/owner-mappings`, ctx.cookies.staff);
    const unknown = await get(ctx, '/staff/tenants/sap_integration_fantasma/owner-mappings', ctx.cookies.staff);

    expect(asStaff.statusCode).toBe(200);
    expect(asStaff.json()).toEqual(asClient.json());
    expect(unknown.statusCode).toBe(404);
  });

  it('answers an empty list for a company without records', async () => {
    const response = await get(ctx, `/staff/tenants/${INITECH}/owner-mappings`, ctx.cookies.staff);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it('answers 403 forbidden to the wrong kind of account and 401 without a session', async () => {
    const clientOnStaff = await get(ctx, `/staff/tenants/${ACME}/owner-mappings`, ctx.cookies.ana);
    const staffOnClient = await get(ctx, '/owner-mappings', ctx.cookies.staff);
    const anonymous = await get(ctx, '/owner-mappings');

    for (const response of [clientOnStaff, staffOnClient]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'forbidden' });
    }
    expect(anonymous.statusCode).toBe(401);
    expect(ctx.ownerMappingReader.touchedTenants).toEqual([]);
  });

  it('answers 400 when the query times out', async () => {
    ctx.ownerMappingReader.timeoutNext = true;

    expect((await get(ctx, '/owner-mappings', ctx.cookies.ana)).statusCode).toBe(400);
  });
});

function send(ctx, method, url, { cookie, payload, panelHeader = true } = {}) {
  const headers = {};
  if (cookie) {
    headers.cookie = cookie;
  }
  if (panelHeader) {
    headers['x-panel-request'] = '1';
  }
  return ctx.app.inject({ method, url: `/panel/api${url}`, headers, payload });
}

function body(overrides = {}) {
  return { erpOwnerId: '113,758', erpEmployeeId: '70', expectedUpdatedAt: VERSION, ...overrides };
}

describe('/panel/api owner mappings edit (plan 12, contract 14)', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('lists owners.write in /auth/me for the client admin and Smarteam, not for usuario (O1)', async () => {
    const permissions = async (cookie) => (await get(ctx, '/auth/me', cookie)).json().permissions;

    expect(await permissions(ctx.cookies.ana)).toContain('owners.write');
    expect(await permissions(ctx.cookies.staff)).toContain('owners.write');
    expect(await permissions(ctx.cookies.usuario)).not.toContain('owners.write');
  });

  it('lets the client admin edit a row of its company (O2)', async () => {
    const response = await send(ctx, 'PATCH', `/owner-mappings/${O.erick}`, { cookie: ctx.cookies.ana, payload: body({ erpOwnerId: ' 113, 758 ' }) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ id: O.erick, erpOwnerId: '113,758', erpEmployeeId: '70' }));
    expect(response.body).not.toMatch(/hubspotCredentialId|__v|"sapOwner/);
    expect(ctx.ownerMappingWriter.historyOf(ACME)).toHaveLength(1);
  });

  it('lets Smarteam edit through the staff route and 404 for an unknown company', async () => {
    const ok = await send(ctx, 'PATCH', `/staff/tenants/${ACME}/owner-mappings/${O.erick}`, { cookie: ctx.cookies.staff, payload: body() });
    const unknown = await send(ctx, 'PATCH', `/staff/tenants/sap_integration_fantasma/owner-mappings/${O.erick}`, { cookie: ctx.cookies.staff, payload: body() });

    expect(ok.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'not_found' });
  });

  it('answers 403 forbidden to usuario on PATCH and sync without writing', async () => {
    const edit = await send(ctx, 'PATCH', `/owner-mappings/${O.erick}`, { cookie: ctx.cookies.usuario, payload: body() });
    const sync = await send(ctx, 'POST', '/owner-mappings/sync', { cookie: ctx.cookies.usuario });

    for (const response of [edit, sync]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'forbidden' });
    }
    expect(ctx.ownerMappingWriter.updateCalls).toBe(0);
    expect(ctx.crmOwnerDirectory.listCalls).toBe(0);
  });

  it('answers 403 to the wrong kind of account on the edit routes', async () => {
    const clientOnStaff = await send(ctx, 'POST', `/staff/tenants/${ACME}/owner-mappings/sync`, { cookie: ctx.cookies.ana });
    const staffOnClient = await send(ctx, 'PATCH', `/owner-mappings/${O.erick}`, { cookie: ctx.cookies.staff, payload: body() });

    expect(clientOnStaff.statusCode).toBe(403);
    expect(staffOnClient.statusCode).toBe(403);
  });

  it('answers 404 to a client asking for a row of another company', async () => {
    const response = await send(ctx, 'PATCH', `/owner-mappings/${O.erick}`, { cookie: ctx.cookies.initech, payload: body() });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it('answers 403 missing_panel_header without X-Panel-Request', async () => {
    const edit = await send(ctx, 'PATCH', `/owner-mappings/${O.erick}`, { cookie: ctx.cookies.ana, payload: body(), panelHeader: false });
    const sync = await send(ctx, 'POST', '/owner-mappings/sync', { cookie: ctx.cookies.ana, panelHeader: false });

    for (const response of [edit, sync]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'missing_panel_header' });
    }
  });

  it.each([
    ['a non-editable field', body({ active: false })],
    ['an employee list', body({ erpEmployeeId: '1,2' })],
    ['an object', body({ erpOwnerId: { $gt: '' } })],
    ['an array', body({ erpEmployeeId: ['1'] })],
    ['a boolean', body({ erpOwnerId: true })],
    ['no expectedUpdatedAt', { erpOwnerId: '1', erpEmployeeId: '2' }],
    ['no code', { expectedUpdatedAt: VERSION }],
    ['a JSON array body', [1, 2]],
  ])('answers 400 validation_error for %s (never 500)', async (_label, payload) => {
    const response = await send(ctx, 'PATCH', `/owner-mappings/${O.erick}`, { cookie: ctx.cookies.ana, payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'validation_error', message: expect.any(String) });
  });

  it('answers 400 for an empty body', async () => {
    const response = await send(ctx, 'PATCH', `/owner-mappings/${O.erick}`, { cookie: ctx.cookies.ana });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_error');
  });

  it('answers 409 stale_update and 409 erp_owner_taken', async () => {
    const first = await send(ctx, 'PATCH', `/owner-mappings/${O.erick}`, { cookie: ctx.cookies.ana, payload: body() });
    const stale = await send(ctx, 'PATCH', `/owner-mappings/${O.erick}`, { cookie: ctx.cookies.ana, payload: body({ erpOwnerId: '1' }) });
    const taken = await send(ctx, 'PATCH', `/owner-mappings/${O.erick}`, {
      cookie: ctx.cookies.ana,
      payload: body({ erpOwnerId: '113,758,864', expectedUpdatedAt: first.json().updatedAt }),
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'stale_update', message: expect.any(String) });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'erp_owner_taken', message: expect.any(String) });
  });

  it('syncs from the CRM for the client admin and Smarteam (O3)', async () => {
    const asClient = await send(ctx, 'POST', '/owner-mappings/sync', { cookie: ctx.cookies.ana });

    expect(asClient.statusCode).toBe(200);
    expect(asClient.json()).toEqual({ added: 2, updated: 1, total: 5 });

    const fresh = await buildApp();
    const asStaff = await send(fresh, 'POST', `/staff/tenants/${ACME}/owner-mappings/sync`, { cookie: fresh.cookies.staff });
    await fresh.app.close();
    expect(asStaff.statusCode).toBe(200);
  });

  it('answers 429 too_many_requests with Retry-After on the second sync within a minute', async () => {
    await send(ctx, 'POST', '/owner-mappings/sync', { cookie: ctx.cookies.ana });
    const second = await send(ctx, 'POST', `/staff/tenants/${ACME}/owner-mappings/sync`, { cookie: ctx.cookies.staff });

    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBe('60');
    expect(second.json()).toEqual({ error: 'too_many_requests', message: expect.any(String) });
  });

  it('answers 502 crm_unavailable when the CRM fails', async () => {
    ctx.crmOwnerDirectory.credentialsByTenant[ACME].push(ACME_CREDENTIAL_2);
    ctx.crmOwnerDirectory.failing.add(ACME_CREDENTIAL_2);

    const response = await send(ctx, 'POST', '/owner-mappings/sync', { cookie: ctx.cookies.ana });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'crm_unavailable', message: expect.any(String) });
  });

  it('answers 502 crm_unavailable for a company without CRM credential', async () => {
    const response = await send(ctx, 'POST', `/staff/tenants/${INITECH}/owner-mappings/sync`, { cookie: ctx.cookies.staff });

    expect(response.statusCode).toBe(502);
  });
});
