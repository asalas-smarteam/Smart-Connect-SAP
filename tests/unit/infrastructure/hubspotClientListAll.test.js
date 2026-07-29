import { jest } from '@jest/globals';

const mockAxios = jest.fn();

jest.unstable_mockModule('axios', () => ({
  default: mockAxios,
}));

const { listAllObjects } = await import('../../../src/infrastructure/hubspot/hubspotClient.js');

// Builds one HubSpot list-page response. `after` present => more pages pending.
function page(records, after) {
  return {
    data: {
      results: records,
      ...(after ? { paging: { next: { after } } } : {}),
    },
  };
}

function record(id) {
  return { id, properties: { idsap: `C${id}` } };
}

describe('hubspotClient.listAllObjects', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('follows the cursor and concatenates every page in order', async () => {
    mockAxios
      .mockResolvedValueOnce(page([record('1'), record('2')], 'cursor-1'))
      .mockResolvedValueOnce(page([record('3')]));

    const records = await listAllObjects('token-1', 'company');

    expect(records.map((item) => item.id)).toEqual(['1', '2', '3']);
    expect(mockAxios).toHaveBeenCalledTimes(2);

    // First request opens the sweep with no cursor.
    expect(mockAxios.mock.calls[0][0].params.after).toBeUndefined();
    expect(mockAxios.mock.calls[0][0].url).toBe('https://api.hubapi.com/crm/v3/objects/companies');

    // Second request carries the cursor handed back by the first.
    expect(mockAxios.mock.calls[1][0].params.after).toBe('cursor-1');
  });

  it('sends the page limit and the joined properties list', async () => {
    mockAxios.mockResolvedValueOnce(page([record('1')]));

    await listAllObjects('token-1', 'contact', ['idsap', 'name']);

    expect(mockAxios).toHaveBeenCalledTimes(1);
    expect(mockAxios.mock.calls[0][0].params).toEqual(
      expect.objectContaining({
        limit: 100,
        properties: 'idsap,name',
      })
    );
    expect(mockAxios.mock.calls[0][0].url).toBe('https://api.hubapi.com/crm/v3/objects/contacts');
  });

  it('throws instead of returning a partial index when the page guard trips', async () => {
    // Every page reports another page pending, so the cursor never exhausts.
    mockAxios.mockImplementation(async () => page([record('x')], 'cursor-forever'));

    await expect(listAllObjects('token-1', 'company', [], { maxPages: 3 }))
      .rejects.toThrow(/refusing to return a partial index/);

    expect(mockAxios).toHaveBeenCalledTimes(3);
  });

  it('does not throw when pagination exhausts exactly at the cap', async () => {
    mockAxios
      .mockResolvedValueOnce(page([record('1')], 'cursor-1'))
      .mockResolvedValueOnce(page([record('2')], 'cursor-2'))
      .mockResolvedValueOnce(page([record('3')]));

    const records = await listAllObjects('token-1', 'company', [], { maxPages: 3 });

    expect(records.map((item) => item.id)).toEqual(['1', '2', '3']);
    expect(mockAxios).toHaveBeenCalledTimes(3);
  });
});
