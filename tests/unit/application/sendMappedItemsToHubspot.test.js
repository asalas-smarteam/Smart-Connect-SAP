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
      updateHubspotIdInSap: jest.fn().mockResolvedValue(null),
      updateBusinessPartnerInSapFromHubspot: jest.fn().mockResolvedValue(null),
    },
    validationFailureWriter: {
      write: jest.fn().mockResolvedValue(null),
    },
    handlers: {},
    ...overrides,
  });
}

describe('SendMappedItemsToHubspot', () => {
  it('updates SAP from HubSpot when mainDataInUpdate is SAP and item exists', async () => {
    const existing = {
      id: 'hs-1',
      properties: {
        email: 'ana@example.com',
        firstname: 'Ana HubSpot',
        phone: '2222',
        idsap: 'C001',
      },
    };
    const handler = {
      find: jest.fn().mockResolvedValue(existing),
      update: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    };
    const sapHubspotIdUpdater = {
      updateHubspotIdInSap: jest.fn(),
      updateBusinessPartnerInSapFromHubspot: jest.fn().mockResolvedValue(null),
    };
    const useCase = buildUseCase({
      handlers: { contact: handler },
      sapHubspotIdUpdater,
      mainDataInUpdateConfigRepository: {
        getMainDataInUpdate: jest.fn().mockResolvedValue('SAP'),
      },
    });
    const item = {
      properties: {
        email: 'ana@example.com',
        idsap: 'C001',
      },
      rawSapData: {
        CardCode: 'C001',
      },
    };
    const clientConfig = { hubspotCredentialId: 'cred-1' };
    const tenantModels = {};

    const result = await useCase.execute({
      mappedItems: [item],
      clientConfig,
      objectType: 'contact',
      tenantModels,
      credentials: { _id: 'cred-1' },
    });

    expect(handler.update).not.toHaveBeenCalled();
    expect(sapHubspotIdUpdater.updateBusinessPartnerInSapFromHubspot).toHaveBeenCalledWith({
      clientConfig,
      objectType: 'contact',
      item,
      existing,
      tenantModels,
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      sent: 1,
      failed: 0,
      created: 0,
      updated: 1,
    }));
  });

  it('skips the update entirely when mainDataInUpdate is HUBSPOT', async () => {
    const existing = {
      id: 'hs-1',
      properties: {
        email: 'acme@example.com',
        name: 'ACME',
      },
    };
    const handler = {
      find: jest.fn().mockResolvedValue(existing),
      update: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    };
    const sapHubspotIdUpdater = {
      updateHubspotIdInSap: jest.fn(),
      updateBusinessPartnerInSapFromHubspot: jest.fn(),
    };
    const useCase = buildUseCase({
      handlers: { company: handler },
      sapHubspotIdUpdater,
      mainDataInUpdateConfigRepository: {
        getMainDataInUpdate: jest.fn().mockResolvedValue('HUBSPOT'),
      },
    });
    const item = {
      properties: {
        email: 'acme@example.com',
        idsap: 'C002',
      },
    };
    const clientConfig = { hubspotCredentialId: 'cred-1' };
    const tenantModels = {};

    const result = await useCase.execute({
      mappedItems: [item],
      clientConfig,
      objectType: 'company',
      tenantModels,
      credentials: { _id: 'cred-1' },
    });

    expect(handler.update).not.toHaveBeenCalled();
    expect(sapHubspotIdUpdater.updateBusinessPartnerInSapFromHubspot).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      sent: 1,
      failed: 0,
      created: 0,
      updated: 0,
    }));
  });

  it('updates HubSpot when mainDataInUpdate is SAP and objectType is not contact/company', async () => {
    const existing = { id: 'hs-3', properties: { hs_sku: 'SKU-1' } };
    const handler = {
      find: jest.fn().mockResolvedValue(existing),
      update: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    };
    const sapHubspotIdUpdater = {
      updateHubspotIdInSap: jest.fn(),
      updateBusinessPartnerInSapFromHubspot: jest.fn(),
    };
    const useCase = buildUseCase({
      handlers: { product: handler },
      sapHubspotIdUpdater,
      mainDataInUpdateConfigRepository: {
        getMainDataInUpdate: jest.fn().mockResolvedValue('SAP'),
      },
    });
    const item = { properties: { hs_sku: 'SKU-1' } };
    const clientConfig = { hubspotCredentialId: 'cred-1' };
    const tenantModels = {};

    await useCase.execute({
      mappedItems: [item],
      clientConfig,
      objectType: 'product',
      tenantModels,
      credentials: { _id: 'cred-1' },
    });

    expect(handler.update).toHaveBeenCalledWith({
      token: 'token-1',
      id: 'hs-3',
      existing,
      item,
      clientConfig,
      tenantModels,
    });
    expect(sapHubspotIdUpdater.updateBusinessPartnerInSapFromHubspot).not.toHaveBeenCalled();
  });

  it('still creates HubSpot records when no existing item is found', async () => {
    const created = { id: 'hs-2' };
    const handler = {
      find: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      create: jest.fn().mockResolvedValue(created),
    };
    const sapHubspotIdUpdater = {
      updateHubspotIdInSap: jest.fn().mockResolvedValue(null),
      updateBusinessPartnerInSapFromHubspot: jest.fn(),
    };
    const associationRegistry = {
      registerBaseObjectMapping: jest.fn().mockResolvedValue(null),
    };
    const useCase = buildUseCase({
      handlers: { contact: handler },
      sapHubspotIdUpdater,
      associationRegistry,
      mainDataInUpdateConfigRepository: {
        getMainDataInUpdate: jest.fn().mockResolvedValue('SAP'),
      },
    });
    const item = {
      properties: {
        email: 'new@example.com',
        idsap: 'C003',
      },
    };
    const clientConfig = {
      hubspotCredentialId: 'cred-1',
      requireUpdateHubspotID: true,
    };
    const tenantModels = {};

    const result = await useCase.execute({
      mappedItems: [item],
      clientConfig,
      objectType: 'contact',
      tenantModels,
      credentials: { _id: 'cred-1' },
    });

    expect(handler.create).toHaveBeenCalledWith({
      token: 'token-1',
      item,
      clientConfig,
      tenantModels,
    });
    expect(sapHubspotIdUpdater.updateHubspotIdInSap).toHaveBeenCalledWith({
      clientConfig,
      objectType: 'contact',
      sapRecord: item.properties,
      hubspotId: created.id,
      tenantModels,
    });
    expect(associationRegistry.registerBaseObjectMapping).toHaveBeenCalledWith(
      'cred-1',
      'contact',
      'C003',
      created.id,
      tenantModels
    );
    expect(result).toEqual(expect.objectContaining({
      sent: 1,
      created: 1,
      updated: 0,
    }));
  });
});
