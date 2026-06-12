import { jest } from '@jest/globals';

const mockFindCompanyByEmail = jest.fn();
const mockFindCompanyByProperty = jest.fn();
const mockUpdateCompany = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  findCompanyByEmail: mockFindCompanyByEmail,
  findCompanyByProperty: mockFindCompanyByProperty,
  updateCompany: mockUpdateCompany,
  createCompany: jest.fn(),
}));

const { find, update } = await import('../../src/infrastructure/hubspot/handlers/company.handler.js');

describe('company.handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requests key HubSpot properties during email search', async () => {
    mockFindCompanyByEmail.mockResolvedValue(null);

    await find({
      token: 'token-1',
      item: {
        properties: {
          email: 'company@example.com',
        },
      },
    });

    expect(mockFindCompanyByEmail).toHaveBeenCalledWith(
      'token-1',
      'company@example.com',
      {
        properties: ['email', 'name', 'phone', 'idsap', 'idSap'],
      }
    );
  });

  it('uses configured HubSpot property when email is empty', async () => {
    mockFindCompanyByProperty.mockResolvedValue({ id: 'hs-company-1' });
    const lean = jest.fn().mockResolvedValue({
      key: 'defaultFindHubspot',
      value: 'idsap',
    });
    const findOne = jest.fn().mockReturnValue({ lean });

    const existing = await find({
      token: 'token-1',
      tenantModels: {
        Configuration: { findOne },
      },
      item: {
        properties: {
          email: '',
          idsap: 'C004',
        },
      },
    });

    expect(existing).toEqual({ id: 'hs-company-1' });
    expect(findOne).toHaveBeenCalledWith({ key: 'defaultFindHubspot' });
    expect(mockFindCompanyByEmail).not.toHaveBeenCalled();
    expect(mockFindCompanyByProperty).toHaveBeenCalledWith(
      'token-1',
      'idsap',
      'C004',
      {
        properties: ['email', 'name', 'phone', 'idsap', 'idSap'],
      }
    );
  });

  it('updates only SAP identifier when key fields changed', async () => {
    mockUpdateCompany.mockResolvedValue({ id: 'hs-company-1' });

    await update({
      token: 'token-1',
      id: 'hs-company-1',
      existing: {
        id: 'hs-company-1',
        properties: {
          name: 'Old Company',
          phone: '8888',
          idsap: 'C-01',
        },
      },
      item: {
        properties: {
          name: 'New Company',
          phone: '8888',
          idsap: 'C-01',
          email: 'company@example.com',
        },
      },
    });

    expect(mockUpdateCompany).toHaveBeenCalledWith('token-1', 'hs-company-1', {
      properties: {
        idsap: 'C-01',
      },
    });
  });

  it('skips update when key fields did not change', async () => {
    const existing = {
      id: 'hs-company-1',
      properties: {
        name: 'Same Company',
        phone: '8888',
        idsap: 'C-01',
      },
    };

    const result = await update({
      token: 'token-1',
      id: 'hs-company-1',
      existing,
      item: {
        properties: {
          name: 'Same Company',
          phone: '8888',
          idsap: 'C-01',
          email: 'company@example.com',
        },
      },
    });

    expect(result).toBe(existing);
    expect(mockUpdateCompany).not.toHaveBeenCalled();
  });
});
