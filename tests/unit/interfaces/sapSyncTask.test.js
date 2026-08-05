import { jest } from '@jest/globals';
import { runSapSyncOnce } from '../../../src/interfaces/jobs/tasks/sapSyncTask.js';

// runSapSyncOnce is what POST /sap-sync/run drives: it runs every active config
// in-process, bypassing the queue. It has to route on taskType exactly like the
// BullMQ processor, otherwise the manual endpoint used for testing would send a
// dropdown config through the record pipeline.
describe('runSapSyncOnce', () => {
  function buildDeps(configs) {
    const tenantModels = { ClientConfig: {} };

    return {
      tenantModels,
      tenantProvider: jest.fn().mockResolvedValue([{ client: { tenantKey: 'tenant-a' } }]),
      tenantRepository: {
        findActiveConfigs: jest.fn().mockResolvedValue({ tenantModels, configs }),
      },
      syncUseCase: { execute: jest.fn().mockResolvedValue({ ok: true }) },
      dropdownUseCase: { execute: jest.fn().mockResolvedValue({ ok: true }) },
    };
  }

  it('sends a DROPDOWN_OPTIONS config to the dropdown use case', async () => {
    const config = { _id: 'cfg-1', active: true, taskType: 'DROPDOWN_OPTIONS' };
    const deps = buildDeps([config]);

    await runSapSyncOnce(deps);

    expect(deps.dropdownUseCase.execute).toHaveBeenCalledWith({
      config,
      tenantContext: { tenantKey: 'tenant-a', tenantModels: deps.tenantModels },
    });
    expect(deps.syncUseCase.execute).not.toHaveBeenCalled();
  });

  it('keeps sending configs without a taskType to the record sync', async () => {
    const config = { _id: 'cfg-2', active: true };
    const deps = buildDeps([config]);

    await runSapSyncOnce(deps);

    expect(deps.syncUseCase.execute).toHaveBeenCalledTimes(1);
    expect(deps.dropdownUseCase.execute).not.toHaveBeenCalled();
  });

  it('routes each config independently when both kinds are active', async () => {
    const sapConfig = { _id: 'cfg-1', active: true, taskType: 'SAP_SYNC' };
    const dropdownConfig = { _id: 'cfg-2', active: true, taskType: 'DROPDOWN_OPTIONS' };
    const deps = buildDeps([sapConfig, dropdownConfig]);

    await runSapSyncOnce(deps);

    expect(deps.syncUseCase.execute).toHaveBeenCalledTimes(1);
    expect(deps.dropdownUseCase.execute).toHaveBeenCalledTimes(1);
  });

  it('honours the tenantID filter from the request body', async () => {
    const deps = buildDeps([{ _id: 'cfg-1', active: true }]);
    deps.tenantProvider = jest.fn().mockResolvedValue([
      { client: { tenantKey: 'tenant-a' } },
      { client: { tenantKey: 'tenant-b' } },
    ]);

    await runSapSyncOnce({ ...deps, tenantID: 'tenant-b' });

    expect(deps.tenantRepository.findActiveConfigs).toHaveBeenCalledTimes(1);
    expect(deps.tenantRepository.findActiveConfigs).toHaveBeenCalledWith('tenant-b');
  });
});
