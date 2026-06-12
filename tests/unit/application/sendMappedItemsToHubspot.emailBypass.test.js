import { jest } from '@jest/globals';
import SendMappedItemsToHubspot from '../../../src/application/use-cases/SendMappedItemsToHubspot.js';

function buildUseCase(overrides = {}) {
  return new SendMappedItemsToHubspot({
    tokenProvider: {
      getAccessToken: jest.fn().mockResolvedValue('token-1'),
    },
    productBatchClient: {},
    associationRegistry: {
      registerBaseObjectMapping: jest.fn().mockResolvedValue(null),
    },
    associationHandler: {
      handleAssociations: jest.fn().mockResolvedValue(null),
    },
    sapHubspotIdUpdater: {
      updateBusinessPartnerInSapFromHubspot: jest.fn().mockResolvedValue(null),
    },
    validationFailureWriter: {
      write: jest.fn().mockResolvedValue(null),
    },
    handlers: {},
    logger: {
      warn: jest.fn(),
    },
    ...overrides,
  });
}

describe('SendMappedItemsToHubspot email bypass', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('sends an empty email to HubSpot when an invalid business partner email is bypassed', async () => {
    const handler = {
      find: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'hs-4' }),
      update: jest.fn(),
    };
    const validationFailureWriter = {
      write: jest.fn().mockResolvedValue(null),
    };
    const associationRegistry = {
      registerBaseObjectMapping: jest.fn().mockResolvedValue(null),
    };
    const logger = {
      warn: jest.fn(),
    };
    const useCase = buildUseCase({
      handlers: { contact: handler },
      validationFailureWriter,
      associationRegistry,
      bypassEmailConfigRepository: {
        isBypassEmailEnabled: jest.fn().mockResolvedValue(true),
      },
      logger,
    });
    const item = {
      properties: {
        email: 'cliente sin correo',
        idsap: 'C004',
      },
    };

    const result = await useCase.execute({
      mappedItems: [item],
      clientConfig: { hubspotCredentialId: 'cred-1' },
      objectType: 'contact',
      tenantModels: { Configuration: {} },
      credentials: { _id: 'cred-1' },
    });

    expect(item.properties.email).toBe('');
    expect(handler.find).toHaveBeenCalledWith(expect.objectContaining({ item }));
    expect(handler.create).toHaveBeenCalledWith(expect.objectContaining({ item }));
    expect(validationFailureWriter.write).not.toHaveBeenCalled();
    expect(associationRegistry.registerBaseObjectMapping).toHaveBeenCalledWith(
      'cred-1',
      'contact',
      'C004',
      'hs-4',
      { Configuration: {} }
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'Invalid business partner email removed before HubSpot sync',
      objectType: 'contact',
      sapId: 'C004',
      email: 'cliente sin correo',
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      sent: 1,
      failed: 0,
      created: 1,
    }));
  });

  it('keeps invalid email untouched when bypassEmail is disabled', async () => {
    const handler = {
      find: jest.fn().mockRejectedValue(new Error('HubSpot email validation failed')),
      create: jest.fn(),
      update: jest.fn(),
    };
    const useCase = buildUseCase({
      handlers: { company: handler },
      bypassEmailConfigRepository: {
        isBypassEmailEnabled: jest.fn().mockResolvedValue(false),
      },
    });
    const item = {
      properties: {
        email: 'micorreo.net',
        idsap: 'C005',
      },
    };

    const result = await useCase.execute({
      mappedItems: [item],
      clientConfig: { hubspotCredentialId: 'cred-1' },
      objectType: 'company',
      tenantModels: { Configuration: {} },
      credentials: { _id: 'cred-1' },
    });

    expect(item.properties.email).toBe('micorreo.net');
    expect(handler.find).toHaveBeenCalledWith(expect.objectContaining({ item }));
    expect(handler.create).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      sent: 0,
      failed: 1,
    }));
  });

  it('sends an empty email to HubSpot when a missing business partner email is bypassed', async () => {
    const handler = {
      find: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'hs-6' }),
      update: jest.fn(),
    };
    const validationFailureWriter = {
      write: jest.fn().mockResolvedValue(null),
    };
    const logger = {
      warn: jest.fn(),
    };
    const useCase = buildUseCase({
      handlers: { contact: handler },
      validationFailureWriter,
      bypassEmailConfigRepository: {
        isBypassEmailEnabled: jest.fn().mockResolvedValue(true),
      },
      logger,
    });
    const item = {
      properties: {
        email: null,
        idsap: 'C006',
      },
    };

    const result = await useCase.execute({
      mappedItems: [item],
      clientConfig: { hubspotCredentialId: 'cred-1' },
      objectType: 'contact',
      tenantModels: { Configuration: {} },
      credentials: { _id: 'cred-1' },
    });

    expect(item.properties.email).toBe('');
    expect(handler.find).toHaveBeenCalledWith(expect.objectContaining({ item }));
    expect(handler.create).toHaveBeenCalledWith(expect.objectContaining({ item }));
    expect(validationFailureWriter.write).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'Missing business partner email bypassed before HubSpot sync',
      objectType: 'contact',
      sapId: 'C006',
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      sent: 1,
      failed: 0,
      created: 1,
    }));
  });
});
