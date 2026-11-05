import { jest } from '@jest/globals';

const mockAxios = jest.fn();

jest.unstable_mockModule('axios', () => ({
  default: mockAxios,
}));

jest.unstable_mockModule('../../../src/infrastructure/logger/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { fetchProductPropertyNames } = await import(
  '../../../src/infrastructure/hubspot/hubspotClient.js'
);

describe('hubspotClient.fetchProductPropertyNames', () => {
  beforeEach(() => {
    mockAxios.mockReset();
  });

  it('returns the names of the existing product properties', async () => {
    mockAxios.mockResolvedValueOnce({
      data: {
        results: [
          { name: 'hs_sku', label: 'SKU' },
          { name: 'name', label: 'Name' },
          { name: 'a01_stock', label: 'A01 stock' },
        ],
      },
    });

    const names = await fetchProductPropertyNames('token-1');

    expect(names).toEqual(['hs_sku', 'name', 'a01_stock']);
    expect(mockAxios).toHaveBeenCalledTimes(1);
    expect(mockAxios.mock.calls[0][0].url).toBe(
      'https://api.hubapi.com/crm/v3/properties/products'
    );
    expect(mockAxios.mock.calls[0][0].method).toBe('get');
  });

  it('returns an empty list when the response has no results', async () => {
    mockAxios.mockResolvedValueOnce({ data: {} });

    await expect(fetchProductPropertyNames('token-1')).resolves.toEqual([]);
  });

  it('returns an empty list when results is empty', async () => {
    mockAxios.mockResolvedValueOnce({ data: { results: [] } });

    await expect(fetchProductPropertyNames('token-1')).resolves.toEqual([]);
  });

  it('ignores entries without a usable name', async () => {
    mockAxios.mockResolvedValueOnce({
      data: { results: [{ name: 'hs_sku' }, {}, { name: '' }, null] },
    });

    await expect(fetchProductPropertyNames('token-1')).resolves.toEqual(['hs_sku']);
  });
});
