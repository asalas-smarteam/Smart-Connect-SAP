import { jest } from '@jest/globals';
import ProcessHubspotWebhookEvent from '../../../src/application/use-cases/ProcessHubspotWebhookEvent.js';

// Este use-case es el destino por defecto del dispatcher (el unico flujo que crea
// Sales Orders reales) y lleva su propia copia del bloque de cableado del
// BusinessPartner, duplicada a proposito con webhookQuotationSupport.js. Esta
// suite cubre solo ese bloque: creacion del BP, ContactEmployees y write-back.
// El resto del use-case (orden, lineas, owner) ya se cubre en otras suites.

const noopSyncError = {
  buildWebhookSyncErrorEntry: jest.fn((x) => x),
  buildErrorResponseSnapshot: jest.fn((e) => ({ message: e.message })),
  buildWebhookSapAudit: jest.fn((auditTrail) => ({ auditTrail })),
};

const legacyCreationConfig = {
  payloadStrategy: 'legacyWhitelist',
  contactEmployeeSource: 'dealContact',
  defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
  addresses: { strategy: 'none', byName: {}, required: [] },
};

const fullMappedPayloadArrayConfig = {
  payloadStrategy: 'fullMapped',
  contactEmployeeSource: 'payloadArray',
  defaults: { BusinessPartner: {}, ContactEmployee: { Active: 'tYES' }, BPAddress: { TaxCode: 'IVA' } },
  addresses: {
    strategy: 'payloadArray',
    byName: { factura: { AddressType: 'bo_BillTo' } },
    required: [],
  },
};

function buildContext(overrides = {}) {
  return {
    mappings: {
      companyMappings: [],
      contactBusinessPartnerMappings: [],
      contactEmployeeMappings: [
        { sourceField: 'Name', targetField: 'firstname', isActive: true },
      ],
      addressMappings: [
        { sourceField: 'AddressName', targetField: 'nombre_direccion', isActive: true },
        { sourceField: 'Street', targetField: 'calle', isActive: true },
      ],
      productMappings: [
        { sourceField: 'ItemCode', targetField: 'hs_sku' },
        { sourceField: 'Quantity', targetField: 'quantity' },
        { sourceField: 'UnitPrice', targetField: 'price' },
      ],
      productOrdersQuotationsMappings: [],
      dealMappings: [
        { sourceField: 'DocEntry', targetField: 'sap_docentry' },
        { sourceField: 'DocNum', targetField: 'sap_docnum' },
      ],
      dealOrdersQuotationsMappings: [],
    },
    sapConfig: { serviceLayerBaseUrl: 'https://sap.test' },
    hubspotCredentials: { _id: 'cred-1', clientConfigId: 'cfg-1' },
    taxCodes: [],
    miscPriceCalculationConfig: null,
    discountConfig: null,
    ...overrides,
  };
}

