import { jest } from '@jest/globals';
import MappingFallbackConfigRepository, {
  MAPPING_COLLECTION_PRIORITY_CONFIG_KEY,
  MAPPING_FALLBACK_CONFIG_KEY,
} from '../../../src/infrastructure/config/MappingFallbackConfigRepository.js';

function models(values) {
  return {
    Configuration: {
      findOne: jest.fn(({ key }) => ({
        lean: async () => (Object.prototype.hasOwnProperty.call(values, key) ? { key, value: values[key] } : null),
      })),
    },
  };
}

describe('MappingFallbackConfigRepository', () => {
  const repository = new MappingFallbackConfigRepository();

  it('stays off when the key is missing', async () => {
    await expect(repository.getMappingFallbackConfig({ tenantModels: models({}) }))
      .resolves.toEqual({ enabled: false, collectionPriority: null });
  });

  it('stays off for any value that is not strictly true', async () => {
    // A stray "true" string or 1 must not silently change mapping semantics.
    for (const value of ['true', 1, {}, null]) {
      await expect(repository.getMappingFallbackConfig({
        tenantModels: models({ [MAPPING_FALLBACK_CONFIG_KEY]: value }),
      })).resolves.toMatchObject({ enabled: false });
    }
  });

  it('reads the collection priority once enabled', async () => {
    const priority = { to_BusinessPartnerTax: { field: 'BPTaxType', order: ['DO1', 'DO5'] } };

    await expect(repository.getMappingFallbackConfig({
      tenantModels: models({
        [MAPPING_FALLBACK_CONFIG_KEY]: true,
        [MAPPING_COLLECTION_PRIORITY_CONFIG_KEY]: priority,
      }),
    })).resolves.toEqual({ enabled: true, collectionPriority: priority });
  });

  it('discards priority rules that are missing a field or an order', async () => {
    await expect(repository.getMappingFallbackConfig({
      tenantModels: models({
        [MAPPING_FALLBACK_CONFIG_KEY]: true,
        [MAPPING_COLLECTION_PRIORITY_CONFIG_KEY]: {
          to_BusinessPartnerTax: { order: ['DO1'] },
          to_Other: { field: 'X', order: [] },
        },
      }),
    })).resolves.toEqual({ enabled: true, collectionPriority: null });
  });

  it('enables the chain even when no priority is configured', async () => {
    await expect(repository.getMappingFallbackConfig({
      tenantModels: models({ [MAPPING_FALLBACK_CONFIG_KEY]: true }),
    })).resolves.toEqual({ enabled: true, collectionPriority: null });
  });

  it('falls back to legacy behaviour when the read throws', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const tenantModels = {
      Configuration: { findOne: jest.fn(() => { throw new Error('mongo down'); }) },
    };

    await expect(repository.getMappingFallbackConfig({ tenantModels }))
      .resolves.toEqual({ enabled: false, collectionPriority: null });

    consoleError.mockRestore();
  });

  it('accepts a tenantContext instead of tenantModels', async () => {
    // MappingSyncRepository passes tenantContext; FieldMappingService passes tenantModels.
    await expect(repository.getMappingFallbackConfig({
      tenantContext: { tenantModels: models({ [MAPPING_FALLBACK_CONFIG_KEY]: true }) },
    })).resolves.toMatchObject({ enabled: true });
  });
});
