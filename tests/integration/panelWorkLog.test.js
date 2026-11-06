import { MongoMemoryServer } from 'mongodb-memory-server';

// Integración del registro de trabajo (contrato 12) con una base real en memoria: tokens
// personales (solo hash, índices), resolución token → usuario, búsqueda por código en un tenant
// real, idempotencia de la publicación, resolver desde la skill y qué ve cada lado.
// Adaptadores reales de Mongo; los limitadores son falsos (sin Redis). No usa Fastify.
const ACME = 'sap_integration_acme';
const PREFIX = 'sap_integration';
const SILENT = { warn: () => {}, error: () => {}, info: () => {} };

const ana = { id: 'u-ana', name: 'Ana', role: 'admin', accountType: 'cliente', tenantKey: ACME };

// LoginAttemptsPort en memoria que nunca bloquea.
class NeverBlocked {
  async consume() {
    return { blocked: false, firstBlocked: false };
  }

  async reset() {}
}

let mongoServer;
let connect;
let disconnect;
let SaaSClient;
let disconnectTenantConnections;
let getPanelTenantModels;
let PanelUser;
let PanelApiToken;
let PanelIdempotencyKey;
let PanelAuditLog;
let MongoosePanelUserRepository;
let MongoosePanelApiTokenRepository;
let MongooseIdempotencyStore;
let MongooseTicketRepository;
let RandomApiToken;
let ScryptPasswordHasher;
let buildPanelApiTokenUseCases;
let buildPanelWorkLogUseCases;
let buildPanelTicketUseCases;

let tokenUseCases;
let workLog;
let tickets;
let staffUser;
let plainToken;
let resolvedUser;

const PASSWORD = 'clave-del-dev-larga';

