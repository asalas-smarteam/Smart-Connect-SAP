import { jest } from '@jest/globals';
import MongoosePanelAuditLog from '../../../src/infrastructure/database/repositories/MongoosePanelAuditLog.js';

describe('MongoosePanelAuditLog', () => {
  it('writes the entry as is', async () => {
    const model = { create: jest.fn().mockResolvedValue({}) };
    const auditLog = new MongoosePanelAuditLog({ model, logger: { error: jest.fn() } });
    const entry = { action: 'user.created', at: new Date() };

    await auditLog.record(entry);

    expect(model.create).toHaveBeenCalledWith(entry);
  });

  it('never throws: logs the failure without the entry contents', async () => {
    const model = { create: jest.fn().mockRejectedValue(new Error('master down')) };
    const logger = { error: jest.fn() };
    const auditLog = new MongoosePanelAuditLog({ model, logger });

    await expect(auditLog.record({ action: 'auth.login_failed', target: { email: 'ana@acme.test' } })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith({
      msg: 'Panel audit log write failed',
      action: 'auth.login_failed',
      error: 'master down',
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('ana@acme.test');
  });
});

describe('PanelAuditLog schema (validation only, no database)', () => {
  let PanelAuditLog;

  beforeAll(async () => {
    ({ default: PanelAuditLog } = await import('../../../src/infrastructure/database/models/global/PanelAuditLog.js'));
  });

  it('uses the PanelAuditLogs collection and accepts a valid entry', async () => {
    const doc = new PanelAuditLog({
      at: new Date(),
      action: 'user.created',
      source: 'script',
      actor: null,
      target: { userId: 'u1', email: 'a@b.test', tenantKey: null },
      details: { accountType: 'smarteam', role: null },
    });

    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.collection.collectionName).toBe('PanelAuditLogs');
  });

  it.each([
    ['an unknown action', { action: 'user.hacked' }],
    ['an unknown source', { source: 'otro' }],
    ['no date', { at: undefined }],
  ])('rejects %s', async (_label, overrides) => {
    const doc = new PanelAuditLog({ at: new Date(), action: 'user.created', ...overrides });

    await expect(doc.validate()).rejects.toThrow();
  });

  it('declares the query indexes and the TTL on expiresAt', () => {
    const indexes = PanelAuditLog.schema.indexes();

    expect(indexes).toEqual(expect.arrayContaining([
      [{ at: -1 }, expect.anything()],
      [{ 'target.userId': 1, at: -1 }, expect.anything()],
      [{ action: 1, at: -1 }, expect.anything()],
      [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
    ]));
  });
});
