import { jest } from '@jest/globals';
import HandleHubspotAssociations from '../../../src/application/use-cases/HandleHubspotAssociations.js';
import { generateFallbackEmail } from '../../../src/infrastructure/hubspot/utils/email.utils.js';

function buildUseCase(overrides = {}) {
  return new HandleHubspotAssociations({
    associationFetcher: {},
    associationRegistry: {
      findHubspotIdForSapId: jest.fn(),
      registerBaseObjectMapping: jest.fn().mockResolvedValue(null),
    },
    associationService: {
      associateCompanyWithContacts: jest.fn().mockResolvedValue(null),
    },
    fieldMappingService: {
      getMappingsByObjectType: jest.fn().mockResolvedValue([
        { sourceField: 'E_Mail', targetField: 'email' },
      ]),
      mapRecords: jest.fn(),
    },
    contactHandler: {
      find: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'hs-contact-1' }),
      update: jest.fn(),
    },
    fallbackEmailGenerator: jest.fn(),
    logger: {
      warn: jest.fn(),
      error: jest.fn(),
    },
    ...overrides,
  });
}

describe('HandleHubspotAssociations company contact email bypass', () => {
  it('uses SAP contact E_Mail before company EmailAddress fallback', async () => {
    const contactHandler = {
      find: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'hs-contact-1' }),
      update: jest.fn(),
    };
    const fallbackEmailGenerator = jest.fn().mockReturnValue('ovanegas+1050@nicasal.com/dmarcia');
    const useCase = buildUseCase({
      contactHandler,
      fallbackEmailGenerator,
      fieldMappingService: {
        getMappingsByObjectType: jest.fn().mockResolvedValue([
          { sourceField: 'E_Mail', targetField: 'email' },
          { sourceField: 'EmailAddress', targetField: 'email' },
        ]),
        mapRecords: jest.fn().mockResolvedValue([
          { properties: { email: null, firstname: 'EDGAR CUADRA CHAMORRO' } },
        ]),
      },
    });

    await useCase.syncCompanyContacts({
      token: 'token-1',
      item: {
        rawSapData: {
          EmailAddress: 'ovanegas@nicasal.com/dmarcia@nicasal.com',
          ContactEmployees: [
            {
              InternalCode: 1050,
              E_Mail: 'sbarahona@nicasal.com',
            },
          ],
        },
      },
      clientConfig: { hubspotCredentialId: 'cred-1' },
      tenantModels: {},
      companyHubspotId: 'hs-company-1',
    });

    expect(fallbackEmailGenerator).not.toHaveBeenCalled();
    expect(contactHandler.create).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({
        properties: expect.objectContaining({
          email: 'sbarahona@nicasal.com',
        }),
      }),
    }));
  });

  it('uses company EmailAddress with sapInternalCode when SAP contact E_Mail is missing', async () => {
    const contactHandler = {
      find: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'hs-contact-4' }),
      update: jest.fn(),
    };
    const useCase = buildUseCase({
      contactHandler,
      fallbackEmailGenerator: generateFallbackEmail,
      fieldMappingService: {
        getMappingsByObjectType: jest.fn().mockResolvedValue([
          { sourceField: 'E_Mail', targetField: 'email' },
        ]),
        mapRecords: jest.fn().mockResolvedValue([
          { properties: { email: null } },
        ]),
      },
    });

    await useCase.syncCompanyContacts({
      token: 'token-1',
      item: {
        rawSapData: {
          EmailAddress: 'test@test.com',
          ContactEmployees: [
            {
              InternalCode: 300,
              E_Mail: null,
            },
          ],
        },
      },
      clientConfig: { hubspotCredentialId: 'cred-1' },
      tenantModels: {},
      companyHubspotId: 'hs-company-1',
    });

    expect(contactHandler.create).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({
        properties: expect.objectContaining({
          email: 'test+300@test.com',
        }),
      }),
    }));
  });

  it('sends an empty email when associated contact email is invalid and bypassEmail is enabled', async () => {
    const contactHandler = {
      find: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'hs-contact-2' }),
      update: jest.fn(),
    };
    const logger = {
      warn: jest.fn(),
      error: jest.fn(),
    };
    const useCase = buildUseCase({
      contactHandler,
      logger,
      bypassEmailConfigRepository: {
        isBypassEmailEnabled: jest.fn().mockResolvedValue(true),
      },
      fieldMappingService: {
        getMappingsByObjectType: jest.fn().mockResolvedValue([
          { sourceField: 'E_Mail', targetField: 'email' },
        ]),
        mapRecords: jest.fn().mockResolvedValue([
          { properties: { email: 'ovanegas@nicasal.com/dmarcia@nicasal.com' } },
        ]),
      },
    });

    await useCase.syncCompanyContacts({
      token: 'token-1',
      item: {
        rawSapData: {
          EmailAddress: 'company@example.com',
          ContactEmployees: [
            {
              InternalCode: 1051,
              E_Mail: 'ovanegas@nicasal.com/dmarcia@nicasal.com',
            },
          ],
        },
      },
      clientConfig: { hubspotCredentialId: 'cred-1' },
      tenantModels: { Configuration: {} },
      companyHubspotId: 'hs-company-1',
    });

    expect(contactHandler.create).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({
        properties: expect.objectContaining({
          email: '',
        }),
      }),
    }));
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'Invalid business partner email removed before HubSpot sync',
      objectType: 'contact',
      sapId: 1051,
      email: 'ovanegas@nicasal.com/dmarcia@nicasal.com',
    }));
  });

  it('sends an empty email when generated company fallback email is invalid and bypassEmail is enabled', async () => {
    const contactHandler = {
      find: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'hs-contact-3' }),
      update: jest.fn(),
    };
    const useCase = buildUseCase({
      contactHandler,
      bypassEmailConfigRepository: {
        isBypassEmailEnabled: jest.fn().mockResolvedValue(true),
      },
      fallbackEmailGenerator: jest.fn().mockReturnValue('ovanegas+1052@nicasal.com/dmarcia'),
      fieldMappingService: {
        getMappingsByObjectType: jest.fn().mockResolvedValue([
          { sourceField: 'E_Mail', targetField: 'email' },
        ]),
        mapRecords: jest.fn().mockResolvedValue([
          { properties: { email: null } },
        ]),
      },
    });

    await useCase.syncCompanyContacts({
      token: 'token-1',
      item: {
        rawSapData: {
          EmailAddress: 'ovanegas@nicasal.com/dmarcia@nicasal.com',
          ContactEmployees: [
            {
              InternalCode: 1052,
              E_Mail: null,
            },
          ],
        },
      },
      clientConfig: { hubspotCredentialId: 'cred-1' },
      tenantModels: { Configuration: {} },
      companyHubspotId: 'hs-company-1',
    });

    expect(contactHandler.create).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({
        properties: expect.objectContaining({
          email: '',
        }),
      }),
    }));
  });

  it('sends an empty email when SAP contact and company emails are missing and bypassEmail is enabled', async () => {
    const contactHandler = {
      find: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'hs-contact-5' }),
      update: jest.fn(),
    };
    const useCase = buildUseCase({
      contactHandler,
      fallbackEmailGenerator: generateFallbackEmail,
      bypassEmailConfigRepository: {
        isBypassEmailEnabled: jest.fn().mockResolvedValue(true),
      },
      fieldMappingService: {
        getMappingsByObjectType: jest.fn().mockResolvedValue([
          { sourceField: 'E_Mail', targetField: 'email' },
        ]),
        mapRecords: jest.fn().mockResolvedValue([
          { properties: { email: null } },
        ]),
      },
    });

    await useCase.syncCompanyContacts({
      token: 'token-1',
      item: {
        rawSapData: {
          EmailAddress: null,
          ContactEmployees: [
            {
              InternalCode: 300,
              E_Mail: null,
            },
          ],
        },
      },
      clientConfig: { hubspotCredentialId: 'cred-1' },
      tenantModels: { Configuration: {} },
      companyHubspotId: 'hs-company-1',
    });

    expect(contactHandler.create).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({
        properties: expect.objectContaining({
          email: '',
        }),
      }),
    }));
  });

  it('does not sync when SAP contact and company emails are missing and bypassEmail is disabled', async () => {
    const contactHandler = {
      find: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    const logger = {
      warn: jest.fn(),
      error: jest.fn(),
    };
    const useCase = buildUseCase({
      contactHandler,
      logger,
      fallbackEmailGenerator: generateFallbackEmail,
      bypassEmailConfigRepository: {
        isBypassEmailEnabled: jest.fn().mockResolvedValue(false),
      },
      fieldMappingService: {
        getMappingsByObjectType: jest.fn().mockResolvedValue([
          { sourceField: 'E_Mail', targetField: 'email' },
        ]),
        mapRecords: jest.fn().mockResolvedValue([
          { properties: { email: null } },
        ]),
      },
    });

    await useCase.syncCompanyContacts({
      token: 'token-1',
      item: {
        rawSapData: {
          EmailAddress: null,
          ContactEmployees: [
            {
              InternalCode: 300,
              E_Mail: null,
            },
          ],
        },
      },
      clientConfig: { hubspotCredentialId: 'cred-1' },
      tenantModels: { Configuration: {} },
      companyHubspotId: 'hs-company-1',
    });

    expect(contactHandler.find).not.toHaveBeenCalled();
    expect(contactHandler.create).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Company contact sync error:',
      expect.any(Error)
    );
  });
});
