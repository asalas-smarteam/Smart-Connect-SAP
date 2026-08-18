import { jest } from '@jest/globals';

// Fix round 1 (Task 5 review finding): updateProducts() searches HubSpot for a product per
// unique itemCode (POST /crm/v3/objects/products/search) before the batch/update call. When
// that per-SKU search failed, the recorder previously had no visibility into it at all -- the
// error just propagated out of updateProducts and got recorded, by the OUTER wrap in
// SyncLineItemPrices, under the batch-update path. This pins that a failing search now gets
// its own entry tagged with the real search endpoint.
const findProductBySKU = jest.fn();
const batchUpdateProducts = jest.fn();

jest.unstable_mockModule('../../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  findProductBySKU,
  batchUpdateProducts,
}));

const { HubspotLineItemPriceClient } = await import('../../../src/infrastructure/external-services/HubspotLineItemPriceClient.js');

function createRecordingCallRecorder() {
  const calls = [];

  return {
    calls,
    record: async (options, run) => {
      try {
        const response = await run();
        calls.push({ ...options, ok: true });
        return response;
      } catch (error) {
        calls.push({ ...options, ok: false, error });
        throw error;
      }
    },
  };
}

describe('HubspotLineItemPriceClient.updateProducts', () => {
  beforeEach(() => {
    findProductBySKU.mockReset();
    batchUpdateProducts.mockReset();
  });

  it('tags a failing per-SKU search with the real search endpoint, not the batch-update path', async () => {
    const searchError = new Error('HubSpot search failed');
    findProductBySKU.mockRejectedValue(searchError);

    const client = new HubspotLineItemPriceClient();
    const callRecorder = createRecordingCallRecorder();

    await expect(
      client.updateProducts({
        token: 'hubspot-token',
        enrichedLineItems: [{ itemCode: 'A0001', id: 'line-1' }],
        tenantKey: 'tenant_1',
        callRecorder,
      })
    ).rejects.toThrow('HubSpot search failed');

    expect(batchUpdateProducts).not.toHaveBeenCalled();

    const searchCallEntry = callRecorder.calls.find(
      (call) => call.path === '/crm/v3/objects/products/search'
    );
    expect(searchCallEntry).toMatchObject({
      target: 'hubspot',
      method: 'POST',
      path: '/crm/v3/objects/products/search',
      ok: false,
    });

    // The failure must not be misattributed to the batch-update endpoint by this recorder
    // instance -- that entry, if present, is only ever added by the OUTER wrap that
    // SyncLineItemPrices places around the whole updateProducts() call, and this test never
    // reaches that outer layer.
    expect(callRecorder.calls.some((call) => call.path === '/crm/v3/objects/products/batch/update')).toBe(false);
  }, 10000);

  it('records a successful per-SKU search, then the batch update, when no recorder is injected', async () => {
    findProductBySKU.mockResolvedValue({ id: 'product-1' });
    batchUpdateProducts.mockResolvedValue({ results: [{ id: 'product-1' }] });

    const client = new HubspotLineItemPriceClient();

    const result = await client.updateProducts({
      token: 'hubspot-token',
      enrichedLineItems: [{ itemCode: 'A0001', id: 'line-1' }],
      tenantKey: 'tenant_1',
    });

    expect(findProductBySKU).toHaveBeenCalledWith('hubspot-token', 'A0001');
    expect(batchUpdateProducts).toHaveBeenCalled();
    expect(result.response).toEqual({ results: [{ id: 'product-1' }] });
  });
});
