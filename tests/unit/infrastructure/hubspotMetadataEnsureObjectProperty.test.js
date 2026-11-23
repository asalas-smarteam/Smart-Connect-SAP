import { jest } from '@jest/globals';

const mockHubspotGet = jest.fn();
const mockHubspotPost = jest.fn();

jest.unstable_mockModule('../../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  fetchDealPipelines: jest.fn(),
  fetchDealStages: jest.fn(),
  fetchOwners: jest.fn(),
  hubspotGet: mockHubspotGet,
  hubspotPost: mockHubspotPost,
}));

const { ensureObjectProperty } = await import(
  '../../../src/infrastructure/hubspot/hubspotMetadata.controller.js'
);

function notFound() {
  const error = new Error('not found');
  error.details = { status: 404 };
  return error;
}

beforeEach(() => {
  mockHubspotGet.mockReset().mockRejectedValue(notFound());
  mockHubspotPost.mockReset().mockImplementation(async (_token, _path, payload) => payload);
});

function createdPayload() {
  return mockHubspotPost.mock.calls[0][2];
}

describe('ensureObjectProperty property group', () => {
  // HubSpot rejects a property whose group does not exist for the object type, so each
  // object type has to land in its own default group.
  it.each([
    ['contacts', 'contactinformation'],
    ['companies', 'companyinformation'],
    ['deal', 'dealinformation'],
    ['deals', 'dealinformation'],
    ['products', 'productinformation'],
  ])('creates a %s property in the %s group', async (objectType, expectedGroup) => {
    await ensureObjectProperty('token-1', { objectType, name: 'sample_prop', label: 'Sample' });

    expect(createdPayload().groupName).toBe(expectedGroup);
  });

  it('keeps an explicit group name over the default of the object type', async () => {
    await ensureObjectProperty('token-1', {
      objectType: 'deal',
      name: 'sample_prop',
      label: 'Sample',
      groupName: 'custom_group',
    });

    expect(createdPayload().groupName).toBe('custom_group');
  });

  it('does not create a property that already exists', async () => {
    mockHubspotGet.mockReset().mockResolvedValue({ name: 'sample_prop' });

    const result = await ensureObjectProperty('token-1', {
      objectType: 'deal',
      name: 'sample_prop',
      label: 'Sample',
    });

    expect(result.created).toBe(false);
    expect(mockHubspotPost).not.toHaveBeenCalled();
  });
});
