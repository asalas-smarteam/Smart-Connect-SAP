import { jest } from '@jest/globals';

const mockRequireTenantModels = jest.fn();

jest.unstable_mockModule('../../src/utils/tenantModels.js', () => ({
  requireTenantModels: mockRequireTenantModels,
}));

const { createMapping } = await import('../../src/controllers/mapping.controller.js');

describe('mapping.controller createMapping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 409 when mapping already exists', async () => {
    const FieldMapping = {
      findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'm1' }) }),
      create: jest.fn(),
    };

    mockRequireTenantModels.mockReturnValue({ FieldMapping });

    const req = {
      body: {
        sourceField: 'CardCode',
        targetField: 'sap_card_code',
        objectType: 'company',
        hubspotCredentialId: 'cred-1',
      },
    };

    const reply = {
      code: jest.fn().mockReturnThis(),
      send: jest.fn((payload) => payload),
    };

    await createMapping(req, reply);

    expect(reply.code).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith({
      ok: false,
      message: 'Mapping already exists for this sourceField and objectType.',
    });
    expect(FieldMapping.create).not.toHaveBeenCalled();
  });

  it('returns 409 when create hits duplicate key race condition', async () => {
    const duplicateError = new Error('E11000 duplicate key error');
    duplicateError.code = 11000;

    const FieldMapping = {
      findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      create: jest.fn().mockRejectedValue(duplicateError),
    };

    mockRequireTenantModels.mockReturnValue({ FieldMapping });

    const req = {
      body: {
        sourceField: 'CardCode',
        targetField: 'sap_card_code',
        objectType: 'company',
        sourceContext: 'businessPartner',
        hubspotCredentialId: 'cred-1',
      },
    };

    const reply = {
      code: jest.fn().mockReturnThis(),
      send: jest.fn((payload) => payload),
    };

    await createMapping(req, reply);

    expect(reply.code).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith({
      ok: false,
      message: 'Mapping already exists for this sourceField and objectType.',
    });
  });
});
