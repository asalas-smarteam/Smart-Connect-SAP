import { jest } from '@jest/globals';
import tenantConfigurationService from '../../src/services/tenantConfiguration.service.js';

describe('tenantConfiguration.service', () => {
  it('preserves array values for tenant configuration', async () => {
    const tenantModels = {
      Configuration: {
        findOneAndUpdate: jest.fn().mockResolvedValue({
          key: 'excludedWarehouses',
          value: ['B11', 'B12', 'B13'],
          userUpdated: 'admin',
        }),
      },
    };

    const value = await tenantConfigurationService.getValue(
      tenantModels,
      'excludedWarehouses',
      ['B11', 'B12', 'B13']
    );

    expect(value).toEqual(['B11', 'B12', 'B13']);
    expect(tenantModels.Configuration.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'excludedWarehouses' },
      {
        $setOnInsert: {
          key: 'excludedWarehouses',
          value: ['B11', 'B12', 'B13'],
          userUpdated: 'admin',
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );
  });

  it('returns default value untouched when tenant configuration model is missing', async () => {
    const defaultValue = ['B11', 'B12', 'B13'];

    const value = await tenantConfigurationService.getValue(
      null,
      'excludedWarehouses',
      defaultValue
    );

    expect(value).toBe(defaultValue);
  });
});
