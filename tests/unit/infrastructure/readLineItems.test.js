import { jest } from '@jest/globals';
import {
  readLineItems,
  readDealLineItemIds,
} from '../../../src/infrastructure/webhook/lineItemPriceWebhook.shared.js';

function hubspot404(endpoint) {
  return Object.assign(new Error('HubSpot API request failed: 404 Not Found'), {
    details: { endpoint, method: 'GET', status: 404, statusText: 'Not Found' },
  });
}

describe('readLineItems', () => {
  it('keeps the readable lines when one of them 404s', async () => {
    const fetch = jest.fn(async (_token, _type, id) => {
      if (id === 'line-2') {
        throw hubspot404('/crm/v3/objects/line_items/line-2');
      }
      return { id, properties: { hs_sku: `SKU-${id}`, quantity: '2' } };
    });

    const result = await readLineItems({
      token: 'tok',
      lineItemIds: ['line-1', 'line-2', 'line-3'],
      fetch,
    });

    expect(result.lineItems).toEqual([
      { id: 'line-1', itemCode: 'SKU-line-1', quantity: '2', properties: { hs_sku: 'SKU-line-1', quantity: '2' } },
      { id: 'line-3', itemCode: 'SKU-line-3', quantity: '2', properties: { hs_sku: 'SKU-line-3', quantity: '2' } },
    ]);
    expect(result.failures).toEqual([{
      id: 'line-2',
      stage: 'hubspot_read',
      reason: 'HubSpot API request failed: 404 Not Found',
      status: 404,
      endpoint: '/crm/v3/objects/line_items/line-2',
    }]);
  });

  it('reports a line without hs_sku as a failure instead of throwing', async () => {
    const fetch = jest.fn(async (_token, _type, id) => ({ id, properties: { quantity: '1' } }));

    const result = await readLineItems({ token: 'tok', lineItemIds: ['line-9'], fetch });

    expect(result.lineItems).toEqual([]);
    expect(result.failures[0]).toMatchObject({
      id: 'line-9',
      stage: 'hubspot_read',
      reason: 'line item has no hs_sku',
      status: null,
    });
  });

  it('requests and exposes the extra properties at the top level', async () => {
    const fetch = jest.fn(async (_token, _type, id) => ({
      id,
      properties: { hs_sku: 'A0001', quantity: '3', miscelaneo: '10', price: '0' },
    }));

    const result = await readLineItems({
      token: 'tok',
      lineItemIds: ['line-1'],
      extraProperties: ['miscelaneo', 'price'],
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith('tok', 'line_items', 'line-1', {
      properties: ['hs_sku', 'quantity', 'miscelaneo', 'price'],
    });
    expect(result.lineItems[0]).toMatchObject({ miscelaneo: '10', price: '0' });
  });

  it('returns empty collections for an empty id list', async () => {
    const fetch = jest.fn();

    const result = await readLineItems({ token: 'tok', lineItemIds: [], fetch });

    expect(result).toEqual({ lineItems: [], failures: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('readDealLineItemIds', () => {
  it('extracts the ids from any of the association aliases', async () => {
    const fetch = jest.fn(async () => ({
      id: '900100',
      associations: { 'line items': { results: [{ id: '1' }, { id: '2' }] } },
    }));

    await expect(readDealLineItemIds({ token: 'tok', dealId: '900100', fetch }))
      .resolves.toEqual(['1', '2']);
    expect(fetch).toHaveBeenCalledWith('tok', 'deals', '900100', {
      associations: ['line_items'],
    });
  });

  it('propagates the error when the deal read fails (fatal by design)', async () => {
    const fetch = jest.fn(async () => {
      throw hubspot404('/crm/v3/objects/deals/900100');
    });

    await expect(readDealLineItemIds({ token: 'tok', dealId: '900100', fetch }))
      .rejects.toThrow('404 Not Found');
  });
});
