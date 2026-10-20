import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Integración de Soporte con una base real en memoria: tickets por tenant, correlativo, GridFS,
// lectura del contexto, bandeja con un tenant caído y que nada cree bases sin querer.
const ACME = 'sap_integration_acme';
const GLOBEX = 'sap_integration_globex';
const EMPTY = 'sap_integration_vacio';
const BROKEN = 'sap_integration_roto';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]);

const ana = { id: 'u-ana', name: 'Ana', role: 'admin', accountType: 'cliente', tenantKey: ACME };
const globexUser = { id: 'u-globex', name: 'Gina', role: 'usuario', accountType: 'cliente', tenantKey: GLOBEX };
const dev = { id: 'u-dev', name: 'Dev Smarteam', accountType: 'smarteam' };

let mongoServer;
let connect;
let disconnect;
let SaaSClient;
let getTenantConnection;
let disconnectTenantConnections;
let getPanelTenantModels;
let MongooseTicketRepository;
let buildPanelTicketUseCases;
let createWebhookEventModel;
let useCases;

async function databaseNames() {
  const { databases } = await mongoose.connection.db.admin().listDatabases();
  return databases.map((database) => database.name);
}

function newTicket(user = ana, extra = {}) {
  return useCases.clientTickets.create({
    user,
    fields: { title: 'No llegó', description: 'Detalle', category: 'documentos', ...extra },
    images: extra.images ?? [],
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  process.env.MONGODB_URI = mongoServer.getUri();

  ({ connect, disconnect, SaaSClient } = await import('../../src/infrastructure/database/master/database.js'));
  ({ getTenantConnection, disconnectTenantConnections } = await import('../../src/infrastructure/database/tenant/tenantDatabase.js'));
  ({ getPanelTenantModels } = await import('../../src/infrastructure/database/repositories/panelTenantModels.js'));
  ({ default: MongooseTicketRepository } = await import('../../src/infrastructure/database/repositories/MongooseTicketRepository.js'));
  ({ buildPanelTicketUseCases } = await import('../../src/composition/panel.composition.js'));
  ({ createWebhookEventModel } = await import('../../src/infrastructure/database/models/tenant/WebhookEvent.js'));

  await connect();
  await SaaSClient.create([
    { companyName: 'Acme Industrial', tenantKey: ACME, status: 'active' },
    { companyName: 'Globex', tenantKey: GLOBEX, status: 'suspended' },
    { companyName: 'Vacío', tenantKey: EMPTY, status: 'active' },
    { companyName: 'Roto', tenantKey: BROKEN, status: 'active' },
  ]);

  // El tenant "roto" simula una base caída; los demás usan la base real.
  const ticketRepository = new MongooseTicketRepository({
    getModels: (tenantKey) => (tenantKey === BROKEN
      ? Promise.reject(new Error('base caída'))
      : getPanelTenantModels(tenantKey)),
  });
  useCases = buildPanelTicketUseCases({
    ticketRepository,
    tenantDbPrefix: 'sap_integration',
    inboxTenantTimeoutMs: 5000,
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  });
}, 120000);

afterAll(async () => {
  await SaaSClient?.deleteMany({});
  await disconnectTenantConnections?.();
  await disconnect?.();
  await mongoServer?.stop();
});

describe('tickets against MongoDB', () => {
  it('allocates correlative numbers without duplicates under concurrency', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => newTicket(globexUser)));

    expect(results.every((result) => result.ok)).toBe(true);
    const codes = results.map((result) => result.data.code).sort();
    expect(codes).toEqual(Array.from({ length: 10 }, (_, index) => `GLOBEX-${String(index + 1).padStart(4, '0')}`));
  });

  it('creates the unique index on number with the first ticket', async () => {
    await newTicket();
    const { Ticket } = await getPanelTenantModels(ACME);
    const indexes = await Ticket.collection.indexes();

    expect(indexes.find((index) => index.key.number === 1)?.unique).toBe(true);
  });

  it('stores images in GridFS and serves them only within their ticket', async () => {
    const first = (await newTicket(ana, { images: [{ filename: 'a.png', data: PNG }] })).data;
    const second = (await newTicket()).data;
    const { fileId } = first.attachments[0];

    const own = await useCases.clientTickets.attachment({ user: ana, id: first.id, fileId });
    const crossed = await useCases.clientTickets.attachment({ user: ana, id: second.id, fileId });
    const chunks = [];
    for await (const chunk of own.data.stream) {
      chunks.push(chunk);
    }

    expect(Buffer.concat(chunks).equals(PNG)).toBe(true);
    expect(own.data.contentType).toBe('image/png');
    expect(crossed).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('keeps tenants isolated', async () => {
    const own = (await newTicket()).data;

    expect(await useCases.clientTickets.get({ user: globexUser, id: own.id })).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('copies a generic snapshot of an event of the same tenant and hides quality reports', async () => {
    const connection = await getTenantConnection(ACME);
    const WebhookEvent = createWebhookEventModel(connection);
    const event = await WebhookEvent.create({
      eventType: 'createQuotation',
      status: 'errored',
      lastError: 'El artículo no existe',
      payload: { deal: { hs_object_id: '555' } },
      sapAudit: { request: 'interno' },
    });
    const report = await WebhookEvent.create({ eventType: 'syncReport', status: 'report', payload: { rows: [] } });

    const linked = await newTicket(ana, { contextType: 'webhookEvent', contextId: String(event._id) });
    const hidden = await newTicket(ana, { contextType: 'webhookEvent', contextId: String(report._id) });
    const crossed = await newTicket(globexUser, { contextType: 'webhookEvent', contextId: String(event._id) });

    expect(linked.data.context.snapshot).toEqual(expect.objectContaining({ type: 'createQuotation', status: 'errored', reference: '555' }));
    expect(JSON.stringify(linked.data)).not.toContain('interno');
    expect(hidden).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(crossed).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('lets only one of two concurrent resolutions win', async () => {
    const { id } = (await newTicket()).data;
    const resolve = () => useCases.staffTickets.resolve({
      user: dev,
      tenantKey: ACME,
      id,
      fields: { message: 'Listo', internalResolution: 'Causa' },
    });

    const results = await Promise.all([resolve(), resolve()]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.reason === 'INVALID_TRANSITION')).toHaveLength(1);
  });

  it('returns the inbox of the healthy tenants plus a warning for the broken one', async () => {
    const result = await useCases.staffInbox.list({ query: { pageSize: '100' } });

    expect(result.ok).toBe(true);
    expect(result.data.warnings).toEqual([{ tenantKey: BROKEN, error: 'No se pudo consultar la base del tenant' }]);
    expect(new Set(result.data.items.map((item) => item.tenantKey))).toEqual(new Set([ACME, GLOBEX]));
    const times = result.data.items.map((item) => new Date(item.lastActivityAt).getTime());
    expect(times).toEqual([...times].sort((left, right) => right - left));
  });

  it('never creates a database by reading or by an unknown tenantKey', async () => {
    await useCases.staffInbox.list({ query: {} });
    await useCases.staffInbox.summary();
    await useCases.staffTickets.get({ tenantKey: 'sap_integration_fantasma', id: 'ffffffffffffffffffffffff' });

    const names = await databaseNames();
    expect(names).not.toContain(EMPTY);
    expect(names).not.toContain('sap_integration_fantasma');
    expect(names).toContain(ACME);
  });
});
