import { jest } from '@jest/globals';

const mockAxios = jest.fn();

jest.unstable_mockModule('axios', () => ({
  default: mockAxios,
}));

jest.unstable_mockModule('../../../src/infrastructure/logger/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { listWritablePropertyNames } = await import('../../../src/infrastructure/hubspot/hubspotClient.js');

describe('hubspotClient.listWritablePropertyNames', () => {
  beforeEach(() => {
    mockAxios.mockReset();
  });

  it('requests the line_items properties for the line_item object type and returns only writable names', async () => {
    mockAxios.mockResolvedValueOnce({
      data: {
        results: [
          { name: 'stock_a', modificationMetadata: { readOnlyValue: false } },
          { name: 'hs_object_id', modificationMetadata: { readOnlyValue: true } },
          { name: 'price' },
          { modificationMetadata: {} },
        ],
      },
    });

    const names = await listWritablePropertyNames('test-token', 'line_item');

    expect(names).toEqual(new Set(['stock_a', 'price']));
    expect(mockAxios).toHaveBeenCalledTimes(1);
    expect(mockAxios.mock.calls[0][0].url).toContain('/crm/v3/properties/line_items');
  });
});
