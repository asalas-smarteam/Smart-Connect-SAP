import { jest } from '@jest/globals';
import ProcessHubspotPurchaseQuotation from '../../../src/application/use-cases/ProcessHubspotPurchaseQuotation.js';

// Covers the document-level AddressExtension on purchase quotation creation. The rest of the use
// case is covered by processPurchaseQuotation.test.js.

function buildDeps() {
  return {
    runtimeRepository: {
      resolveRuntimeContext: jest.fn().mockResolvedValue({
        mappings: {
          dealMappings: [],
          dealPurchaseQuotationsMappings: [{ sourceField: 'CardCode', targetField: 'proveedor_sap' }],
          productPurchaseQuotationsMappings: [
            { sourceField: 'ItemCode', targetField: 'hs_sku' },
            { sourceField: 'Quantity', targetField: 'quantity' },
          ],
        },
        sapConfig: { serviceLayerBaseUrl: 'https://sap.test' },
        hubspotCredentials: { _id: 'cred-1', clientConfigId: 'cfg-1' },
      }),
      findOwnerMappingByHubspotOwner: jest.fn().mockResolvedValue(null),
      resolvePurchaseQuotationDefaults: jest.fn().mockResolvedValue({}),
      // Loaded on demand, not part of resolveRuntimeContext.
      resolveAddressExtensionMappings: jest.fn().mockResolvedValue([]),
    },
    sapPurchaseQuotationAdapter: {
      createPurchaseQuotation: jest.fn().mockResolvedValue({
        DocEntry: 12345,
        DocNum: 8001,
        DocumentLines: [{ LineNum: 0 }],
      }),
    },
    hubspotWebhookAdapter: {
      updateAfterSap: jest.fn().mockResolvedValue({ deal: { ok: true } }),
    },
    sapDocumentLinkRepository: {
      findByDeal: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    buildWebhookSyncErrorEntry: jest.fn((x) => x),
    buildErrorResponseSnapshot: jest.fn((e) => ({ message: e.message })),
    buildWebhookSapAudit: jest.fn((auditTrail) => ({ auditTrail })),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

const tenantModels = { WebhookEvent: {}, SapDocumentLink: {} };

const addressExtensionMappings = [
  { sourceField: 'BillToStreet', targetField: 'billing_street' },
  { sourceField: 'ShipToStreet', targetField: 'shipping_street' },
  { sourceField: 'ShipToCountry', targetField: 'country' },
];

function buildEvent(addressExtension) {
  return {
    _id: 'event-1',
    eventType: 'purchaseQuotation',
    payload: {
      portalId: '50082681',
      deal: { hs_object_id: '59680314911', proveedor_sap: 'PR000123' },
      line_items: [{ hubspot_id: 'li-1', hs_sku: 'A01', quantity: '3' }],
      ...(addressExtension === undefined ? {} : { addressExtension }),
    },
  };
}

describe('ProcessHubspotPurchaseQuotation — AddressExtension', () => {
  it('sends the mapped AddressExtension in the purchase quotation header', async () => {
    const deps = buildDeps();
    deps.runtimeRepository.resolveAddressExtensionMappings.mockResolvedValue(addressExtensionMappings);
    const useCase = new ProcessHubspotPurchaseQuotation(deps);

    await useCase.execute({
      event: buildEvent({ billing_street: 'Calle 1', shipping_street: 'Calle 2', country: 'GT' }),
      tenantModels,
    });

    const { purchaseQuotationPayload } = deps.sapPurchaseQuotationAdapter
      .createPurchaseQuotation.mock.calls[0][0];
    expect(purchaseQuotationPayload.AddressExtension).toEqual({
      BillToStreet: 'Calle 1',
      ShipToStreet: 'Calle 2',
      ShipToCountry: 'GT',
    });
    expect(deps.runtimeRepository.resolveAddressExtensionMappings).toHaveBeenCalledWith({
      tenantModels,
      hubspotCredentialId: 'cred-1',
    });
  });

  // The query is the cost other tenants must not pay: no object in the payload, no read.
  it('skips AddressExtension and does not query the mappings when the workflow sends no object', async () => {
    const deps = buildDeps();
    deps.runtimeRepository.resolveAddressExtensionMappings.mockResolvedValue(addressExtensionMappings);
    const useCase = new ProcessHubspotPurchaseQuotation(deps);

    await useCase.execute({ event: buildEvent(), tenantModels });

    const { purchaseQuotationPayload } = deps.sapPurchaseQuotationAdapter
      .createPurchaseQuotation.mock.calls[0][0];
    expect(purchaseQuotationPayload).not.toHaveProperty('AddressExtension');
    expect(deps.runtimeRepository.resolveAddressExtensionMappings).not.toHaveBeenCalled();
  });

  // It still goes through the use case's catch, so the failure keeps its audit trail.
  it('rejects a malformed addressExtension before touching SAP, keeping the audit trail', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotPurchaseQuotation(deps);

    const error = await useCase
      .execute({ event: buildEvent([{ billing_street: 'Calle 1' }]), tenantModels })
      .catch((caught) => caught);

    expect(error).toMatchObject({ name: 'PermanentWebhookError', permanent: true });
    expect(error.message).toMatch(/addressExtension/);
    expect(error.syncLogWebhookErrors).toHaveLength(1);
    expect(deps.sapPurchaseQuotationAdapter.createPurchaseQuotation).not.toHaveBeenCalled();
  });

  it('skips AddressExtension when the tenant has no mappings, even if the payload carries it', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotPurchaseQuotation(deps);

    await useCase.execute({ event: buildEvent({ billing_street: 'Calle 1' }), tenantModels });

    const { purchaseQuotationPayload } = deps.sapPurchaseQuotationAdapter
      .createPurchaseQuotation.mock.calls[0][0];
    expect(purchaseQuotationPayload).not.toHaveProperty('AddressExtension');
  });
});
