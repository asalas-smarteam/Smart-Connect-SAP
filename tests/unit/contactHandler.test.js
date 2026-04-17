import { jest } from '@jest/globals';

const mockFindContactByEmail = jest.fn();
const mockUpdateContact = jest.fn();

jest.unstable_mockModule('../../src/services/hubspotClient.js', () => ({
  findContactByEmail: mockFindContactByEmail,
  updateContact: mockUpdateContact,
  createContact: jest.fn(),
}));

const { find, update } = await import('../../src/services/hubspot/handlers/contact.handler.js');

describe('contact.handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requests key HubSpot properties during email search', async () => {
    mockFindContactByEmail.mockResolvedValue(null);

    await find({
      token: 'token-1',
      item: {
        properties: {
          email: 'contact@example.com',
        },
      },
    });

    expect(mockFindContactByEmail).toHaveBeenCalledWith(
      'token-1',
      'contact@example.com',
      {
        properties: ['email', 'firstname', 'phone', 'idsap', 'idSap', 'internalcode'],
      }
    );
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
