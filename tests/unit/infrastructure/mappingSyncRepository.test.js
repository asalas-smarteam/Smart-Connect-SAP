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

  it('does not seed product default mappings for S/4 tenants (DB-only for this flavor)', async () => {
    const FieldMapping = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      updateOne: jest.fn(),
    };
    const Configuration = {
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ key: 'sapFlavor', value: 'S4' }),
      }),
    };
    const repository = new MappingSyncRepository();

    const result = await repository.ensureDefaultMappings({
      tenantContext: { tenantModels: { FieldMapping, Configuration } },
      hubspotCredentialId: 'cred-1',
      objectType: 'product',
      clientConfig: { _id: 'cfg-1' },
    });

    expect(result).toEqual([]);
    expect(FieldMapping.findOne).not.toHaveBeenCalled();
    expect(FieldMapping.create).not.toHaveBeenCalled();
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
