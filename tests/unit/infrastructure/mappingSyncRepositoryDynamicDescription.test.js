import { describe, expect, it, jest } from '@jest/globals';
import MappingSyncRepository from '#infrastructure/repositories/MappingSyncRepository.js';

const PRODUCT_MAPPINGS = [
  { sourceField: 'ItemCode', targetField: 'hs_sku', isActive: true },
  { sourceField: 'ItemName', targetField: 'name', isActive: true },
];

function buildRepository(configValue) {
  const fieldMappingRepository = {
    findByCredentialObjectAndContext: jest.fn().mockResolvedValue(PRODUCT_MAPPINGS),
  };
  const dynamicDescriptionConfigRepository = {
    getDynamicDescriptionConfig: jest.fn().mockResolvedValue(configValue),
  };

  const repository = new MappingSyncRepository({
    fieldMappingRepository,
    dynamicDescriptionConfigRepository,
  });

  return { repository, fieldMappingRepository, dynamicDescriptionConfigRepository };
}

const tenantContext = { tenantModels: { FieldMapping: {} } };

const sapRecords = [
  { ItemCode: 'A100', ItemName: 'Tornillo', U_ACO_IdAdicional: 'ADIC-7' },
  { ItemCode: 'A200', ItemName: 'Tuerca', U_ACO_IdAdicional: null },
];

describe('MappingSyncRepository dynamic description', () => {
  it('composes the product name from the configured template', async () => {
    const { repository } = buildRepository({
      isRequired: true,
      regex: '${ItemName} - ${U_ACO_IdAdicional}',
    });

    const mapped = await repository.mapRecords({
      sapRecords,
      hubspotCredentialId: 'cred-1',
      objectType: 'product',
      tenantContext,
    });

    expect(mapped[0].properties).toEqual({ hs_sku: 'A100', name: 'Tornillo - ADIC-7' });
    // Missing SAP value -> no dangling separator.
    expect(mapped[1].properties).toEqual({ hs_sku: 'A200', name: 'Tuerca' });
  });

  it('reads the configuration once per batch, not once per record', async () => {
    const { repository, dynamicDescriptionConfigRepository } = buildRepository({
      isRequired: true,
      regex: '${ItemName} - ${U_ACO_IdAdicional}',
    });

    await repository.mapRecords({
      sapRecords,
      hubspotCredentialId: 'cred-1',
      objectType: 'product',
      tenantContext,
    });

    expect(dynamicDescriptionConfigRepository.getDynamicDescriptionConfig).toHaveBeenCalledTimes(1);
  });

  it('keeps the plain 1:1 mapping when the rule is disabled', async () => {
    const { repository } = buildRepository({
      isRequired: false,
      regex: '${ItemName} - ${U_ACO_IdAdicional}',
    });

    const mapped = await repository.mapRecords({
      sapRecords,
      hubspotCredentialId: 'cred-1',
      objectType: 'product',
      tenantContext,
    });

    expect(mapped[0].properties.name).toBe('Tornillo');
  });
});
