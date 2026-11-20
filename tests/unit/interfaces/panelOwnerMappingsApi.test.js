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

const SECRET = 'panel-owner-mappings-api-secret-32-chars';
const ACME = 'sap_integration_acme';
const INITECH = 'sap_integration_initech';

async function buildApp() {
  const staff = staffUser();
  const ana = clientUser();
  const tokens = new HmacSessionToken({ secret: SECRET });
  const ownerMappingReader = new FakeOwnerMappingReader(sampleOwnerMappings());
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
    operationsReader: new FakeOperationsReader(sampleOperations()),
    ownerMappingReader,
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  });
  const app = Fastify();
  app.register(panelPlugin, { prefix: '/panel/api', secret: SECRET, useCases, logger: { warn: jest.fn(), error: jest.fn() } });
  await app.ready();
  const cookieFor = (user) => `panel_session=${tokens.sign({ sub: user.id, tv: 0, pwdChange: false })}`;
  return { app, ownerMappingReader, cookies: { staff: cookieFor(staff), ana: cookieFor(ana) } };
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
