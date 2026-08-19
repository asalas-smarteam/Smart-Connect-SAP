import { jest } from '@jest/globals';
import SendMappedItemsToHubspot from '../../../src/application/use-cases/SendMappedItemsToHubspot.js';

function buildUseCase(handler, overrides = {}) {
  return new SendMappedItemsToHubspot({
    tokenProvider: { getAccessToken: jest.fn().mockResolvedValue('token-1') },
    productBatchClient: {},
    associationRegistry: { registerBaseObjectMapping: jest.fn().mockResolvedValue(null) },
    associationHandler: { handleAssociations: jest.fn().mockResolvedValue(null) },
    sapHubspotIdUpdater: {
      updateHubspotIdInSap: jest.fn().mockResolvedValue(null),
      updateBusinessPartnerInSapFromHubspot: jest.fn().mockResolvedValue(null),
    },
    validationFailureWriter: { write: jest.fn().mockResolvedValue(null) },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    handlers: { invoice: handler },
    ...overrides,
  });
}

function execute(useCase, mappedItems) {
  return useCase.execute({
    mappedItems,
    clientConfig: { hubspotCredentialId: 'cred-1' },
    objectType: 'invoice',
    tenantModels: {},
    credentials: { _id: 'cred-1' },
  });
}

const items = [{ properties: { sap_docnum: 1 } }, { properties: { sap_docnum: 2 } }, { properties: { sap_docnum: 3 } }];

describe('SendMappedItemsToHubspot invoice counters', () => {
  // El bug que motivó esto: un `skipped` sumaba a `sent`, así que una corrida
  // que no movió ni un negocio se veía igual que una que los movió todos.
  it('keeps skipped out of sent and breaks the reasons down', async () => {
    const handler = {
      process: jest.fn()
        .mockResolvedValueOnce({ status: 'skipped', reason: 'no_deal_in_num_at_card' })
        .mockResolvedValueOnce({ status: 'skipped', reason: 'order_link_not_found', dealId: '1' })
        .mockResolvedValueOnce({ status: 'updated', dealId: '2' }),
    };

    const result = await execute(buildUseCase(handler), items);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      sent: 1,
      updated: 1,
      skipped: 2,
      failed: 0,
      created: 0,
    }));
    expect(result.skippedReasons).toEqual(
      expect.arrayContaining([
        { reason: 'no_deal_in_num_at_card', count: 1 },
        { reason: 'order_link_not_found', count: 1 },
      ])
    );
    expect(result.skippedReasons).toHaveLength(2);
  });

  it('aggregates repeated reasons into a single counted entry', async () => {
    const handler = {
      process: jest.fn().mockResolvedValue({ status: 'skipped', reason: 'no_deal_in_num_at_card' }),
    };

    const result = await execute(buildUseCase(handler), items);

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(3);
    expect(result.skippedReasons).toEqual([{ reason: 'no_deal_in_num_at_card', count: 3 }]);
  });

  // Un handler que devuelve 'skipped' sin motivo no debe romper el conteo ni
  // perder la fila: se agrupa bajo un código explícito.
  it('files a reasonless skip under unknown instead of dropping it', async () => {
    const handler = { process: jest.fn().mockResolvedValue({ status: 'skipped' }) };

    const result = await execute(buildUseCase(handler), [items[0]]);

    expect(result.skipped).toBe(1);
    expect(result.skippedReasons).toEqual([{ reason: 'unknown', count: 1 }]);
  });

  it('counts failures apart from skips and keeps their errors', async () => {
    const handler = {
      process: jest.fn()
        .mockResolvedValueOnce({ status: 'failed', dealId: '1', error: 'boom' })
        .mockResolvedValueOnce({ status: 'updated', dealId: '2' })
        .mockResolvedValueOnce({ status: 'skipped', reason: 'order_link_not_found' }),
    };

    const result = await execute(buildUseCase(handler), items);

    expect(result).toEqual(expect.objectContaining({
      sent: 1, updated: 1, failed: 1, skipped: 1,
    }));
    expect(result.errors).toHaveLength(1);
  });

  it('passes its logger down so the handler reasons reach the app log', async () => {
    const handler = { process: jest.fn().mockResolvedValue({ status: 'updated', dealId: '2' }) };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    await execute(buildUseCase(handler, { logger }), [items[0]]);

    expect(handler.process).toHaveBeenCalledWith(expect.objectContaining({ logger }));
  });
});