function buildDeps(context = buildContext()) {
  return {
    runtimeRepository: {
      resolveRuntimeContext: jest.fn().mockResolvedValue(context),
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
    ...noopSyncError,
    logger: { info: jest.fn(), warn: jest.fn() },
  };
}

const tenantModels = { WebhookEvent: {} };

function buildEvent(payloadOverrides = {}) {
  return {
    _id: 'event-1',
    eventType: 'createDeal',
    payload: {
      portalId: '50564010',
      deal: { hs_object_id: '59680314911' },
      company: { name: 'Acme', hs_object_id: 'company-1' },
      line_items: [
        { hubspot_id: 'li-1', hs_sku: 'A01', quantity: '1', price: '10' },
      ],
      ...payloadOverrides,
    },
  };
}

const dealContact = { hs_object_id: 'contact-deal', firstname: 'Juan' };

describe('ProcessHubspotWebhookEvent — cableado de la creacion del BusinessPartner', () => {
  it('crea la orden y pasa los inputs de la payload strategy a findOrCreateBusinessPartner', async () => {
    const deps = buildDeps();
    deps.runtimeRepository.resolveBusinessPartnerCreationConfig
      .mockResolvedValue(fullMappedPayloadArrayConfig);
    const useCase = new ProcessHubspotWebhookEvent(deps);

    const event = buildEvent({
      contact: dealContact,
      contactEmployees: [{ firstname: 'Ana' }],
      bpAddress: [{ nombre_direccion: 'factura', calle: 'Calle 1' }],
    });

    const result = await useCase.execute({ event, tenantModels, portalId: '50564010' });

    expect(deps.sapOrderAdapter.findOrCreateBusinessPartner).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadStrategy: expect.anything(),
        bpAddresses: [{ TaxCode: 'IVA', AddressType: 'bo_BillTo', AddressName: 'factura', Street: 'Calle 1' }],
        // Los CE salen del array del payload, no del contact del deal.
        mappedContactEmployees: [{ Active: 'tYES', Name: 'Ana' }],
        propertiesFlags: {},
        creationDefaults: fullMappedPayloadArrayConfig.defaults,
      })
    );
    expect(deps.sapOrderAdapter.createOrder).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ cardCode: 'CL00129', docEntry: 67890, docNum: 9001 });
  });

  it('usa el metodo plural addContactEmployeesIfNeeded, nunca el singular', async () => {
    const deps = buildDeps();
    deps.sapOrderAdapter.addContactEmployeesIfNeeded.mockResolvedValue({
      created: true,
      internalCodes: [{ contact: dealContact, internalCode: 'IC1' }],
      results: [],
      requestPayload: [],
      responsePayload: [],
      updateResults: [],
    });
    const useCase = new ProcessHubspotWebhookEvent(deps);

    await useCase.execute({ event: buildEvent({ contact: dealContact }), tenantModels });

    expect(deps.sapOrderAdapter.addContactEmployeesIfNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ cardCode: 'CL00129', contacts: [dealContact] })
    );
    expect(deps.sapOrderAdapter.addContactEmployeeIfNeeded).not.toHaveBeenCalled();
  });

  it('salta el PATCH de ContactEmployees cuando la strategy ya los mando en el POST de creacion', async () => {
    const deps = buildDeps();
    deps.runtimeRepository.resolveBusinessPartnerCreationConfig
      .mockResolvedValue(fullMappedPayloadArrayConfig);
    deps.sapOrderAdapter.findOrCreateBusinessPartner.mockResolvedValue({
      cardCode: 'CL00130',
      created: true,
      matchedBy: null,
      businessPartner: { CardCode: 'CL00130' },
      requestPayload: {},
      responsePayload: {},
    });
    const useCase = new ProcessHubspotWebhookEvent(deps);

    const event = buildEvent({ contact: dealContact, contactEmployees: [{ firstname: 'Ana' }] });
    await useCase.execute({ event, tenantModels });

    expect(deps.sapOrderAdapter.addContactEmployeesIfNeeded).not.toHaveBeenCalled();
    expect(deps.sapOrderAdapter.addContactEmployeeIfNeeded).not.toHaveBeenCalled();
  });

  it('escribe los internalCodes de vuelta con updateContactEmployeeCodes reusando el token ya resuelto', async () => {
    const deps = buildDeps();
    deps.runtimeRepository.resolveBusinessPartnerCreationConfig
      .mockResolvedValue(fullMappedPayloadArrayConfig);
    const internalCodes = [
      { contact: { hs_object_id: 'contact-ana' }, internalCode: 601 },
      { contact: { hs_object_id: 'contact-luis' }, internalCode: 602 },
    ];
    // created:false + matchedBy de busqueda + company sin idsap => se sincronizan
    // los ids del BP (y con eso se resuelve el token una primera vez), y ademas la
    // strategy fullMapped no mando los CE en el POST, asi que si hay PATCH de CE.
    deps.sapOrderAdapter.findOrCreateBusinessPartner.mockResolvedValue({
      cardCode: 'CL00129',
      created: false,
      matchedBy: 'EmailAddress',
      businessPartner: { CardCode: 'CL00129' },
      requestPayload: null,
      responsePayload: null,
    });
    deps.sapOrderAdapter.addContactEmployeesIfNeeded.mockResolvedValue({
      created: true,
      internalCodes,
      results: [],
      requestPayload: [],
      responsePayload: [],
      updateResults: [],
    });
    const useCase = new ProcessHubspotWebhookEvent(deps);

    const event = buildEvent({
      company: { name: 'Acme', hs_object_id: 'company-1', idsap: null },
      contact: dealContact,
      contactEmployees: [{ firstname: 'Ana' }, { firstname: 'Luis' }],
    });
    await useCase.execute({ event, tenantModels });

    expect(deps.hubspotWebhookAdapter.updateContactEmployeeCodes).toHaveBeenCalledWith({
      token: 'token',
      internalCodes,
    });
    expect(deps.hubspotWebhookAdapter.getAccessToken).toHaveBeenCalledTimes(1);
  });
});

