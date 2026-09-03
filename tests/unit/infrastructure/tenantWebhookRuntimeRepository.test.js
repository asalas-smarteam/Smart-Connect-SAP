import { jest } from '@jest/globals';

// This test's only job is to lock the alignment between the Promise.all([...]) array
// and its positional destructuring in TenantWebhookRuntimeRepository.resolveRuntimeContext.
// A future edit that inserts a new getMappingsByObjectType(...) call without inserting the
// matching name at the same position in the destructured array (or vice versa) would not
// throw and would not log — it would just silently hand some mapping-service-backed context
// the wrong object type's mappings. Encoding the call args into the fake's return value turns
// that silent misalignment into a failing assertion here.
const mockGetMappingsByObjectType = jest.fn(
  (hubspotCredentialId, objectType, sourceContext) => Promise.resolve(`${objectType}/${sourceContext}`)
);

jest.unstable_mockModule('../../../src/infrastructure/database/repositories/mapping.service.js', () => ({
  default: {
    getMappingsByObjectType: mockGetMappingsByObjectType,
  },
}));

const { default: TenantWebhookRuntimeRepository } = await import(
  '../../../src/infrastructure/database/repositories/TenantWebhookRuntimeRepository.js'
);
const {
  BP_ADDRESS_OBJECT_TYPE,
  BP_ADDRESS_SOURCE_CONTEXT,
} = await import('../../../src/domain/business-partners/business-partner-creation.constants.js');

function createLeanQuery(value) {
  return {
    lean: jest.fn().mockResolvedValue(value),
    sort: jest.fn().mockReturnThis(),
  };
}

function buildTenantModels() {
  return {
    HubspotCredentials: {
      findOne: jest.fn().mockReturnValue(createLeanQuery({ _id: 'hubspot-credential-1', portalId: '12345' })),
    },
    SapCredentials: {
      findOne: jest.fn().mockReturnValue(createLeanQuery({ serviceLayerBaseUrl: 'https://sap.example.com:50000' })),
    },
    // No Configuration rows configured on purpose: taxCodes/miscPriceCalculationConfig/
    // requireDiscounts all fall back to their defaults, which this test doesn't assert on —
    // it only locks the mapping-service-backed names.
    Configuration: {
      findOne: jest.fn().mockReturnValue(createLeanQuery(null)),
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
    },
  };
}

describe('TenantWebhookRuntimeRepository.resolveRuntimeContext — Promise.all/destructuring alignment', () => {
  beforeEach(() => {
    mockGetMappingsByObjectType.mockClear();
  });

  it('routes each destructured mapping name to the getMappingsByObjectType call for its own objectType/sourceContext', async () => {
    const repository = new TenantWebhookRuntimeRepository();
    const tenantModels = buildTenantModels();

    const context = await repository.resolveRuntimeContext({
      tenantModels,
      payload: {},
      tenantId: 'tenant-1',
      tenantKey: 'tenant-key-1',
      portalId: '12345',
    });

    // One assertion per mapping-service-backed destructured name (12 of the 15 entries;
    // taxCodes/miscPriceCalculationConfig/requireDiscounts come from different calls and
    // are intentionally not asserted here). If a future edit shifts any one of these out of
    // position relative to its Promise.all call, the corresponding assertion fails because it
    // receives another entry's marker string instead of its own.
    expect(context.mappings.companyMappings).toBe('company/businessPartner');
    expect(context.mappings.contactBusinessPartnerMappings).toBe('contact/businessPartner');
    expect(context.mappings.contactEmployeeMappings).toBe('contact/contactEmployee');
    expect(context.mappings.addressMappings).toBe(`${BP_ADDRESS_OBJECT_TYPE}/${BP_ADDRESS_SOURCE_CONTEXT}`);
    expect(context.mappings.productMappings).toBe('product/product');
    expect(context.mappings.productOrdersQuotationsMappings).toBe('product/orders-quotations');
    expect(context.mappings.dealMappings).toBe('deal/businessPartner');
    expect(context.mappings.dealOrdersQuotationsMappings).toBe('deal/orders-quotations');
    expect(context.mappings.dealInventoryTransferRequestMappings).toBe('deal/inventory-transfer-request');
    expect(context.mappings.productInventoryTransferRequestMappings).toBe('product/inventory-transfer-request');
    expect(context.mappings.dealPurchaseQuotationsMappings).toBe('deal/purchase-quotations');
    expect(context.mappings.productPurchaseQuotationsMappings).toBe('product/purchase-quotations');

    // getMappingsByObjectType is called exactly once per mapping-service-backed name above —
    // if this count drifts, the Promise.all array and the destructuring list no longer have
    // the same length and every assertion past the drift point is suspect.
    expect(mockGetMappingsByObjectType).toHaveBeenCalledTimes(12);
  });
});
