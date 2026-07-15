import { jest } from '@jest/globals';
import tenantConfigurationService from '../../src/infrastructure/config/tenantConfiguration.service.js';

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

  it('returns the stored value with a plain read and never upserts when the key exists', async () => {
    const tenantModels = {
      Configuration: {
        findOne: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            key: 'fieldsPricesHS',
            value: ['hs_price_usd', 'hs_price_nio'],
          }),
        }),
        findOneAndUpdate: jest.fn(),
      },
    };

    const value = await tenantConfigurationService.getValue(
      tenantModels,
      'fieldsPricesHS',
      ['hs_price_usd']
    );

    expect(value).toEqual(['hs_price_usd', 'hs_price_nio']);
    expect(tenantModels.Configuration.findOne).toHaveBeenCalledWith({ key: 'fieldsPricesHS' });
    expect(tenantModels.Configuration.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('upserts the default only when the key does not exist yet', async () => {
    const tenantModels = {
      Configuration: {
        findOne: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null),
        }),
        findOneAndUpdate: jest.fn().mockResolvedValue({
          key: 'fieldsPricesHS',
          value: ['hs_price_usd'],
          userUpdated: 'admin',
        }),
      },
    };

    const value = await tenantConfigurationService.getValue(
      tenantModels,
      'fieldsPricesHS',
      ['hs_price_usd']
    );

    expect(value).toEqual(['hs_price_usd']);
    expect(tenantModels.Configuration.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'fieldsPricesHS' },
      {
        $setOnInsert: {
          key: 'fieldsPricesHS',
          value: ['hs_price_usd'],
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