describe('ProcessHubspotWebhookEvent — internalcode al contact del deal', () => {
  // GUARDIA DE NO-REGRESION: con la config por defecto el contact del deal SI es
  // el ContactEmployee real, y su internalcode tiene que seguir viajando por la
  // via legacy de updateAfterSap y quedando en el snapshot del WebhookEvent.
  it('modo dealContact: le escribe su propio internalcode', async () => {
    const deps = buildDeps();
    deps.sapOrderAdapter.addContactEmployeesIfNeeded.mockResolvedValue({
      created: true,
      internalCodes: [{ contact: dealContact, internalCode: 501 }],
      results: [],
      requestPayload: [],
      responsePayload: [],
      updateResults: [],
    });
    const useCase = new ProcessHubspotWebhookEvent(deps);

    await useCase.execute({ event: buildEvent({ contact: dealContact }), tenantModels });

    expect(deps.hubspotWebhookAdapter.updateAfterSap).toHaveBeenCalledWith(
      expect.objectContaining({ syncContact: true, contactEmployeeCode: 501 })
    );
    expect(deps.webhookReferenceRepository.persistReferences).toHaveBeenCalledWith(
      expect.objectContaining({
        contactEmployeeCode: 501,
        dealContactIsContactEmployee: true,
      })
    );
  });

  // EL BUG DEL REVIEW: con payloadArray, internalCodes[0] es de Ana. Escribirselo
  // al contact del deal le pone el codigo SAP de un tercero y pisa la escritura
  // correcta que updateContactEmployeeCodes acaba de hacer contacto por contacto.
  it('modo payloadArray: NO le escribe el internalcode de otro ContactEmployee', async () => {
    const deps = buildDeps();
    deps.runtimeRepository.resolveBusinessPartnerCreationConfig
      .mockResolvedValue(fullMappedPayloadArrayConfig);
    const internalCodes = [
      { contact: { hs_object_id: 'contact-ana' }, internalCode: 601 },
      { contact: { hs_object_id: 'contact-luis' }, internalCode: 602 },
    ];
    deps.sapOrderAdapter.addContactEmployeesIfNeeded.mockResolvedValue({
      created: true,
      internalCodes,
      results: [],
      requestPayload: [],
      responsePayload: [],
      updateResults: [],
    });
    const useCase = new ProcessHubspotWebhookEvent(deps);

    const event = buildEvent({
      contact: dealContact,
      contactEmployees: [{ firstname: 'Ana' }, { firstname: 'Luis' }],
    });
    await useCase.execute({ event, tenantModels });

    const [updateAfterSapArgs] = deps.hubspotWebhookAdapter.updateAfterSap.mock.calls[0];
    expect(updateAfterSapArgs.contactEmployeeCode).toBeUndefined();

    expect(deps.webhookReferenceRepository.persistReferences).toHaveBeenCalledWith(
      expect.objectContaining({ dealContactIsContactEmployee: false })
    );

    // Lo que si tiene que pasar: cada CE real recibe SU propio codigo.
    expect(deps.hubspotWebhookAdapter.updateContactEmployeeCodes).toHaveBeenCalledWith(
      expect.objectContaining({ internalCodes })
    );
  });
});
