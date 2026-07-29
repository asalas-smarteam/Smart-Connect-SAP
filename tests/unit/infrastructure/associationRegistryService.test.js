import { jest } from '@jest/globals';
import associationRegistryService from '../../../src/infrastructure/hubspot/associationRegistryService.js';

function buildRegistryModel(records = []) {
  return {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockResolvedValue(records),
    }),
    insertMany: jest.fn().mockResolvedValue(records),
  };
}

describe('associationRegistryService bulk operations', () => {
  it('resolves hubspot ids for many sap ids in one query, newest wins', async () => {
    const AssociationRegistry = buildRegistryModel([
      { baseSapId: 'C001', baseHubspotId: 'hs-new' },
      { baseSapId: 'C001', baseHubspotId: 'hs-old' },
      { baseSapId: 'C002', baseHubspotId: 'hs-2' },
    ]);

    const result = await associationRegistryService.findHubspotIdsForSapIds(
      'cred-1',
      'company',
      ['C001', 'C002', 'C404'],
      { AssociationRegistry }
    );

    expect(AssociationRegistry.find).toHaveBeenCalledWith({
      hubspotCredentialId: 'cred-1',
      baseObjectType: 'company',
      baseSapId: { $in: ['C001', 'C002', 'C404'] },
    });
    expect(result.get('C001')).toBe('hs-new');
    expect(result.get('C002')).toBe('hs-2');
    expect(result.has('C404')).toBe(false);
  });

  it('returns an empty map when input is empty or the query fails', async () => {
    const empty = await associationRegistryService.findHubspotIdsForSapIds('cred-1', 'company', [], {});
    expect(empty.size).toBe(0);

    const failing = {
      find: jest.fn(() => { throw new Error('db down'); }),
    };
    const onError = await associationRegistryService.findHubspotIdsForSapIds(
      'cred-1', 'company', ['C001'], { AssociationRegistry: failing }
    );
    expect(onError.size).toBe(0);
  });

  it('registers many base mappings with a single unordered insertMany', async () => {
    const AssociationRegistry = buildRegistryModel();

    await associationRegistryService.registerBaseObjectMappings(
      'cred-1',
      'contact',
      [{ sapId: 'P001', hubspotId: 'hs-1' }, { sapId: '', hubspotId: 'hs-x' }, { sapId: 'P002', hubspotId: '' }],
      { AssociationRegistry }
    );

    expect(AssociationRegistry.insertMany).toHaveBeenCalledTimes(1);
    const [docs, options] = AssociationRegistry.insertMany.mock.calls[0];
    expect(options).toEqual({ ordered: false });
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({
      hubspotCredentialId: 'cred-1',
      baseObjectType: 'contact',
      baseSapId: 'P001',
      baseHubspotId: 'hs-1',
      associatedObjectType: null,
    });
  });

  it('does not throw when insertMany fails', async () => {
    const AssociationRegistry = {
      insertMany: jest.fn().mockRejectedValue(new Error('dup key')),
    };

    await expect(associationRegistryService.registerBaseObjectMappings(
      'cred-1', 'contact', [{ sapId: 'P001', hubspotId: 'hs-1' }], { AssociationRegistry }
    )).resolves.toEqual([]);
  });
});
