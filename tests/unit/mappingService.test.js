import { jest } from '@jest/globals';
import mappingService from '../../src/services/mapping.service.js';

describe('mappingService.mapRecords', () => {
  it('maps nested array fields using the first array element', async () => {
    const tenantModels = {
      FieldMapping: {
        find: jest.fn().mockReturnValue({
          sort: jest.fn().mockResolvedValue([
            { sourceField: 'BPAddresses.Street', targetField: 'address', isActive: true },
          ]),
        }),
      },
    };

    const records = [
      {
        BPAddresses: [{ Street: 'Main St' }, { Street: 'Second St' }],
      },
    ];

    const mapped = await mappingService.mapRecords(records, 'cred-1', 'company', tenantModels);

    expect(mapped).toEqual([{ properties: { address: 'Main St' } }]);
  });

  it('returns null when nested array path does not exist', async () => {
    const tenantModels = {
      FieldMapping: {
        find: jest.fn().mockReturnValue({
          sort: jest.fn().mockResolvedValue([
            { sourceField: 'BPAddresses.Street', targetField: 'address', isActive: true },
          ]),
        }),
      },
    };

    const mapped = await mappingService.mapRecords([{}], 'cred-1', 'company', tenantModels);

    expect(mapped).toEqual([{ properties: { address: null } }]);
  });
});