function newClientTicket(title = 'No llegó la cotización') {
  return tickets.clientTickets.create({
    user: ana,
    fields: { title, description: 'Detalle', category: 'documentos' },
    images: [],
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
  process.env.MONGODB_URI = mongoServer.getUri();

  ({ connect, disconnect, SaaSClient } = await import('../../src/infrastructure/database/master/database.js'));
  ({ disconnectTenantConnections } = await import('../../src/infrastructure/database/tenant/tenantDatabase.js'));
  ({ getPanelTenantModels } = await import('../../src/infrastructure/database/repositories/panelTenantModels.js'));
  ({ default: PanelUser } = await import('../../src/infrastructure/database/models/global/PanelUser.js'));
  ({ default: PanelApiToken } = await import('../../src/infrastructure/database/models/global/PanelApiToken.js'));
  ({ default: PanelIdempotencyKey } = await import('../../src/infrastructure/database/models/global/PanelIdempotencyKey.js'));
  ({ default: PanelAuditLog } = await import('../../src/infrastructure/database/models/global/PanelAuditLog.js'));
  ({ default: MongoosePanelUserRepository } = await import('../../src/infrastructure/database/repositories/MongoosePanelUserRepository.js'));
  ({ default: MongoosePanelApiTokenRepository } = await import('../../src/infrastructure/database/repositories/MongoosePanelApiTokenRepository.js'));
  ({ default: MongooseIdempotencyStore } = await import('../../src/infrastructure/database/repositories/MongooseIdempotencyStore.js'));
  ({ default: MongooseTicketRepository } = await import('../../src/infrastructure/database/repositories/MongooseTicketRepository.js'));
  ({ default: RandomApiToken } = await import('../../src/infrastructure/auth/RandomApiToken.js'));
  ({ default: ScryptPasswordHasher } = await import('../../src/infrastructure/auth/ScryptPasswordHasher.js'));
  ({
    buildPanelApiTokenUseCases,
    buildPanelWorkLogUseCases,
    buildPanelTicketUseCases,
  } = await import('../../src/composition/panel.composition.js'));

  await connect();
  await PanelUser.init();
  await PanelApiToken.init();
  await PanelIdempotencyKey.init();
  await PanelAuditLog.init();
  await SaaSClient.create({ companyName: 'Acme Industrial', tenantKey: ACME, status: 'active' });

  const passwordHasher = new ScryptPasswordHasher();
  const userRepository = new MongoosePanelUserRepository();
  const apiTokenCodec = new RandomApiToken();
  const ticketRepository = new MongooseTicketRepository();

  staffUser = await userRepository.create({
    email: 'dev@smarteam.test',
    name: 'Dev Smarteam',
    accountType: 'smarteam',
    passwordHash: await passwordHasher.hash(PASSWORD),
    mustChangePassword: false,
  });

  tokenUseCases = buildPanelApiTokenUseCases({
    userRepository,
    passwordHasher,
    apiTokenRepository: new MongoosePanelApiTokenRepository(),
    apiTokenCodec,
    passwordAttempts: new NeverBlocked(),
    apiTokenAttempts: new NeverBlocked(),
    invalidTokenIpAttempts: null,
    logger: SILENT,
  });
  ({ staffWorkLog: workLog } = buildPanelWorkLogUseCases({
    ticketRepository,
    idempotencyStore: new MongooseIdempotencyStore(),
    apiTokenCodec,
    tenantDbPrefix: PREFIX,
    logger: SILENT,
  }));
  tickets = buildPanelTicketUseCases({ ticketRepository, tenantDbPrefix: PREFIX, logger: SILENT });
}, 120000);

afterAll(async () => {
  await SaaSClient?.deleteMany({});
  await PanelUser?.deleteMany({});
  await PanelApiToken?.deleteMany({});
  await PanelIdempotencyKey?.deleteMany({});
  await PanelAuditLog?.deleteMany({});
  await disconnectTenantConnections?.();
  await disconnect?.();
  await mongoServer?.stop();
});

// Los casos van en orden: cada uno usa el token y los tickets que dejó el anterior.
describe('registro de trabajo contra MongoDB', () => {
  it('crea un token guardando solo su hash, con índice único en tokenHash y TTL en purgeAt', async () => {
    const created = await tokenUseCases.manageApiTokens.create({
      user: staffUser,
      fields: { name: 'Claude laptop', currentPassword: PASSWORD },
    });

    expect(created.ok).toBe(true);
    expect(created.statusCode).toBe(201);
    plainToken = created.data.token;
    expect(plainToken).toMatch(/^spn_[A-Za-z0-9_-]{43}$/);

    const stored = await PanelApiToken.find({}).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0].tokenHash).not.toBe(plainToken);
    expect(stored[0].prefix).toBe(plainToken.slice(0, 8));
    expect(JSON.stringify(stored)).not.toContain(plainToken);
    expect(await PanelApiToken.countDocuments({ tokenHash: plainToken })).toBe(0);
    const anyField = await PanelApiToken.collection.find({
      $or: Object.keys(stored[0]).filter((key) => key !== '_id').map((key) => ({ [key]: plainToken })),
    }).toArray();
    expect(anyField).toHaveLength(0);

    const indexes = await PanelApiToken.collection.indexes();
    expect(indexes.find((index) => index.key.tokenHash === 1)?.unique).toBe(true);
    expect(indexes.find((index) => index.key.purgeAt === 1)?.expireAfterSeconds).toBe(0);

    const audit = await PanelAuditLog.find({}).lean();
    expect(JSON.stringify(audit)).not.toContain(plainToken);
  });

  it('resuelve el token al usuario de Smarteam y rechaza uno desconocido', async () => {
    const resolved = await tokenUseCases.resolveApiToken.execute({ token: plainToken });
    const unknown = await tokenUseCases.resolveApiToken.execute({ token: `spn_${'A'.repeat(43)}` });

    expect(resolved.ok).toBe(true);
    expect(resolved.data.user).toEqual(expect.objectContaining({
      id: staffUser.id,
      name: 'Dev Smarteam',
      accountType: 'smarteam',
    }));
    expect(resolved.data.prefix).toBe(plainToken.slice(0, 8));
    expect(unknown).toEqual(expect.objectContaining({ ok: false }));
    resolvedUser = resolved.data;
  });

  it('busca un ticket por su código en el tenant con prefijo', async () => {
    const created = await newClientTicket();
    expect(created.data.code).toBe('ACME-0001');

    const found = await workLog.findByCode({ code: ' acme-0001 ' });
    const missing = await workLog.findByCode({ code: 'ACME-0099' });

    expect(found.ok).toBe(true);
    expect(found.data).toEqual(expect.objectContaining({
      tenantKey: ACME,
      id: created.data.id,
      code: 'ACME-0001',
      companyName: 'Acme Industrial',
      status: 'abierto',
    }));
    expect(missing).toEqual(expect.objectContaining({ ok: false }));
  });

  it('publica dos veces con la misma Idempotency-Key y deja una sola entrada y un solo mensaje', async () => {
    const { Ticket } = await getPanelTenantModels(ACME);
    const before = await Ticket.findOne({ code: 'ACME-0001' }).lean();
    const auth = { via: 'token', tokenId: resolvedUser.tokenId, prefix: resolvedUser.prefix };
    const publish = () => workLog.publish({
      user: resolvedUser.user,
      auth,
      code: 'ACME-0001',
      body: { summary: 'Revisé el mapeo del artículo.', internalNote: 'Faltaba el UDF en SAP', hours: 1.5, crmProjectId: 'PRJ-1' },
      idempotencyKey: 'sesion-123:1',
    });

    const first = await publish();
    const second = await publish();

    expect(first.ok).toBe(true);
    expect(first.statusCode).toBe(201);
    expect(second).toEqual(first);
    expect(first.data.ticket.status).toBe('en_progreso');

    const after = await Ticket.findOne({ code: 'ACME-0001' }).lean();
    expect(after.workLog).toHaveLength(1);
    expect(after.messages).toHaveLength(before.messages.length + 1);
    expect(after.workLog[0]).toEqual(expect.objectContaining({ hours: 1.5, via: 'token', crmProjectId: 'PRJ-1' }));
    expect(after.firstResponseAt).toBeInstanceOf(Date);

    const keys = await PanelIdempotencyKey.find({}).lean();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toEqual(expect.objectContaining({ state: 'done', tenantKey: ACME, status: 201 }));
    expect(keys[0]).not.toHaveProperty('summary');
    expect(keys[0]).not.toHaveProperty('internalNote');
    expect(JSON.stringify(keys)).not.toContain('Revisé el mapeo');
    expect(JSON.stringify(keys)).not.toContain('Faltaba el UDF');
  });

  it('resuelve el ticket con resolve:true y guarda la resolución interna', async () => {
    const result = await workLog.publish({
      user: resolvedUser.user,
      auth: { via: 'token', tokenId: resolvedUser.tokenId, prefix: resolvedUser.prefix },
      code: 'ACME-0001',
      body: { summary: 'Quedó corregido.', internalNote: 'Causa: UDF vacío', hours: 0.25, resolve: true },
      idempotencyKey: 'sesion-123:2',
    });

    expect(result.ok).toBe(true);
    expect(result.data.ticket.status).toBe('resuelto');

    const { Ticket } = await getPanelTenantModels(ACME);
    const stored = await Ticket.findOne({ code: 'ACME-0001' }).lean();
    expect(stored.status).toBe('resuelto');
    expect(stored.resolvedAt).toBeInstanceOf(Date);
    expect(stored.internalResolution).toEqual(expect.objectContaining({ text: 'Causa: UDF vacío' }));
    expect(stored.workLog).toHaveLength(2);
  });

  it('muestra el registro en el detalle de Smarteam y nunca en la vista del cliente', async () => {
    const found = await workLog.findByCode({ code: 'ACME-0001' });

    const staff = await tickets.staffTickets.get({ tenantKey: ACME, id: found.data.id });
    const client = await tickets.clientTickets.get({ user: ana, id: found.data.id });

    expect(staff.ok).toBe(true);
    expect(staff.data.workLog.totalHours).toBe(1.75);
    expect(staff.data.workLog.entries).toHaveLength(2);
    expect(staff.data.workLog.entries).toContainEqual(expect.objectContaining({
      hours: 0.25,
      internalNote: 'Causa: UDF vacío',
      author: { name: 'Dev Smarteam' },
    }));

    expect(client.ok).toBe(true);
    expect(client.data).not.toHaveProperty('workLog');
    expect(client.data).not.toHaveProperty('internalResolution');
    const clientText = JSON.stringify(client.data);
    expect(clientText).not.toContain('Faltaba el UDF');
    expect(clientText).not.toContain('Causa: UDF vacío');
    expect(clientText).toContain('Quedó corregido.');
  });

  it('findByNumber usa el índice único de number', async () => {
    const repository = new MongooseTicketRepository();
    const { Ticket } = await getPanelTenantModels(ACME);

    const ticket = await repository.findByNumber(ACME, 1);
    const indexes = await Ticket.collection.indexes();
    const plan = await Ticket.collection.find({ number: 1 }).explain('queryPlanner');
    const winning = JSON.stringify(plan.queryPlanner.winningPlan);

    expect(ticket.code).toBe('ACME-0001');
    expect(await repository.findByNumber(ACME, 0)).toBeNull();
    expect(indexes.find((index) => index.key.number === 1)?.unique).toBe(true);
    expect(winning).toMatch(/IXSCAN/);
    expect(winning).not.toMatch(/COLLSCAN/);
  });
});
