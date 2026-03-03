import { jest } from '@jest/globals';
import mappingService from '../../src/services/mapping.service.js';

describe('mappingService.getMappingsByObjectType', () => {
  it('returns active mappings by object type and source context sorted by _id', async () => {
    const sort = jest.fn().mockResolvedValue([{ targetField: 'name' }]);
    const find = jest.fn().mockReturnValue({ sort });
    const tenantModels = { FieldMapping: { find } };

    const result = await mappingService.getMappingsByObjectType(
      'cred-1',
      'contact',
      'businessPartner',
      tenantModels
    );

    expect(result).toEqual([{ targetField: 'name' }]);
    expect(find).toHaveBeenCalledWith({
      hubspotCredentialId: 'cred-1',
      objectType: 'contact',
      sourceContext: 'businessPartner',
      isActive: true,
    });
    expect(sort).toHaveBeenCalledWith({ _id: 1 });
  });

  it('falls back to businessPartner when source context has no active mappings', async () => {
    const find = jest
      .fn()
      .mockReturnValueOnce({ sort: jest.fn().mockResolvedValue([]) })
      .mockReturnValueOnce({ sort: jest.fn().mockResolvedValue([{ targetField: 'name' }]) });

    const tenantModels = { FieldMapping: { find } };

    const result = await mappingService.getMappingsByObjectType(
      'cred-1',
      'contact',
      'contactEmployee',
      tenantModels
    );

    expect(result).toEqual([{ targetField: 'name' }]);
    expect(find).toHaveBeenCalledTimes(2);
    expect(find).toHaveBeenNthCalledWith(2, {
      hubspotCredentialId: 'cred-1',
      objectType: 'contact',
      sourceContext: 'businessPartner',
      isActive: true,
    });
  });
});
