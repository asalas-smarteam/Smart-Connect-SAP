import { jest } from '@jest/globals';
import SendMappedItemsToHubspot, {
  productPropertiesUnchanged,
} from '../../../src/application/use-cases/SendMappedItemsToHubspot.js';

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

describe('SendMappedItemsToHubspot product batch sync via batch read', () => {
  const clientConfig = { hubspotCredentialId: 'cred-1', hubspotBatchSize: 30 };
  const tenantModels = {};

  function buildBatchDeps({ readResults = [], handlerOverrides = {} } = {}) {
    const productBatchClient = {
      batchReadProductsBySku: jest.fn().mockResolvedValue({ results: readResults }),
      batchCreateProducts: jest.fn().mockResolvedValue({ results: [] }),
      batchUpdateProducts: jest.fn().mockResolvedValue({ results: [] }),
    };
    const handler = {
      find: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'hs-seq' }),
      update: jest.fn().mockResolvedValue(null),
      ...handlerOverrides,
    };
    const useCase = buildUseCase({
      productBatchClient,
      handlers: { product: handler },
      sleeper: jest.fn().mockResolvedValue(undefined),
    });

    return { useCase, productBatchClient, handler };
  }

  function run(useCase, mappedItems, config = clientConfig) {
    return useCase.execute({
      mappedItems,
      clientConfig: config,
      objectType: 'product',
      tenantModels,
      credentials: { _id: 'cred-1' },
    });
  }

  it('partitions items into create, update and skip using a single batch read', async () => {
    const { useCase, productBatchClient } = buildBatchDeps({
      readResults: [
        { id: '1', properties: { hs_sku: 'SKU-A', name: 'A', price: '10' } },
        { id: '2', properties: { hs_sku: 'SKU-B', name: 'OLD', price: '10' } },
      ],
    });
    const unchangedItem = { properties: { hs_sku: 'SKU-A', name: 'A', price: 10 } };
    const changedItem = { properties: { hs_sku: 'SKU-B', name: 'B nuevo', price: '10' } };
    const newItem = { properties: { hs_sku: 'SKU-C', name: 'C', price: '5' } };

    const result = await run(useCase, [unchangedItem, changedItem, newItem]);

    expect(productBatchClient.batchReadProductsBySku).toHaveBeenCalledTimes(1);
    expect(productBatchClient.batchReadProductsBySku).toHaveBeenCalledWith(
      'token-1',
      ['SKU-A', 'SKU-B', 'SKU-C'],
      expect.arrayContaining(['hs_sku', 'name', 'price'])
    );
    expect(productBatchClient.batchCreateProducts).toHaveBeenCalledTimes(1);
    expect(productBatchClient.batchCreateProducts).toHaveBeenCalledWith('token-1', {
      inputs: [newItem],
    });
    expect(productBatchClient.batchUpdateProducts).toHaveBeenCalledTimes(1);
    expect(productBatchClient.batchUpdateProducts).toHaveBeenCalledWith('token-1', {
      inputs: [{ id: '2', properties: changedItem.properties }],
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      sent: 3,
      failed: 0,
      created: 1,
      updated: 1,
      skipped: 1,
    }));
  });

  it('skips the write entirely when the product has no changes', async () => {
    const { useCase, productBatchClient } = buildBatchDeps({
      readResults: [
        { id: '1', properties: { hs_sku: 'SKU-A', name: 'A' } },
      ],
    });

    const result = await run(useCase, [{ properties: { hs_sku: 'SKU-A', name: 'A' } }]);

    expect(productBatchClient.batchCreateProducts).not.toHaveBeenCalled();
    expect(productBatchClient.batchUpdateProducts).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      sent: 1,
      created: 0,
      updated: 0,
      skipped: 1,
    }));
  });

  it('treats numeric strings as equal values in the diff', async () => {
    const { useCase, productBatchClient } = buildBatchDeps({
      readResults: [
        { id: '1', properties: { hs_sku: 'SKU-N', hs_price_usd: '191.4900', qty: '5.0' } },
      ],
    });

    const result = await run(useCase, [
      { properties: { hs_sku: 'SKU-N', hs_price_usd: 191.49, qty: '5' } },
    ]);

    expect(productBatchClient.batchUpdateProducts).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ skipped: 1, updated: 0 }));

    expect(productPropertiesUnchanged({ a: '5.0' }, { a: '5' })).toBe(true);
    expect(productPropertiesUnchanged({ a: null }, { a: '' })).toBe(true);
    expect(productPropertiesUnchanged({ a: null }, {})).toBe(true);
    expect(productPropertiesUnchanged({ a: 0 }, { a: '' })).toBe(false);
    expect(productPropertiesUnchanged({ a: 'a' }, { a: 'b' })).toBe(false);
  });

  it('falls back to the sequential path when the batch read fails', async () => {
    const { useCase, productBatchClient, handler } = buildBatchDeps({
      handlerOverrides: {
        find: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'hs-9' }),
      },
    });
    productBatchClient.batchReadProductsBySku.mockRejectedValue(new Error('boom'));

    const result = await run(useCase, [
      { properties: { hs_sku: 'SKU-A', name: 'A' } },
      { properties: { hs_sku: 'SKU-B', name: 'B' } },
    ]);

    expect(handler.find).toHaveBeenCalledTimes(2);
    expect(handler.create).toHaveBeenCalledTimes(2);
    expect(productBatchClient.batchCreateProducts).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      sent: 2,
      failed: 0,
      created: 2,
    }));
  });

  it('chunks the batch read at 100 SKUs regardless of hubspotBatchSize', async () => {
    const { useCase, productBatchClient } = buildBatchDeps();
    const items = Array.from({ length: 250 }, (_, index) => ({
      properties: { hs_sku: `SKU-${index}` },
    }));

    await run(useCase, items);

    expect(productBatchClient.batchReadProductsBySku).toHaveBeenCalledTimes(3);
    const chunkSizes = productBatchClient.batchReadProductsBySku.mock.calls
      .map(([, skus]) => skus.length)
      .sort((a, b) => b - a);
    expect(chunkSizes).toEqual([100, 100, 50]);
  });

  it('resolves the preprocess context once and passes it to every preprocess call', async () => {
    const preprocessContext = {
      warehouseFields: [{ warehouseCode: 'A01', propertyName: 'A01_stock' }],
      priceFields: ['hs_price_nio'],
    };
    const buildPreprocessContext = jest.fn().mockResolvedValue(preprocessContext);
    const preprocessCalls = [];
    const { useCase, productBatchClient } = buildBatchDeps({
      handlerOverrides: {
        buildPreprocessContext,
        preprocess: jest.fn(async (args) => {
          preprocessCalls.push(args);
        }),
      },
    });
    productBatchClient.batchReadProductsBySku.mockResolvedValue({ results: [] });

    const items = [
      { properties: { hs_sku: 'SKU-A' } },
      { properties: { hs_sku: 'SKU-B' } },
      { properties: { hs_sku: 'SKU-C' } },
    ];

    await run(useCase, items);

    expect(buildPreprocessContext).toHaveBeenCalledTimes(1);
    expect(buildPreprocessContext).toHaveBeenCalledWith({
      clientConfig,
      tenantModels,
    });
    expect(preprocessCalls).toHaveLength(3);
    for (const call of preprocessCalls) {
      expect(call.preprocessContext).toBe(preprocessContext);
    }
  });

  it('chunks writes by hubspotBatchSize', async () => {
    const { useCase, productBatchClient } = buildBatchDeps();
    const items = Array.from({ length: 60 }, (_, index) => ({
      properties: { hs_sku: `SKU-${index}` },
    }));

    const result = await run(useCase, items);

    expect(productBatchClient.batchCreateProducts).toHaveBeenCalledTimes(2);
    for (const [, payload] of productBatchClient.batchCreateProducts.mock.calls) {
      expect(payload.inputs).toHaveLength(30);
    }
    expect(result).toEqual(expect.objectContaining({ sent: 60, created: 60 }));
  });
});
