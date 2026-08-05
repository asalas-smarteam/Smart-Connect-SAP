import { resolveSyncUseCase } from '../../../src/application/services/syncTaskRouter.service.js';

const syncUseCase = { name: 'sap-sync' };
const dropdownUseCase = { name: 'dropdown-options' };

describe('resolveSyncUseCase', () => {
  it('routes a DROPDOWN_OPTIONS config to the dropdown use case', () => {
    expect(resolveSyncUseCase({
      config: { taskType: 'DROPDOWN_OPTIONS' },
      syncUseCase,
      dropdownUseCase,
    })).toBe(dropdownUseCase);
  });

  it('routes everything else to the record sync, including legacy configs without taskType', () => {
    expect(resolveSyncUseCase({ config: {}, syncUseCase, dropdownUseCase })).toBe(syncUseCase);
    expect(resolveSyncUseCase({
      config: { taskType: 'SAP_SYNC' },
      syncUseCase,
      dropdownUseCase,
    })).toBe(syncUseCase);
    expect(resolveSyncUseCase({
      config: { taskType: 'garbage' },
      syncUseCase,
      dropdownUseCase,
    })).toBe(syncUseCase);
  });

  it('fails loudly instead of silently running the wrong pipeline', () => {
    expect(() => resolveSyncUseCase({
      config: { taskType: 'DROPDOWN_OPTIONS' },
      syncUseCase,
    })).toThrow('dropdown options use case is required');
  });
});
