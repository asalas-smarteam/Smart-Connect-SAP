import { jest } from '@jest/globals';
import MappingSyncRepository from '../../../src/infrastructure/repositories/MappingSyncRepository.js';

describe('MappingSyncRepository', () => {
  it('creates product default mappings once and returns plain DTOs', async () => {
    const createdMappings = [];
    const FieldMapping = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (payload) => {
        const created = { _id: `mapping-${createdMappings.length + 1}`, ...payload };
        createdMappings.push(created);
        return created;
      }),
      updateOne: jest.fn(),
    };
    const repository = new MappingSyncRepository();

    const result = await repository.ensureDefaultMappings({
      tenantContext: { tenantModels: { FieldMapping } },
      hubspotCredentialId: 'cred-1',
      objectType: 'product',
      clientConfig: { _id: 'cfg-1' },
    });

    expect(FieldMapping.findOne).toHaveBeenCalledTimes(4);
    expect(FieldMapping.create).toHaveBeenCalledTimes(4);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual(expect.objectContaining({
      id: 'mapping-1',
      sourceField: 'ItemCode',
      targetField: 'hs_sku',
      objectType: 'product',
      sourceContext: 'product',
    }));
    expect(result[0]).not.toHaveProperty('save');
  });

  it('maps SAP records with DTO mappings returned by the repository', async () => {
    const fieldMappingRepository = {
      findByCredentialObjectAndContext: jest.fn().mockResolvedValue([
        { _id: 'm-1', sourceField: 'BPAddresses.Street', targetField: 'address', isActive: true },
      ]),
    };
    const repository = new MappingSyncRepository({ fieldMappingRepository });

    const mapped = await repository.mapRecords({
      sapRecords: [{ BPAddresses: [{ Street: 'Main St' }] }],
      hubspotCredentialId: 'cred-1',
      objectType: 'company',
      tenantContext: { tenantModels: { FieldMapping: {} } },
    });

    expect(mapped).toEqual([{ properties: { address: 'Main St' } }]);
  });
});
