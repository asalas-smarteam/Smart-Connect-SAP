import { jest } from '@jest/globals';

const mockFindContactByEmail = jest.fn();
const mockFindContactByProperty = jest.fn();
const mockUpdateContact = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  findContactByEmail: mockFindContactByEmail,
  findContactByProperty: mockFindContactByProperty,
  updateContact: mockUpdateContact,
  createContact: jest.fn(),
}));

const { find, update, buildBatchUpdateEntry } = await import('../../src/infrastructure/hubspot/handlers/contact.handler.js');

describe('contact.handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const searchProperties = ['email', 'firstname', 'phone', 'idsap', 'idSap', 'internalcode'];
  const configModels = (value) => ({
    Configuration: {
      findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ key: 'defaultFindHubspot', value }) }),
    },
  });

  it('searches by idsap first and stops there when it exists', async () => {
    mockFindContactByProperty.mockResolvedValueOnce({ id: 'hs-1', properties: { idsap: 'C004' } });
    const tenantModels = configModels('phone');

    const existing = await find({
      token: 'token-1',
      tenantModels,
      item: { properties: { idsap: 'C004', phone: '+50527741100', email: '' } },
    });

    expect(existing).toEqual({ id: 'hs-1', properties: { idsap: 'C004' } });
    expect(mockFindContactByProperty).toHaveBeenCalledTimes(1);
    expect(mockFindContactByProperty).toHaveBeenCalledWith('token-1', 'idsap', 'C004', { properties: searchProperties });
    // Found by idsap: the configured property is never even read.
    expect(tenantModels.Configuration.findOne).not.toHaveBeenCalled();
    expect(mockFindContactByEmail).not.toHaveBeenCalled();
  });

  it('falls back to defaultFindHubspot (phone) only when idsap does not exist', async () => {
    mockFindContactByProperty
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'hs-lead', properties: { phone: '+50527741100' } });

    const existing = await find({
      token: 'token-1',
      tenantModels: configModels('phone'),
      item: { properties: { idsap: 'C004', phone: '+50527741100', email: '' } },
    });

    expect(existing).toEqual({ id: 'hs-lead', properties: { phone: '+50527741100' } });
    expect(mockFindContactByProperty).toHaveBeenNthCalledWith(2, 'token-1', 'phone', '+50527741100', {
      properties: searchProperties,
      withoutProperties: ['idsap', 'internalcode'],
    });
  });

  it('without defaultFindHubspot config the second lookup is email, limited to records not owned by SAP', async () => {
    mockFindContactByProperty.mockResolvedValue(null);

    await find({
      token: 'token-1',
      item: { properties: { email: 'x@example.com' } },
    });

    expect(mockFindContactByProperty).toHaveBeenCalledTimes(1);
    expect(mockFindContactByProperty).toHaveBeenCalledWith('token-1', 'email', 'x@example.com', {
      properties: searchProperties,
      withoutProperties: ['idsap', 'internalcode'],
    });
  });

  it('returns null when the second lookup lands on a record owned by another idsap', async () => {
    mockFindContactByProperty
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'hs-other', properties: { idsap: 'OTHER', phone: '+50527741100' } });

    const existing = await find({
      token: 'token-1',
      tenantModels: configModels('phone'),
      item: { properties: { idsap: 'C004', phone: '+50527741100' } },
    });

    expect(existing).toBeNull();
  });

  it('returns null without a second lookup when the item has neither idsap nor the configured value', async () => {
    const existing = await find({
      token: 'token-1',
      tenantModels: configModels('phone'),
      item: { properties: { email: '' } },
    });

    expect(existing).toBeNull();
    expect(mockFindContactByProperty).not.toHaveBeenCalled();
  });

  it('updates only SAP identifiers when key fields changed', async () => {
    mockUpdateContact.mockResolvedValue({ id: 'hs-1' });

    await update({
      token: 'token-1',
      id: 'hs-1',
      existing: {
        id: 'hs-1',
        properties: {
          firstname: 'Old Name',
          phone: '2222',
          idsap: 'BP-01',
        },
      },
      item: {
        properties: {
          firstname: 'New Name',
          phone: '2222',
          idsap: 'BP-01',
          email: 'contact@example.com',
        },
      },
    });

    expect(mockUpdateContact).toHaveBeenCalledWith('token-1', 'hs-1', {
      properties: {
        idsap: 'BP-01',
      },
    });
  });

  it('skips update when key fields did not change', async () => {
    const existing = {
      id: 'hs-1',
      properties: {
        firstname: 'Same Name',
        phone: '2222',
        idsap: 'BP-01',
      },
    };

    const result = await update({
      token: 'token-1',
      id: 'hs-1',
      existing,
      item: {
        properties: {
          firstname: 'Same Name',
          phone: '2222',
          idsap: 'BP-01',
          email: 'contact@example.com',
        },
      },
    });

    expect(result).toBe(existing);
    expect(mockUpdateContact).not.toHaveBeenCalled();
  });

  it('uses internalcode for contactEmployee updates', async () => {
    mockUpdateContact.mockResolvedValue({ id: 'hs-2' });

    await update({
      token: 'token-1',
      id: 'hs-2',
      existing: {
        id: 'hs-2',
        properties: {
          firstname: 'Ana',
          internalcode: '10',
        },
      },
      item: {
        properties: {
          firstname: 'Ana Maria',
          internalcode: '20',
          email: 'employee@example.com',
        },
      },
    });

    expect(mockUpdateContact).toHaveBeenCalledWith('token-1', 'hs-2', {
      properties: {
        internalcode: '20',
      },
    });
  });
});

describe('contact.handler buildBatchUpdateEntry', () => {
  it('returns null when key fields are unchanged', () => {
    expect(buildBatchUpdateEntry({
      existing: { id: 'hs-9', properties: { firstname: 'Ana', phone: '1', idsap: 'P001' } },
      item: { properties: { firstname: 'Ana', phone: '1', idsap: 'P001' } },
    })).toBeNull();
  });

  it('returns an id + identifier payload when key fields changed', () => {
    expect(buildBatchUpdateEntry({
      existing: { id: 'hs-9', properties: { firstname: 'Old', idsap: 'P001' } },
      item: { properties: { firstname: 'New', idsap: 'P001', internalcode: 'IC-1' } },
    })).toEqual({ id: 'hs-9', properties: { idsap: 'P001', internalcode: 'IC-1' } });
  });
});
