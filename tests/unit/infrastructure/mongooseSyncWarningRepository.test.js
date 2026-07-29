import { jest } from '@jest/globals';
import MongooseSyncWarningRepository from '../../../src/infrastructure/database/repositories/MongooseSyncWarningRepository.js';

describe('MongooseSyncWarningRepository', () => {
  it('creates the warning document with the reporting fields', async () => {
    const created = { _id: 'warn-1' };
    const SyncWarning = { create: jest.fn(async () => created) };
    const repository = new MongooseSyncWarningRepository();

    const result = await repository.record({
      tenantModels: { SyncWarning },
      clientConfigId: 'config-1',
      syncLogId: 'sync-log-1',
      objectType: 'contact',
      sapId: '110521',
      code: 'missingEmailBypassed',
      message: 'Missing business partner email bypassed before HubSpot sync',
      details: { source: 'companyContact', sapCompanyId: '110521' },
    });

    expect(SyncWarning.create).toHaveBeenCalledWith({
      clientConfigId: 'config-1',
      syncLogId: 'sync-log-1',
      objectType: 'contact',
      sapId: '110521',
      code: 'missingEmailBypassed',
      message: 'Missing business partner email bypassed before HubSpot sync',
      details: { source: 'companyContact', sapCompanyId: '110521' },
    });
    expect(result).toBe(created);
  });

  it('returns null when the tenant has no SyncWarning model', async () => {
    const repository = new MongooseSyncWarningRepository();

    await expect(repository.record({ tenantModels: {} })).resolves.toBeNull();
    await expect(repository.record()).resolves.toBeNull();
  });

  it('never throws when the write fails', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const SyncWarning = { create: jest.fn(async () => { throw new Error('mongo down'); }) };
    const repository = new MongooseSyncWarningRepository();

    await expect(repository.record({
      tenantModels: { SyncWarning },
      code: 'missingEmailBypassed',
    })).resolves.toBeNull();

    consoleError.mockRestore();
  });
});
