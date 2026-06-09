import { jest } from '@jest/globals';
import HubspotSyncAdapter from '../../src/infrastructure/hubspot/HubspotSyncAdapter.js';

describe('HubspotSyncAdapter', () => {
  it('delegates mapped records to the injected HubSpot transport and returns plain metrics', async () => {
    const sendMappedItemsToHubspot = {
      execute: jest.fn().mockResolvedValue({
        ok: true,
        sent: 2,
        failed: 0,
        created: 1,
        updated: 1,
        rawResponse: { hidden: true },
      }),
    };
    const adapter = new HubspotSyncAdapter({ sendMappedItemsToHubspot });
    const tenantContext = { tenantModels: {} };
    const mappedRecords = [{ properties: { email: 'person@example.com' } }];
    const config = { hubspotCredentialId: 'cred-1' };
    const credentials = { _id: 'cred-1' };

    const result = await adapter.send({
      mappedRecords,
      config,
      objectType: 'contact',
      tenantContext,
      credentials,
    });

    expect(sendMappedItemsToHubspot.execute).toHaveBeenCalledWith({
      mappedItems: mappedRecords,
      clientConfig: config,
      objectType: 'contact',
      tenantModels: tenantContext.tenantModels,
      credentials,
    });
    expect(result).toEqual({
      sent: 2,
      failed: 0,
      created: 1,
      updated: 1,
    });
  });

  it('fails clearly when the HubSpot transport dependency is missing', async () => {
    const adapter = new HubspotSyncAdapter();

    await expect(adapter.send({
      mappedRecords: [],
      config: {},
      objectType: 'contact',
      tenantContext: { tenantModels: {} },
      credentials: {},
    })).rejects.toThrow('HubSpot sync transport dependency is required');
  });
});
