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
  FakeFieldMappingReader,
  FakeOperationsReader,
  MAPPING_IDS as M,
  sampleFieldMappings,
  sampleOperations,
} from '../application/panel/operationFakes.js';

const SECRET = 'panel-field-mappings-api-secret-32-chars';
const ACME = 'sap_integration_acme';
const INITECH = 'sap_integration_initech';

async function buildApp() {
  const staff = staffUser();
  const ana = clientUser();
  const tokens = new HmacSessionToken({ secret: SECRET });
  const fieldMappingReader = new FakeFieldMappingReader(sampleFieldMappings());
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
    fieldMappingReader,
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  });
  const app = Fastify();
  app.register(panelPlugin, { prefix: '/panel/api', secret: SECRET, useCases, logger: { warn: jest.fn(), error: jest.fn() } });
  await app.ready();
  const cookieFor = (user) => `panel_session=${tokens.sign({ sub: user.id, tv: 0, pwdChange: false })}`;
  return { app, fieldMappingReader, cookies: { staff: cookieFor(staff), ana: cookieFor(ana) } };
}

function get(ctx, url, cookie) {
  return ctx.app.inject({ method: 'GET', url: `/panel/api${url}`, headers: cookie ? { cookie } : {} });
}

describe('/panel/api field mappings (plan 6, contract 08)', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('serves the client the mappings of its own company (I1, I2)', async () => {
    const response = await get(ctx, '/field-mappings', ctx.cookies.ana);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body)).toEqual(['items']);
    expect(body.items.map((item) => item.id)).toEqual([M.stock, M.name, M.legacy]);
    expect(body.items[0]).toEqual({
      id: M.stock,
      sourceField: 'QuantityOnStock',
      targetField: 'quantity',
      objectType: 'product',
      sourceContext: 'product',
      isActive: true,
      editable: false,
      includeInSourceQuery: false,
      userField: false,
    });
    expect(ctx.fieldMappingReader.touchedTenants).toEqual([ACME]);
  });

  it('never sends internal fields', async () => {
    const response = await get(ctx, '/field-mappings', ctx.cookies.ana);

    expect(response.body).not.toMatch(/clientConfigId|hubspotCredentialId|includeInServiceLayerSelect/);
  });

  it('serves Smarteam the same list by company', async () => {
    const asClient = await get(ctx, '/field-mappings', ctx.cookies.ana);
    const asStaff = await get(ctx, `/staff/tenants/${ACME}/field-mappings`, ctx.cookies.staff);

    expect(asStaff.statusCode).toBe(200);
    expect(asStaff.json()).toEqual(asClient.json());
  });

  it('answers 404 for an unknown company without reading', async () => {
    const response = await get(ctx, '/staff/tenants/sap_integration_fantasma/field-mappings', ctx.cookies.staff);

    expect(response.statusCode).toBe(404);
    expect(ctx.fieldMappingReader.touchedTenants).toEqual([]);
  });

  it('answers an empty list for a company without mappings', async () => {
    const response = await get(ctx, `/staff/tenants/${INITECH}/field-mappings`, ctx.cookies.staff);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it('answers 403 forbidden to the wrong kind of account', async () => {
    const clientOnStaff = await get(ctx, `/staff/tenants/${ACME}/field-mappings`, ctx.cookies.ana);
    const staffOnClient = await get(ctx, '/field-mappings', ctx.cookies.staff);

    for (const response of [clientOnStaff, staffOnClient]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'forbidden' });
    }
    expect(ctx.fieldMappingReader.touchedTenants).toEqual([]);
  });

  it('answers 401 without a session', async () => {
    const response = await get(ctx, '/field-mappings');

    expect(response.statusCode).toBe(401);
  });

  it('answers 400 when the query times out', async () => {
    ctx.fieldMappingReader.timeoutNext = true;

    const response = await get(ctx, '/field-mappings', ctx.cookies.ana);

    expect(response.statusCode).toBe(400);
  });

  it('lists mappings.read in /auth/me for clients and Smarteam (I3)', async () => {
    for (const cookie of [ctx.cookies.ana, ctx.cookies.staff]) {
      const response = await get(ctx, '/auth/me', cookie);
      expect(response.json().permissions).toContain('mappings.read');
    }
  });
});
