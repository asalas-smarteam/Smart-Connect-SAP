import { jest } from '@jest/globals';
import { ensureTenantConfigurations } from '../../../src/infrastructure/tenants/tenantProvisioning.js';
import { BUSINESS_PARTNER_CREATION_CONFIG_KEY, PROPERTIES_FLAGS_CONFIG_KEY }
  from '../../../src/domain/business-partners/business-partner-creation.constants.js';
import { WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY }
  from '../../../src/domain/warehouses/warehouse-stock-strategy.constants.js';

describe('ensureTenantConfigurations — claves del BusinessPartner', () => {
  it('siembra businessPartnerCreation apagada, con upsert e idempotente', async () => {
    const updateOne = jest.fn().mockResolvedValue({});

    await ensureTenantConfigurations({ Configuration: { updateOne } });

    const call = updateOne.mock.calls.find(
      ([filter]) => filter.key === BUSINESS_PARTNER_CREATION_CONFIG_KEY
    );

    expect(call).toBeDefined();
    expect(call[1].$setOnInsert.value).toEqual({
      payloadStrategy: 'legacyWhitelist',
      contactEmployeeSource: 'dealContact',
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      addresses: { strategy: 'none', byName: {}, required: [] },
    });
    expect(call[1].$setOnInsert.userUpdated).toBe('admin');
    expect(call[2]).toEqual({ upsert: true });
  });

  it('siembra propertiesFlags apagada', async () => {
    const updateOne = jest.fn().mockResolvedValue({});

    await ensureTenantConfigurations({ Configuration: { updateOne } });

    const call = updateOne.mock.calls.find(
      ([filter]) => filter.key === PROPERTIES_FLAGS_CONFIG_KEY
    );

    expect(call).toBeDefined();
    expect(call[1].$setOnInsert.value).toEqual({
      strategy: 'none',
      hubspotProperty: null,
      min: 1,
      max: 64,
      trueValue: 'tYES',
    });
  });

  it('siembra warehouseAvailableFormula con el calculo historico, con arrays mutables', async () => {
    const updateOne = jest.fn().mockResolvedValue({});

    await ensureTenantConfigurations({ Configuration: { updateOne } });

    const call = updateOne.mock.calls.find(
      ([filter]) => filter.key === WAREHOUSE_AVAILABLE_FORMULA_CONFIG_KEY
    );

    expect(call).toBeDefined();
    expect(call[1].$setOnInsert.value).toEqual({ add: ['InStock', 'Ordered'], subtract: ['Committed'] });
    expect(Object.isFrozen(call[1].$setOnInsert.value)).toBe(false);
    expect(Object.isFrozen(call[1].$setOnInsert.value.add)).toBe(false);
    expect(call[1].$setOnInsert.userUpdated).toBe('admin');
    expect(call[2]).toEqual({ upsert: true });
  });
});
