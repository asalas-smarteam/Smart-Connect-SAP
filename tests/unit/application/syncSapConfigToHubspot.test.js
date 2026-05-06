import { jest } from '@jest/globals';
import SyncSapConfigToHubspot from '../../../src/application/use-cases/SyncSapConfigToHubspot.js';

function createConfig(overrides = {}) {
  return {
    id: 'cfg-1',
    hubspotCredentialId: 'cred-1',
    objectType: 'contact',
    intervalMinutes: 10,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('SyncSapConfigToHubspot', () => {
  it('fetches SAP data, maps records and sends them to HubSpot', async () => {
    const syncLog = { _id: 'log-1' };
    const config = createConfig();
    const tenantModels = {
      HubspotCredentials: {
        findById: jest.fn().mockResolvedValue({ _id: 'cred-1' }),
      },
    };
    const sapDataSource = {
      fetchData: jest.fn().mockResolvedValue([{ CardCode: 'C1' }]),
    };
    const mappingRepository = {
      mapRecords: jest.fn().mockResolvedValue([{ properties: { idsap: 'C1' } }]),
    };
    const hubspotSyncTarget = {
      send: jest.fn().mockResolvedValue({ sent: 1, failed: 0 }),
    };
    const syncLogRepository = {
      start: jest.fn().mockResolvedValue(syncLog),
      finish: jest.fn().mockResolvedValue(null),
    };
    const useCase = new SyncSapConfigToHubspot({
      sapDataSource,
      mappingRepository,
      hubspotSyncTarget,
      syncLogRepository,
      dateProvider: () => new Date('2026-05-05T00:00:00.000Z'),
    });

    await useCase.execute({ config, tenantModels });

    expect(syncLogRepository.start).toHaveBeenCalledWith({
      tenantModels,
      clientConfigId: 'cfg-1',
      objectType: 'contact',
      startedAt: new Date('2026-05-05T00:00:00.000Z'),
    });
    expect(sapDataSource.fetchData).toHaveBeenCalledWith(expect.objectContaining({
      clientConfigId: 'cfg-1',
      tenantModels,
    }));
    expect(mappingRepository.mapRecords).toHaveBeenCalledWith({
      sapRecords: [{ CardCode: 'C1' }],
      hubspotCredentialId: 'cred-1',
      objectType: 'contact',
      tenantModels,
    });
    expect(hubspotSyncTarget.send).toHaveBeenCalledWith(expect.objectContaining({
      mappedRecords: [{ properties: { idsap: 'C1' }, rawSapData: { CardCode: 'C1' } }],
      config,
      objectType: 'contact',
      tenantModels,
    }));
    expect(syncLogRepository.finish).toHaveBeenLastCalledWith(syncLog, expect.objectContaining({
      status: 'completed',
      recordsProcessed: 1,
      sent: 1,
      failed: 0,
    }));
    expect(config.save).toHaveBeenCalled();
  });

  it('records an errored sync when HubSpot credentials are missing', async () => {
    const syncLog = { _id: 'log-1' };
    const config = createConfig();
    const tenantModels = {
      HubspotCredentials: {
        findById: jest.fn().mockResolvedValue(null),
      },
    };
    const syncLogRepository = {
      start: jest.fn().mockResolvedValue(syncLog),
      finish: jest.fn().mockResolvedValue(null),
    };
    const useCase = new SyncSapConfigToHubspot({
      sapDataSource: { fetchData: jest.fn().mockResolvedValue([{ CardCode: 'C1' }]) },
      mappingRepository: { mapRecords: jest.fn() },
      hubspotSyncTarget: { send: jest.fn() },
      syncLogRepository,
      dateProvider: () => new Date('2026-05-05T00:00:00.000Z'),
    });

    await useCase.execute({ config, tenantModels });

    expect(syncLogRepository.finish).toHaveBeenCalledWith(syncLog, expect.objectContaining({
      status: 'errored',
      errorMessage: 'No HubSpot credentials assigned to this clientConfig',
    }));
  });
});
