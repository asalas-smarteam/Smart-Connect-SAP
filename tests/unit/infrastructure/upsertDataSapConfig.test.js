import { jest } from '@jest/globals';
import {
  DEFAULT_UPSERT_DATA_SAP_CONFIG,
  UPSERT_DATA_SAP_CONFIG_KEY,
  getUpsertDataSapConfig,
} from '../../../src/infrastructure/config/upsertDataSap.config.js';

describe('getUpsertDataSapConfig', () => {
  it('returns the default config when the tenant has no Configuration model', async () => {
    const config = await getUpsertDataSapConfig({ tenantModels: {} });

    expect(config).toEqual(DEFAULT_UPSERT_DATA_SAP_CONFIG);
  });

  it('returns the default config when no document exists for the key', async () => {
    const findOne = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    const config = await getUpsertDataSapConfig({
      tenantModels: { Configuration: { findOne } },
    });

    expect(findOne).toHaveBeenCalledWith({ key: UPSERT_DATA_SAP_CONFIG_KEY });
    expect(config).toEqual(DEFAULT_UPSERT_DATA_SAP_CONFIG);
  });

  it('falls back to defaults when value is not an object', async () => {
    const findOne = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ value: 'not-an-object' }),
    });

    const config = await getUpsertDataSapConfig({
      tenantModels: { Configuration: { findOne } },
    });

    expect(config).toEqual(DEFAULT_UPSERT_DATA_SAP_CONFIG);
  });

  it('falls back to defaults when value is an array', async () => {
    const findOne = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ value: ['EmailAddress'] }),
    });

    const config = await getUpsertDataSapConfig({
      tenantModels: { Configuration: { findOne } },
    });

    expect(config).toEqual(DEFAULT_UPSERT_DATA_SAP_CONFIG);
  });

  it('normalizes required from a string "true"', async () => {
    const findOne = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        value: { required: 'true', fieldsUpdated_BP: ['EmailAddress'], fieldsUpdated_CE: null },
      }),
    });

    const config = await getUpsertDataSapConfig({
      tenantModels: { Configuration: { findOne } },
    });

    expect(config).toEqual({
      required: true,
      fieldsUpdated_BP: ['EmailAddress'],
      fieldsUpdated_CE: [],
    });
  });

  it('treats missing/null field lists as empty arrays', async () => {
    const findOne = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        value: { required: true },
      }),
    });

    const config = await getUpsertDataSapConfig({
      tenantModels: { Configuration: { findOne } },
    });

    expect(config).toEqual({
      required: true,
      fieldsUpdated_BP: [],
      fieldsUpdated_CE: [],
    });
  });

  it('trims field names and drops empty entries', async () => {
    const findOne = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        value: { required: true, fieldsUpdated_BP: ['  CardName ', '', '   '], fieldsUpdated_CE: ['Name'] },
      }),
    });

    const config = await getUpsertDataSapConfig({
      tenantModels: { Configuration: { findOne } },
    });

    expect(config.fieldsUpdated_BP).toEqual(['CardName']);
    expect(config.fieldsUpdated_CE).toEqual(['Name']);
  });

  it('deduplicates field names', async () => {
    const findOne = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        value: { required: true, fieldsUpdated_BP: ['CardName', 'CardName', 'EmailAddress'] },
      }),
    });

    const config = await getUpsertDataSapConfig({
      tenantModels: { Configuration: { findOne } },
    });

    expect(config.fieldsUpdated_BP).toEqual(['CardName', 'EmailAddress']);
  });

  it('drops field names that are not valid SAP field identifiers (e.g. dotted paths)', async () => {
    const findOne = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        value: {
          required: true,
          fieldsUpdated_BP: ['CardName', 'to_BusinessPartnerAddress.City', '123Invalid', 'Valid_Field1'],
        },
      }),
    });

    const config = await getUpsertDataSapConfig({
      tenantModels: { Configuration: { findOne } },
    });

    expect(config.fieldsUpdated_BP).toEqual(['CardName', 'Valid_Field1']);
  });

  it('normalization guards never throw on malformed shapes', async () => {
    const findOne = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        value: { required: true, fieldsUpdated_BP: 'not-an-array', fieldsUpdated_CE: 42 },
      }),
    });

    const config = await getUpsertDataSapConfig({
      tenantModels: { Configuration: { findOne } },
    });

    expect(config).toEqual({
      required: true,
      fieldsUpdated_BP: [],
      fieldsUpdated_CE: [],
    });
  });
});
