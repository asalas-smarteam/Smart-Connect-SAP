import { jest } from '@jest/globals';
import ProcessHubspotWebhookEvent from '../../../src/application/use-cases/ProcessHubspotWebhookEvent.js';

// Covers the document-level AddressExtension on sales order creation (createDeal). The rest of
// the use case is covered by processHubspotWebhookEvent.test.js.

const legacyCreationConfig = {
  payloadStrategy: 'legacyWhitelist',
  contactEmployeeSource: 'dealContact',
  defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
  addresses: { strategy: 'none', byName: {}, required: [] },
};

function buildContext() {
  return {
    mappings: {
      companyMappings: [],
      contactBusinessPartnerMappings: [],
      contactEmployeeMappings: [],
      addressMappings: [],
      productMappings: [
        { sourceField: 'ItemCode', targetField: 'hs_sku' },
        { sourceField: 'Quantity', targetField: 'quantity' },
        { sourceField: 'UnitPrice', targetField: 'price' },
      ],
      productOrdersQuotationsMappings: [],
      dealMappings: [],
      dealOrdersQuotationsMappings: [],
    },
    sapConfig: { serviceLayerBaseUrl: 'https://sap.test' },
    hubspotCredentials: { _id: 'cred-1', clientConfigId: 'cfg-1' },
    taxCodes: [],
    miscPriceCalculationConfig: null,
    discountConfig: null,
  };
}

function buildDeps() {
  return {
    runtimeRepository: {
      resolveRuntimeContext: jest.fn().mockResolvedValue(buildContext()),
      resolveDefaultPriceListNum: jest.fn().mockResolvedValue(1),
      resolveRequireRandCardCode: jest.fn().mockResolvedValue(true),
      resolveDefaultSeries: jest.fn().mockResolvedValue(null),
      resolveDefaultFindSAP: jest.fn().mockResolvedValue('EmailAddress'),
      resolveGroupCodeDefaults: jest.fn().mockResolvedValue(null),
      resolveUpsertDataSap: jest.fn().mockResolvedValue({
        required: false,
        fieldsUpdated_BP: [],
        fieldsUpdated_CE: [],
      }),
      resolveBusinessPartnerCreationConfig: jest.fn().mockResolvedValue(legacyCreationConfig),
      resolvePropertiesFlagsConfig: jest.fn().mockResolvedValue({
        strategy: 'none',
        hubspotProperty: null,
        min: 1,
        max: 64,
        trueValue: 'tYES',
      }),
      findOwnerMappingByHubspotOwner: jest.fn().mockResolvedValue(null),
      resolveSapErrorBypassConfig: jest.fn().mockResolvedValue({ contactEmployee: false }),
      // Loaded on demand by createDeal, not part of resolveRuntimeContext.
      resolveAddressExtensionMappings: jest.fn().mockResolvedValue([]),
    },
    sapOrderAdapter: {
      findOrCreateBusinessPartner: jest.fn().mockResolvedValue({
        cardCode: 'CL00129',
        created: false,
        matchedBy: 'cardCode',
        businessPartner: { CardCode: 'CL00129' },
        requestPayload: null,
        responsePayload: null,
      }),
      addContactEmployeeIfNeeded: jest.fn(),
      addContactEmployeesIfNeeded: jest.fn().mockResolvedValue({
        created: false,
        internalCodes: [],
        results: [],
        requestPayload: null,
        responsePayload: null,
        updateResults: [],
      }),
      createOrder: jest.fn().mockResolvedValue({ DocEntry: 67890, DocNum: 9001 }),
    },
    hubspotWebhookAdapter: {
      getAccessToken: jest.fn().mockResolvedValue('token'),
      updateBusinessPartnerIds: jest.fn().mockResolvedValue({ company: { ok: true } }),
      updateAfterSap: jest.fn().mockResolvedValue({ deal: { ok: true } }),
      updateContactEmployeeCodes: jest.fn().mockResolvedValue([]),
    },
    webhookReferenceRepository: { persistReferences: jest.fn() },
    webhookEventProgressRepository: { markOrderCreated: jest.fn() },
    buildWebhookSyncErrorEntry: jest.fn((x) => x),
    buildErrorResponseSnapshot: jest.fn((e) => ({ message: e.message })),
    buildWebhookSapAudit: jest.fn((auditTrail) => ({ auditTrail })),
    logger: { info: jest.fn(), warn: jest.fn() },
  };
}

const tenantModels = { WebhookEvent: {} };

const addressExtensionMappings = [
  { sourceField: 'BillToStreet', targetField: 'billing_street' },
  { sourceField: 'ShipToStreet', targetField: 'shipping_street' },
  { sourceField: 'ShipToCountry', targetField: 'country' },
];

function buildEvent(addressExtension) {
  return {
    _id: 'event-1',
    eventType: 'createDeal',
    payload: {
      portalId: '50564010',
      deal: { hs_object_id: '59680314911' },
      company: { name: 'Acme', hs_object_id: 'company-1' },
      line_items: [{ hubspot_id: 'li-1', hs_sku: 'A01', quantity: '1', price: '10' }],
      ...(addressExtension === undefined ? {} : { addressExtension }),
    },
  };
}

describe('ProcessHubspotWebhookEvent — AddressExtension', () => {
  it('sends the mapped AddressExtension in the order header', async () => {
    const deps = buildDeps();
    deps.runtimeRepository.resolveAddressExtensionMappings.mockResolvedValue(addressExtensionMappings);
    const useCase = new ProcessHubspotWebhookEvent(deps);

    await useCase.execute({
      event: buildEvent({ billing_street: 'Calle 1', shipping_street: 'Calle 2', country: 'GT' }),
      tenantModels,
    });

    const { orderPayload } = deps.sapOrderAdapter.createOrder.mock.calls[0][0];
    expect(orderPayload.AddressExtension).toEqual({
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
    const useCase = new ProcessHubspotWebhookEvent(deps);

    await useCase.execute({ event: buildEvent(), tenantModels });

    const { orderPayload } = deps.sapOrderAdapter.createOrder.mock.calls[0][0];
    expect(orderPayload).not.toHaveProperty('AddressExtension');
    expect(deps.runtimeRepository.resolveAddressExtensionMappings).not.toHaveBeenCalled();
  });

  // Validated before the Business Partner step, so a malformed object never leaves an orphan
  // customer behind in SAP. It still goes through the use case's catch, so the failure keeps
  // its audit trail for diagnosis.
  it('rejects a malformed addressExtension before touching SAP, keeping the audit trail', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotWebhookEvent(deps);

    const error = await useCase
      .execute({ event: buildEvent([{ billing_street: 'Calle 1' }]), tenantModels })
      .catch((caught) => caught);

    expect(error).toMatchObject({ name: 'PermanentWebhookError', permanent: true });
    expect(error.message).toMatch(/addressExtension/);
    expect(error.syncLogWebhookErrors).toHaveLength(1);
    expect(deps.sapOrderAdapter.findOrCreateBusinessPartner).not.toHaveBeenCalled();
    expect(deps.sapOrderAdapter.createOrder).not.toHaveBeenCalled();
  });

  it('skips AddressExtension when the tenant has no mappings, even if the payload carries it', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotWebhookEvent(deps);

    await useCase.execute({ event: buildEvent({ billing_street: 'Calle 1' }), tenantModels });

    const { orderPayload } = deps.sapOrderAdapter.createOrder.mock.calls[0][0];
    expect(orderPayload).not.toHaveProperty('AddressExtension');
  });
});
