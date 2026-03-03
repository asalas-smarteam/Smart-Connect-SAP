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

  it('preserves deal association fields in mapped output', async () => {
    const tenantModels = {
      FieldMapping: {
        find: jest.fn().mockReturnValue({
          sort: jest.fn().mockResolvedValue([
            { sourceField: 'Name', targetField: 'dealname', isActive: true },
          ]),
        }),
      },
    };

    const mapped = await mappingService.mapRecords(
      [
        {
          Name: 'Deal 1',
          associatedContacts: ['c-1'],
          associatedCompanies: ['co-1'],
          associatedProducts: ['p-1'],
        },
      ],
      'cred-1',
      'deal',
      tenantModels
    );

    expect(mapped).toEqual([
      {
        properties: { dealname: 'Deal 1' },
        associatedContacts: ['c-1'],
        associatedCompanies: ['co-1'],
        associatedProducts: ['p-1'],
      },
    ]);
  });

  it('falls back to businessPartner mappings when source context has no mappings', async () => {
    const find = jest
      .fn()
      .mockReturnValueOnce({ sort: jest.fn().mockResolvedValue([]) })
      .mockReturnValueOnce({
        sort: jest.fn().mockResolvedValue([
          { sourceField: 'Name', targetField: 'name', isActive: true, sourceContext: 'businessPartner' },
        ]),
      });

    const tenantModels = {
      FieldMapping: { find },
    };

    const mapped = await mappingService.mapRecords(
      [{ Name: 'Alice' }],
      'cred-1',
      'contact',
      tenantModels,
      'contactEmployee'
    );

    expect(mapped).toEqual([{ properties: { name: 'Alice' } }]);
    expect(find).toHaveBeenCalledTimes(2);
  });
});
