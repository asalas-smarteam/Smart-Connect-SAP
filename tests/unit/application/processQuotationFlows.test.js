import { jest } from '@jest/globals';
import ProcessHubspotCreateQuotation from '../../../src/application/use-cases/ProcessHubspotCreateQuotation.js';
import ProcessHubspotUpdateQuotation from '../../../src/application/use-cases/ProcessHubspotUpdateQuotation.js';
import ProcessHubspotConvertQuotationToOrder from '../../../src/application/use-cases/ProcessHubspotConvertQuotationToOrder.js';

const noopSyncError = {
  buildWebhookSyncErrorEntry: jest.fn((x) => x),
  buildErrorResponseSnapshot: jest.fn((e) => ({ message: e.message })),
  buildWebhookSapAudit: jest.fn((auditTrail) => ({ auditTrail })),
};

function buildContext(overrides = {}) {
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
    ...overrides,
  };
}

function buildRuntimeRepository(context = buildContext()) {
  return {
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
    // Task 10 wiring: resolved unconditionally by resolveBusinessPartnerForDocument, alongside
    // resolveUpsertDataSap above. Not exercised by this suite's assertions, so plain defaults.
    resolveBusinessPartnerCreationConfig: jest.fn().mockResolvedValue({
      payloadStrategy: 'legacyWhitelist',
      contactEmployeeSource: 'dealContact',
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      addresses: { strategy: 'none', byName: {}, required: [] },
    }),
    resolvePropertiesFlagsConfig: jest.fn().mockResolvedValue({
      strategy: 'none',
      hubspotProperty: null,
      min: 1,
      max: 64,
      trueValue: 'tYES',
    }),
    findOwnerMappingByHubspotOwner: jest.fn().mockResolvedValue(null),
    resolveSapErrorBypassConfig: jest.fn().mockResolvedValue({ contactEmployee: false }),
  };
}

const baseEvent = {
  _id: 'event-1',
  eventType: 'createQuotation',
  payload: {
    portalId: '50564010',
    deal: { hs_object_id: '59680314911' },
    company: { name: 'Acme', hs_object_id: 'c1' },
    line_items: [
      { hubspot_id: 'li-1', hs_sku: 'A01', quantity: '1', price: '10', warehouses: 'B03' },
    ],
  },
};

const tenantModels = { WebhookEvent: {}, SapDocumentLink: {} };

describe('ProcessHubspotCreateQuotation', () => {
  function buildDeps() {
    return {
      runtimeRepository: buildRuntimeRepository(),
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
        addContactEmployeesIfNeeded: jest.fn(),
      },
      sapQuotationAdapter: {
        createQuotation: jest.fn().mockResolvedValue({
          DocEntry: 12345,
          DocNum: 8001,
          DocumentLines: [{ LineNum: 0 }],
        }),
      },
      hubspotWebhookAdapter: {
        getAccessToken: jest.fn().mockResolvedValue('token'),
        updateBusinessPartnerIds: jest.fn(),
        updateAfterSap: jest.fn().mockResolvedValue({ deal: { ok: true } }),
        // Task 11: write-back of SAP InternalCode to every real ContactEmployee contact.
        updateContactEmployeeCodes: jest.fn().mockResolvedValue([]),
      },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      sapDocumentLinkRepository: {
        findByDeal: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        updateLines: jest.fn(),
      },
      ...noopSyncError,
      logger: { info: jest.fn(), warn: jest.fn() },
    };
  }

  it('creates a quotation, persists the SAP document link and updates the deal', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const result = await useCase.execute({
      event: baseEvent,
      tenantModels,
      tenantId: 't1',
      tenantKey: 'k1',
      portalId: '50564010',
    });

    expect(deps.sapQuotationAdapter.createQuotation).toHaveBeenCalledTimes(1);
    const linkArg = deps.sapDocumentLinkRepository.create.mock.calls[0][0].link;
    expect(linkArg).toMatchObject({
      dealId: '59680314911',
      documentType: 'quotation',
      sapObject: 'Quotations',
      sapDocEntry: 12345,
      sapDocNum: 8001,
      sapBaseType: 23,
    });
    expect(linkArg.lines[0]).toMatchObject({ hubspotLineItemId: 'li-1', sapLineNum: 0 });
    expect(deps.hubspotWebhookAdapter.updateAfterSap).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      cardCode: 'CL00129',
      docEntry: 12345,
      docNum: 8001,
      dealId: '59680314911',
    });
    expect(result.sapAudit.auditTrail.payload_SAP.quotation).toMatchObject({ CardCode: 'CL00129' });
    expect(result.sapAudit.auditTrail.response_SAP.quotation).toEqual({
      DocEntry: 12345,
      DocNum: 8001,
      DocumentLines: [{ LineNum: 0 }],
    });
  });

  // ItemDescription editable desde el line item de HubSpot. Va SOLO en DocumentLines: el
  // contexto product/orders-quotations nunca derrama en la cabecera del documento.
  it('manda ItemDescription en DocumentLines desde el mapeo product/orders-quotations', async () => {
    const context = buildContext();
    context.mappings.productOrdersQuotationsMappings = [
      { sourceField: 'ItemDescription', targetField: 'item_description' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const event = {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        line_items: [
          {
            hubspot_id: 'li-1',
            hs_sku: 'A01',
            quantity: '2',
            price: '850',
            warehouses: '01',
            item_description: 'Laptop HP 15in - Config especial Distelsa',
          },
        ],
      },
    };

    await useCase.execute({ event, tenantModels });

    const { quotationPayload } = deps.sapQuotationAdapter.createQuotation.mock.calls[0][0];
    expect(quotationPayload.DocumentLines[0]).toEqual({
      ItemDescription: 'Laptop HP 15in - Config especial Distelsa',
      ItemCode: 'A01',
      Quantity: 2,
      UnitPrice: 850,
      WarehouseCode: '01',
    });
    expect(quotationPayload).not.toHaveProperty('ItemDescription');
  });

  it('omite ItemDescription cuando el line item no trae la propiedad', async () => {
    const context = buildContext();
    context.mappings.productOrdersQuotationsMappings = [
      { sourceField: 'ItemDescription', targetField: 'item_description' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    const useCase = new ProcessHubspotCreateQuotation(deps);

    await useCase.execute({ event: baseEvent, tenantModels });

    const { quotationPayload } = deps.sapQuotationAdapter.createQuotation.mock.calls[0][0];
    expect(quotationPayload.DocumentLines[0]).not.toHaveProperty('ItemDescription');
  });

  it('sends PaymentGroupCode from the orders-quotations deal mapping', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = [
      { sourceField: 'PaymentGroupCode', targetField: 'paymentGroupCode' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const event = {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        deal: { hs_object_id: '59680314911', paymentGroupCode: '3' },
      },
    };

    await useCase.execute({ event, tenantModels });

    const { quotationPayload } = deps.sapQuotationAdapter.createQuotation.mock.calls[0][0];
    expect(quotationPayload.PaymentGroupCode).toBe(3);
    expect(deps.runtimeRepository.resolveGroupCodeDefaults).toHaveBeenCalled();
  });

  it('sends mapped deal header fields like CardName and skips them when the deal has no value', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = [
      { sourceField: 'CardName', targetField: 'cardName' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const event = {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        deal: { hs_object_id: '59680314911', cardName: 'Maleny Benavides' },
      },
    };

    await useCase.execute({ event, tenantModels });

    const { quotationPayload } = deps.sapQuotationAdapter.createQuotation.mock.calls[0][0];
    expect(quotationPayload.CardName).toBe('Maleny Benavides');
    expect(quotationPayload.CardCode).toBe('CL00129');

    // Same mapping but the deal arrives without cardName: the field must be omitted.
    const depsWithoutValue = buildDeps();
    depsWithoutValue.runtimeRepository = buildRuntimeRepository(context);
    const useCaseWithoutValue = new ProcessHubspotCreateQuotation(depsWithoutValue);

    await useCaseWithoutValue.execute({ event: baseEvent, tenantModels });

    const secondPayload = depsWithoutValue.sapQuotationAdapter.createQuotation.mock.calls[0][0]
      .quotationPayload;
    expect(secondPayload).not.toHaveProperty('CardName');
  });

  it('falls back to the groupCodeDefauls config when the deal has no paymentGroupCode', async () => {
    const deps = buildDeps();
    deps.runtimeRepository.resolveGroupCodeDefaults.mockResolvedValue({
      PayTermsGrpCode: 2,
      PaymentGroupCode: 2,
    });
    const useCase = new ProcessHubspotCreateQuotation(deps);

    await useCase.execute({ event: baseEvent, tenantModels });

    const { quotationPayload } = deps.sapQuotationAdapter.createQuotation.mock.calls[0][0];
    expect(quotationPayload.PaymentGroupCode).toBe(2);
  });

  it('omits PaymentGroupCode when neither mapping nor config default provides a value', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotCreateQuotation(deps);

    await useCase.execute({ event: baseEvent, tenantModels });

    const { quotationPayload } = deps.sapQuotationAdapter.createQuotation.mock.calls[0][0];
    expect(quotationPayload).not.toHaveProperty('PaymentGroupCode');
  });

  it('toma el Comments de la cotizacion del FieldMapping', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = [
      { sourceField: 'Comments', targetField: 'comments' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const event = {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        deal: { hs_object_id: '59680314911', comments: 'Comentario para el comprador y prueba' },
      },
    };

    await useCase.execute({ event, tenantModels });

    const { quotationPayload } = deps.sapQuotationAdapter.createQuotation.mock.calls[0][0];
    expect(quotationPayload.Comments).toBe('Comentario para el comprador y prueba');
  });

  // Sin la fila de FieldMapping no viaja, aunque la propiedad venga en el payload: el codigo
  // ya no tiene una puerta trasera que lea deal.comments por su nombre.
  it('no manda Comments cuando no hay mapeo, aunque el payload lo traiga', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const event = {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        deal: { hs_object_id: '59680314911', comments: 'Este comentario no deberia viajar' },
      },
    };

    await useCase.execute({ event, tenantModels });

    const { quotationPayload } = deps.sapQuotationAdapter.createQuotation.mock.calls[0][0];
    expect(quotationPayload).not.toHaveProperty('Comments');
  });

  it('is idempotent: skips creation when a quotation link already exists', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal.mockResolvedValue({
      cardCode: 'CL00129',
      sapDocEntry: 12345,
      sapDocNum: 8001,
    });
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const result = await useCase.execute({ event: baseEvent, tenantModels });

    expect(deps.sapQuotationAdapter.createQuotation).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      cardCode: 'CL00129',
      docEntry: 12345,
      docNum: 8001,
      dealId: '59680314911',
    });
  });

  // El atajo de idempotencia no manda NADA a SAP, asi que no hay trafico que auditar y el
  // sapAudit quedaba en null -- indistinguible de "la auditoria esta rota", que es justo la
  // confusion que se dio en produccion: 13 eventos completados con sapAudit null porque las
  // cotizaciones ya existian de una corrida anterior. El documento tiene que decirlo.
  it('is idempotent: deja constancia en sapAudit de que no se mando nada a SAP', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal.mockResolvedValue({
      cardCode: 'CL00129',
      sapDocEntry: 12345,
      sapDocNum: 8001,
    });
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const result = await useCase.execute({ event: baseEvent, tenantModels });

    expect(result.sapAudit.auditTrail.skipped).toEqual({
      reason: 'quotation_already_exists',
      sapDocEntry: 12345,
      sapDocNum: 8001,
    });
  });

  it('attaches sapAudit with the attempted quotation payload when SAP creation fails', async () => {
    const deps = buildDeps();
    const sapError = new Error('Request failed with status code 400');
    sapError.response = {
      data: {
        error: {
          code: -5002,
          message: { lang: 'en-us', value: 'To generate this document, first define the numbering series' },
        },
      },
    };
    deps.sapQuotationAdapter.createQuotation.mockRejectedValue(sapError);
    const useCase = new ProcessHubspotCreateQuotation(deps);

    await expect(useCase.execute({ event: baseEvent, tenantModels })).rejects.toBe(sapError);

    expect(sapError.sapAudit.auditTrail.payload_SAP.quotation).toMatchObject({ CardCode: 'CL00129' });
    expect(sapError.sapAudit.auditTrail.response_SAP.quotation).toBeNull();
  });

  it('forwards the full BusinessPartner payload-strategy inputs and PATCHes ContactEmployees via the plural adapter method when the BP already existed', async () => {
    const deps = buildDeps();
    deps.runtimeRepository.resolveBusinessPartnerCreationConfig.mockResolvedValue({
      payloadStrategy: 'fullMapped',
      contactEmployeeSource: 'dealContact',
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      addresses: { strategy: 'none', byName: {}, required: [] },
    });
    deps.sapOrderAdapter.addContactEmployeesIfNeeded.mockResolvedValue({
      created: true,
      internalCodes: [{ contact: { hs_object_id: 'contact-1' }, internalCode: 'IC1' }],
      results: [],
      requestPayload: [],
      responsePayload: [],
      updateResults: [],
    });
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const event = {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        contact: { hs_object_id: 'contact-1', firstname: 'Juan' },
      },
    };

    await useCase.execute({ event, tenantModels });

    expect(deps.sapOrderAdapter.findOrCreateBusinessPartner).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadStrategy: expect.anything(),
        bpAddresses: expect.anything(),
        mappedContactEmployees: expect.anything(),
        propertiesFlags: expect.anything(),
      })
    );
    expect(deps.sapOrderAdapter.addContactEmployeesIfNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ contacts: [event.payload.contact] })
    );
    expect(deps.sapOrderAdapter.addContactEmployeeIfNeeded).not.toHaveBeenCalled();
    // Task 11: the write-back must actually receive the internalCodes array that
    // addContactEmployeesIfNeeded resolved with, not just have the mock shape available.
    expect(deps.hubspotWebhookAdapter.updateContactEmployeeCodes).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'token',
        internalCodes: [{ contact: { hs_object_id: 'contact-1' }, internalCode: 'IC1' }],
      })
    );
  });

  it('reuses the already-resolved HubSpot token instead of calling getAccessToken again to write back ContactEmployee codes', async () => {
    const deps = buildDeps();
    deps.sapOrderAdapter.findOrCreateBusinessPartner.mockResolvedValue({
      cardCode: 'CL00129',
      created: true,
      matchedBy: null,
      businessPartner: { CardCode: 'CL00129' },
      requestPayload: null,
      responsePayload: null,
    });
    deps.sapOrderAdapter.addContactEmployeesIfNeeded.mockResolvedValue({
      created: true,
      internalCodes: [{ contact: { hs_object_id: 'contact-1' }, internalCode: 'IC1' }],
      results: [],
      requestPayload: [],
      responsePayload: [],
      updateResults: [],
    });
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const event = {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        contact: { hs_object_id: 'contact-1', firstname: 'Juan' },
      },
    };

    await useCase.execute({ event, tenantModels });

    // businessPartnerResult.created === true makes shouldSyncBusinessPartnerIds true, so
    // getAccessToken is already called once for updateBusinessPartnerIds; the write-back
    // block must reuse that resolved token instead of calling getAccessToken a second time.
    expect(deps.hubspotWebhookAdapter.getAccessToken).toHaveBeenCalledTimes(1);
    expect(deps.hubspotWebhookAdapter.updateContactEmployeeCodes).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'token' })
    );
  });

  it('skips the ContactEmployee PATCH when the fullMapped strategy already included them in the create payload', async () => {
    const deps = buildDeps();
    deps.runtimeRepository.resolveBusinessPartnerCreationConfig.mockResolvedValue({
      payloadStrategy: 'fullMapped',
      contactEmployeeSource: 'dealContact',
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      addresses: { strategy: 'none', byName: {}, required: [] },
    });
    deps.sapOrderAdapter.findOrCreateBusinessPartner.mockResolvedValue({
      cardCode: 'CL00130',
      created: true,
      matchedBy: null,
      businessPartner: { CardCode: 'CL00130' },
      requestPayload: {},
      responsePayload: {},
    });
    const useCase = new ProcessHubspotCreateQuotation(deps);

    const event = {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        contact: { hs_object_id: 'contact-1', firstname: 'Juan' },
      },
    };

    await useCase.execute({ event, tenantModels });

    expect(deps.sapOrderAdapter.addContactEmployeesIfNeeded).not.toHaveBeenCalled();
    expect(deps.sapOrderAdapter.addContactEmployeeIfNeeded).not.toHaveBeenCalled();
  });

  // El write-back legacy de internalcode le escribe al contact del deal, asi que
  // solo puede dispararse en modo dealContact, donde ese contact ES el CE real.
  describe('internalcode al contact del deal', () => {
    function buildDepsWithContactEmployees(internalCodes) {
      const deps = buildDeps();
      deps.sapOrderAdapter.addContactEmployeesIfNeeded.mockResolvedValue({
        created: true,
        internalCodes,
        results: [],
        requestPayload: [],
        responsePayload: [],
        updateResults: [],
      });
      return deps;
    }

    const eventWithContact = {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        contact: { hs_object_id: 'contact-1', firstname: 'Juan' },
      },
    };

    it('dealContact: le escribe su propio internalcode (conducta historica)', async () => {
      const deps = buildDepsWithContactEmployees([
        { contact: eventWithContact.payload.contact, internalCode: 501 },
      ]);
      const useCase = new ProcessHubspotCreateQuotation(deps);

      await useCase.execute({ event: eventWithContact, tenantModels });

      expect(deps.hubspotWebhookAdapter.updateAfterSap).toHaveBeenCalledWith(
        expect.objectContaining({ contactEmployeeCode: 501 })
      );
    });

    it('payloadArray: no le escribe el internalcode de otro ContactEmployee', async () => {
      const deps = buildDepsWithContactEmployees([
        { contact: { hs_object_id: 'contact-ana' }, internalCode: 601 },
      ]);
      deps.runtimeRepository.resolveBusinessPartnerCreationConfig.mockResolvedValue({
        payloadStrategy: 'legacyWhitelist',
        contactEmployeeSource: 'payloadArray',
        defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
        addresses: { strategy: 'none', byName: {}, required: [] },
      });
      const useCase = new ProcessHubspotCreateQuotation(deps);

      await useCase.execute({
        event: {
          ...eventWithContact,
          payload: { ...eventWithContact.payload, contactEmployees: [{ firstname: 'Ana' }] },
        },
        tenantModels,
      });

      const [args] = deps.hubspotWebhookAdapter.updateAfterSap.mock.calls[0];
      expect(args.contactEmployeeCode).toBeUndefined();
      expect(deps.hubspotWebhookAdapter.updateContactEmployeeCodes).toHaveBeenCalledWith(
        expect.objectContaining({
          internalCodes: [{ contact: { hs_object_id: 'contact-ana' }, internalCode: 601 }],
        })
      );
    });
  });
});

describe('ProcessHubspotUpdateQuotation', () => {
  const updateEvent = {
    _id: 'event-2',
    eventType: 'updateQuotation',
    payload: {
      portalId: '50564010',
      deal: { hs_object_id: '59680314911', hubspot_owner_id: '82534997' },
      line_items: [
        { hubspot_id: 'li-1', hs_sku: 'A01', quantity: '2', price: '17.5' },
      ],
    },
  };

  function buildDeps() {
    const runtimeRepository = buildRuntimeRepository();
    runtimeRepository.findOwnerMappingByHubspotOwner.mockResolvedValue({ sapOwnerId: 61 });
    return {
      runtimeRepository,
      sapQuotationAdapter: {
        // El GET tiene que imitar la forma que devuelve el Service Layer, no una minima: de aca
        // salen el estado del documento, los LineNum con los que se numeran las altas y las
        // lineas con las que se reconstruye link.lines. Un mock incompleto esconde esa costura.
        getQuotation: jest.fn().mockResolvedValue({
          DocEntry: 12345,
          DocumentStatus: 'bost_Open',
          DocumentLines: [
            { LineNum: 0, ItemCode: 'A01', Quantity: 1, UnitPrice: 10, WarehouseCode: '01', LineStatus: 'bost_Open' },
          ],
        }),
        updateQuotation: jest.fn().mockResolvedValue({ updated: true }),
      },
      sapDocumentLinkRepository: {
        findByDeal: jest.fn().mockResolvedValue({
          _id: 'link-1',
          cardCode: 'CL00129',
          sapDocEntry: 12345,
          sapDocNum: 8001,
          lines: [{ hubspotLineItemId: 'li-1', sapLineNum: 0, quantity: 1, unitPrice: 10 }],
        }),
        updateLines: jest.fn(),
      },
      ...noopSyncError,
      logger: { info: jest.fn(), warn: jest.fn() },
    };
  }

  it('patches existing quotation lines and refreshes the stored link lines', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    const result = await useCase.execute({ event: updateEvent, tenantModels });

    expect(deps.sapQuotationAdapter.getQuotation).toHaveBeenCalledWith({
      sapConfig: expect.any(Object),
      docEntry: 12345,
    });
    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    expect(patch.DocumentLines).toEqual([{ LineNum: 0, UnitPrice: 17.5, Quantity: 2 }]);
    expect(patch.SalesPersonCode).toBe(61);
    expect(deps.sapDocumentLinkRepository.updateLines).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ docEntry: 12345, docNum: 8001, dealId: '59680314911' });
  });

  // Sin el header, una linea que el asesor quito en HubSpot (y que por lo tanto no viaja en
  // DocumentLines) se queda viva en SAP: el PATCH normal conserva las filas que no vienen.
  it('manda el PATCH con reemplazo de coleccion', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    await useCase.execute({ event: updateEvent, tenantModels });

    expect(deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].replaceCollections).toBe(true);
  });

  it('deja fuera del PATCH la linea que ningun line item del evento reclama', async () => {
    const deps = buildDeps();
    deps.sapQuotationAdapter.getQuotation.mockResolvedValue({
      DocEntry: 12345,
      DocumentStatus: 'bost_Open',
      DocumentLines: [
        { LineNum: 0, ItemCode: 'A01', Quantity: 1, UnitPrice: 10, LineStatus: 'bost_Open' },
        { LineNum: 1, ItemCode: 'A02', Quantity: 1, UnitPrice: 10, LineStatus: 'bost_Open' },
      ],
    });
    deps.sapDocumentLinkRepository.findByDeal.mockResolvedValue({
      _id: 'link-1',
      cardCode: 'CL00129',
      sapDocEntry: 12345,
      sapDocNum: 8001,
      lines: [
        { hubspotLineItemId: 'li-1', sku: 'A01', sapLineNum: 0, quantity: 1, unitPrice: 10 },
        { hubspotLineItemId: 'li-2', sku: 'A02', sapLineNum: 1, quantity: 1, unitPrice: 10 },
      ],
    });
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    // El evento solo trae li-1: li-2 se borro en HubSpot.
    await useCase.execute({ event: updateEvent, tenantModels });

    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    expect(patch.DocumentLines).toEqual([{ LineNum: 0, UnitPrice: 17.5, Quantity: 2 }]);
    expect(patch.DocumentLines.map((line) => line.LineNum)).not.toContain(1);
  });

  it('agrega la linea nueva numerada desde los LineNum que devolvio SAP', async () => {
    const deps = buildDeps();
    deps.sapQuotationAdapter.getQuotation.mockResolvedValue({
      DocEntry: 12345,
      DocumentStatus: 'bost_Open',
      DocumentLines: [
        { LineNum: 0, ItemCode: 'A01', Quantity: 1, UnitPrice: 10, LineStatus: 'bost_Open' },
        { LineNum: 3, ItemCode: 'A04', Quantity: 1, UnitPrice: 10, LineStatus: 'bost_Open' },
      ],
    });
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    const event = {
      ...updateEvent,
      payload: {
        ...updateEvent.payload,
        line_items: [
          ...updateEvent.payload.line_items,
          { hubspot_id: 'li-nuevo', hs_sku: 'A99', quantity: '4', price: '3' },
        ],
      },
    };

    await useCase.execute({ event, tenantModels });

    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    // 4 = max(0, 3) + 1. Con `length` habria salido 2 y habria pisado una fila viva.
    expect(patch.DocumentLines).toEqual([
      { LineNum: 0, UnitPrice: 17.5, Quantity: 2 },
      { LineNum: 4, ItemCode: 'A99', Quantity: 4, UnitPrice: 3 },
    ]);
  });

  // El PATCH responde 204 sin cuerpo, asi que los LineNum de las altas no vuelven por ninguna otra
  // via, y las bajas hay que sacarlas del link para que la conversion a orden no las arrastre.
  it('reconstruye link.lines desde el GET posterior al PATCH, no mutando el array anterior', async () => {
    const deps = buildDeps();
    const openLine = (lineNum, itemCode) => ({
      LineNum: lineNum,
      ItemCode: itemCode,
      Quantity: 2,
      UnitPrice: 17.5,
      WarehouseCode: '01',
      LineStatus: 'bost_Open',
    });
    deps.sapQuotationAdapter.getQuotation
      .mockResolvedValueOnce({
        DocEntry: 12345,
        DocumentStatus: 'bost_Open',
        DocumentLines: [openLine(0, 'A01'), openLine(1, 'A02')],
      })
      // Despues del PATCH: A02 se elimino y quedo un hueco con LineNum 4.
      .mockResolvedValueOnce({
        DocEntry: 12345,
        DocumentStatus: 'bost_Open',
        DocumentLines: [openLine(0, 'A01'), openLine(4, 'A99')],
      });
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    const event = {
      ...updateEvent,
      payload: {
        ...updateEvent.payload,
        line_items: [
          ...updateEvent.payload.line_items,
          { hubspot_id: 'li-nuevo', hs_product_id: 'prod-99', hs_sku: 'A99', quantity: '2', price: '17.5' },
        ],
      },
    };

    await useCase.execute({ event, tenantModels });

    expect(deps.sapQuotationAdapter.getQuotation).toHaveBeenCalledTimes(2);
    expect(deps.sapDocumentLinkRepository.updateLines).toHaveBeenCalledWith({
      SapDocumentLink: expect.anything(),
      id: 'link-1',
      lines: [
        {
          hubspotLineItemId: 'li-1',
          hubspotProductId: null,
          sku: 'A01',
          sapLineNum: 0,
          quantity: 2,
          unitPrice: 17.5,
          warehouseCode: '01',
        },
        {
          hubspotLineItemId: 'li-nuevo',
          hubspotProductId: 'prod-99',
          sku: 'A99',
          sapLineNum: 4,
          quantity: 2,
          unitPrice: 17.5,
          warehouseCode: '01',
        },
      ],
    });
  });

  it('falla visible cuando la oferta ya no esta abierta, sin intentar el PATCH', async () => {
    const deps = buildDeps();
    deps.sapQuotationAdapter.getQuotation.mockResolvedValue({
      DocEntry: 12345,
      DocumentStatus: 'bost_Close',
      DocumentLines: [{ LineNum: 0, ItemCode: 'A01', LineStatus: 'bost_Close' }],
    });
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    await expect(useCase.execute({ event: updateEvent, tenantModels })).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining('bost_Close'),
    });
    expect(deps.sapQuotationAdapter.updateQuotation).not.toHaveBeenCalled();
  });

  it('falla visible cuando una linea ya alimento otro documento', async () => {
    const deps = buildDeps();
    deps.sapQuotationAdapter.getQuotation.mockResolvedValue({
      DocEntry: 12345,
      DocumentStatus: 'bost_Open',
      DocumentLines: [
        { LineNum: 0, ItemCode: 'A01', LineStatus: 'bost_Open' },
        { LineNum: 1, ItemCode: 'A02', LineStatus: 'bost_Close' },
      ],
    });
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    await expect(useCase.execute({ event: updateEvent, tenantModels })).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining('line 1'),
    });
    expect(deps.sapQuotationAdapter.updateQuotation).not.toHaveBeenCalled();
  });

  // No todas las versiones del Service Layer devuelven LineStatus; fallar por su ausencia
  // bloquearia ofertas perfectamente abiertas.
  it('no toma una oferta sin DocumentStatus ni LineStatus como cerrada', async () => {
    const deps = buildDeps();
    deps.sapQuotationAdapter.getQuotation.mockResolvedValue({
      DocEntry: 12345,
      DocumentLines: [{ LineNum: 0, ItemCode: 'A01', Quantity: 1, UnitPrice: 10 }],
    });
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    await expect(useCase.execute({ event: updateEvent, tenantModels })).resolves.toMatchObject({
      docEntry: 12345,
    });
  });

  // El campo de linea editable tiene que seguir al documento YA creado, no solo aterrizar al
  // crearlo: es el punto que faltaba para que la edicion en HubSpot llegue a SAP.
  it('manda ItemDescription en las lineas del PATCH', async () => {
    const context = buildContext();
    context.mappings.productOrdersQuotationsMappings = [
      { sourceField: 'ItemDescription', targetField: 'item_description' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository.resolveRuntimeContext.mockResolvedValue(context);
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    const event = {
      ...updateEvent,
      payload: {
        ...updateEvent.payload,
        line_items: [
          {
            hubspot_id: 'li-1',
            hs_sku: 'A01',
            quantity: '2',
            price: '17.5',
            item_description: 'Descripcion corregida en HubSpot',
          },
        ],
      },
    };

    await useCase.execute({ event, tenantModels });

    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    expect(patch.DocumentLines).toEqual([
      {
        ItemDescription: 'Descripcion corregida en HubSpot',
        LineNum: 0,
        UnitPrice: 17.5,
        Quantity: 2,
      },
    ]);
    expect(patch).not.toHaveProperty('ItemDescription');
  });

  it('no manda ItemDescription en el PATCH cuando el evento no trae la propiedad', async () => {
    const context = buildContext();
    context.mappings.productOrdersQuotationsMappings = [
      { sourceField: 'ItemDescription', targetField: 'item_description' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository.resolveRuntimeContext.mockResolvedValue(context);
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    await useCase.execute({ event: updateEvent, tenantModels });

    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    expect(patch.DocumentLines[0]).not.toHaveProperty('ItemDescription');
  });

  // El PATCH solo lleva lo que el workflow mando en ESTE evento. Editar lineas en HubSpot no
  // debe pisar la cabecera que un usuario haya corregido a mano en SAP.
  it('no manda ningun campo de cabecera cuando el payload no los trae', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = [
      { sourceField: 'Comments', targetField: 'comments' },
      { sourceField: 'NumAtCard', targetField: 'orden_de_compra' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository.resolveRuntimeContext.mockResolvedValue(context);
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    const result = await useCase.execute({ event: updateEvent, tenantModels });

    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    expect(patch).not.toHaveProperty('Comments');
    expect(patch).not.toHaveProperty('NumAtCard');
    expect(patch).toHaveProperty('DocumentLines');
    expect(result.sapAudit.auditTrail.payload_SAP.quotation).not.toHaveProperty('Comments');
  });

  it('manda los campos de cabecera que vienen mapeados y presentes en el payload', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = [
      { sourceField: 'Comments', targetField: 'comments' },
      { sourceField: 'NumAtCard', targetField: 'orden_de_compra' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository.resolveRuntimeContext.mockResolvedValue(context);
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    const event = {
      ...updateEvent,
      payload: {
        ...updateEvent.payload,
        deal: {
          ...updateEvent.payload.deal,
          comments: 'Comentario para el comprador y prueba',
          orden_de_compra: 'OC #P06485',
        },
      },
    };

    await useCase.execute({ event, tenantModels });

    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    expect(patch.Comments).toBe('Comentario para el comprador y prueba');
    expect(patch.NumAtCard).toBe('OC #P06485');
  });

  // pickMappedHeaderFields protege los campos que el PATCH posee, igual que en los builders.
  it('no deja que un mapeo pise CardCode ni DocumentLines en el PATCH', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = [
      { sourceField: 'CardCode', targetField: 'card_code' },
      { sourceField: 'DocumentLines', targetField: 'lineas' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository.resolveRuntimeContext.mockResolvedValue(context);
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    const event = {
      ...updateEvent,
      payload: {
        ...updateEvent.payload,
        deal: { ...updateEvent.payload.deal, card_code: 'HACKED', lineas: 'basura' },
      },
    };

    await useCase.execute({ event, tenantModels });

    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    expect(patch).not.toHaveProperty('CardCode');
    expect(patch.DocumentLines).not.toBe('basura');
    expect(Array.isArray(patch.DocumentLines)).toBe(true);
  });

  // dealOrdersQuotationsMappings es una sola lista compartida por creacion, conversion y este
  // PATCH. Series/DocNum/DocDate/TaxDate/DocType/DocEntry identifican o fechan un documento que
  // en este flujo YA existe en SAP: mandarlos arriesga que Service Layer rechace el PATCH
  // completo, con lo que la sincronizacion de lineas tampoco aterriza. La creacion SI debe
  // llevarlos (ver quotationBuilder.test.js), por eso la exclusion vive solo aca.
  it('no manda Series ni DocDate en el PATCH aunque esten mapeados y presentes en el payload', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = [
      { sourceField: 'Series', targetField: 'serie' },
      { sourceField: 'DocDate', targetField: 'fecha_documento' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository.resolveRuntimeContext.mockResolvedValue(context);
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    const event = {
      ...updateEvent,
      payload: {
        ...updateEvent.payload,
        deal: { ...updateEvent.payload.deal, serie: '240', fecha_documento: '2026-08-01' },
      },
    };

    await useCase.execute({ event, tenantModels });

    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    expect(patch).not.toHaveProperty('Series');
    expect(patch).not.toHaveProperty('DocDate');
    expect(patch).toHaveProperty('DocumentLines');
  });

  // buildQuotationLineUpdates emite una entrada por line item del EVENTO que hizo match, no por
  // linea del documento en SAP. Con una oferta de 5 lineas donde el evento solo edita 1,
  // lineUpdates.length es 1: si el ancla usara eso, el texto se reancla detras de la linea 0 en
  // cada edicion en vez de quedarse detras de la ultima (linea 4), y SAP lo acepta sin error.
  it('ancla DocumentSpecialLines segun las lineas del documento en SAP, no las editadas en el evento', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = [
      { sourceField: 'DocumentSpecialLines', targetField: 'texto_gobierno' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository.resolveRuntimeContext.mockResolvedValue(context);
    // La cuenta sale del GET a SAP, no de link.lines: cuando el link quedo desincronizado por los
    // descuadres de este flujo, link.lines miente y el ancla cae en el lugar equivocado. El mock
    // tiene las mismas 5 lineas que el link para que el test asierte lo que dice su nombre.
    deps.sapQuotationAdapter.getQuotation.mockResolvedValue({
      DocEntry: 12345,
      DocumentStatus: 'bost_Open',
      DocumentLines: [0, 1, 2, 3, 4].map((lineNum) => ({
        LineNum: lineNum,
        ItemCode: `A0${lineNum + 1}`,
        Quantity: 1,
        UnitPrice: 10,
        LineStatus: 'bost_Open',
      })),
    });
    deps.sapDocumentLinkRepository.findByDeal.mockResolvedValue({
      _id: 'link-1',
      cardCode: 'CL00129',
      sapDocEntry: 12345,
      sapDocNum: 8001,
      lines: [
        { hubspotLineItemId: 'li-1', sapLineNum: 0, quantity: 1, unitPrice: 10 },
        { hubspotLineItemId: 'li-2', sapLineNum: 1, quantity: 1, unitPrice: 10 },
        { hubspotLineItemId: 'li-3', sapLineNum: 2, quantity: 1, unitPrice: 10 },
        { hubspotLineItemId: 'li-4', sapLineNum: 3, quantity: 1, unitPrice: 10 },
        { hubspotLineItemId: 'li-5', sapLineNum: 4, quantity: 1, unitPrice: 10 },
      ],
    });
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    const event = {
      ...updateEvent,
      payload: {
        ...updateEvent.payload,
        deal: { ...updateEvent.payload.deal, texto_gobierno: 'O.C: 111931' },
      },
    };

    await useCase.execute({ event, tenantModels });

    const patch = deps.sapQuotationAdapter.updateQuotation.mock.calls[0][0].patchPayload;
    expect(patch.DocumentLines).toHaveLength(1);
    expect(patch.DocumentSpecialLines).toEqual([
      { LineType: 'dslt_Text', AfterLineNumber: 4, LineText: 'O.C: 111931' },
    ]);
  });

  it('fails in a controlled way when there is no quotation link for the deal', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal.mockResolvedValue(null);
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    await expect(useCase.execute({ event: updateEvent, tenantModels })).rejects.toMatchObject({
      permanent: true,
    });
    expect(deps.sapQuotationAdapter.updateQuotation).not.toHaveBeenCalled();
  });

  it('attaches sapAudit with the attempted patch payload when SAP update fails', async () => {
    const deps = buildDeps();
    const sapError = new Error('SAP update failed');
    deps.sapQuotationAdapter.updateQuotation.mockRejectedValue(sapError);
    const useCase = new ProcessHubspotUpdateQuotation(deps);

    await expect(useCase.execute({ event: updateEvent, tenantModels })).rejects.toBe(sapError);

    expect(sapError.sapAudit.auditTrail.payload_SAP.quotation).toMatchObject({
      DocumentLines: [{ LineNum: 0, UnitPrice: 17.5, Quantity: 2 }],
    });
  });
});

describe('ProcessHubspotConvertQuotationToOrder', () => {
  const convertEvent = {
    _id: 'event-3',
    eventType: 'convertQuotationToOrder',
    payload: {
      portalId: '50564010',
      deal: { hs_object_id: '59680314911' },
    },
  };

  function buildDeps() {
    return {
      runtimeRepository: buildRuntimeRepository(),
      sapOrderAdapter: {
        createOrder: jest.fn().mockResolvedValue({ DocEntry: 67890, DocNum: 9001 }),
      },
      hubspotWebhookAdapter: {
        updateAfterSap: jest.fn().mockResolvedValue({ deal: { ok: true } }),
      },
      sapDocumentLinkRepository: {
        findByDeal: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
      },
      ...noopSyncError,
      logger: { info: jest.fn(), warn: jest.fn() },
    };
  }

  it('creates an order from the quotation using BaseType/BaseEntry/BaseLine', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal
      .mockResolvedValueOnce({
        cardCode: 'CL00129',
        sapDocEntry: 12345,
        sapDocNum: 8001,
        lines: [{ sapLineNum: 0 }, { sapLineNum: 1 }],
      })
      .mockResolvedValueOnce(null);
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    const result = await useCase.execute({ event: convertEvent, tenantModels });

    const orderPayload = deps.sapOrderAdapter.createOrder.mock.calls[0][0].orderPayload;
    expect(orderPayload.DocumentLines).toEqual([
      { BaseType: 23, BaseEntry: 12345, BaseLine: 0 },
      { BaseType: 23, BaseEntry: 12345, BaseLine: 1 },
    ]);
    const linkArg = deps.sapDocumentLinkRepository.create.mock.calls[0][0].link;
    expect(linkArg).toMatchObject({
      documentType: 'order',
      sapDocEntry: 67890,
      baseDocument: { documentType: 'quotation', sapDocEntry: 12345, sapBaseType: 23 },
    });
    expect(result).toMatchObject({
      cardCode: 'CL00129',
      docEntry: 67890,
      docNum: 9001,
      dealId: '59680314911',
    });
    expect(result.sapAudit.auditTrail.payload_SAP.order).toBe(orderPayload);
    expect(result.sapAudit.auditTrail.response_SAP.order).toEqual({ DocEntry: 67890, DocNum: 9001 });
  });

  // Caso real del cliente (portal 49373530): al convertir la oferta, el asesor corrige centro de
  // costo, departamento y subdepartamento de cada elemento de pedido. El workflow manda la
  // coleccion como `lineItems` y el id del line item como `hs_object_id`.
  //
  // Los line items llegan en orden inverso al de las lineas de la oferta a proposito: el match es
  // por identificador contra link.lines, no por posicion.
  it('aplica los campos mapeados de los elementos de pedido sobre su linea base', async () => {
    const context = buildContext();
    context.mappings.productOrdersQuotationsMappings = [
      { sourceField: 'U_Marca', targetField: 'centro_de_costo_marca' },
      { sourceField: 'U_Departamento', targetField: 'departamento' },
      { sourceField: 'U_SubDepartamento', targetField: 'sub_departamento' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository.resolveRuntimeContext.mockResolvedValue(context);
    deps.sapDocumentLinkRepository.findByDeal
      .mockResolvedValueOnce({
        cardCode: 'CL00129',
        sapDocEntry: 12345,
        sapDocNum: 8001,
        lines: [
          { hubspotLineItemId: '58786797171', sapLineNum: 0 },
          { hubspotLineItemId: '58786797172', sapLineNum: 1 },
        ],
      })
      .mockResolvedValueOnce(null);
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    const event = {
      ...convertEvent,
      payload: {
        ...convertEvent.payload,
        lineItems: [
          {
            hs_object_id: '58786797172',
            centro_de_costo_marca: 'CCM-0001',
            departamento: 'CCD-0004',
            sub_departamento: 'CCS-0001',
          },
          {
            hs_object_id: '58786797171',
            centro_de_costo_marca: 'CCM-0002',
            departamento: 'CCD-0009',
            // Vacia a proposito: una propiedad sin valor no produce clave, asi que SAP conserva
            // lo que la oferta ya traia en U_SubDepartamento para esa linea.
            sub_departamento: '',
          },
        ],
      },
    };

    await useCase.execute({ event, tenantModels });

    const orderPayload = deps.sapOrderAdapter.createOrder.mock.calls[0][0].orderPayload;
    expect(orderPayload.DocumentLines).toEqual([
      {
        BaseType: 23,
        BaseEntry: 12345,
        BaseLine: 0,
        U_Marca: 'CCM-0002',
        U_Departamento: 'CCD-0009',
      },
      {
        BaseType: 23,
        BaseEntry: 12345,
        BaseLine: 1,
        U_Marca: 'CCM-0001',
        U_Departamento: 'CCD-0004',
        U_SubDepartamento: 'CCS-0001',
      },
    ]);
  });

  it('tambien acepta line_items con hubspot_id, la grafia de los otros webhooks', async () => {
    const context = buildContext();
    context.mappings.productOrdersQuotationsMappings = [
      { sourceField: 'U_Departamento', targetField: 'departamento' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository.resolveRuntimeContext.mockResolvedValue(context);
    deps.sapDocumentLinkRepository.findByDeal
      .mockResolvedValueOnce({
        cardCode: 'CL00129',
        sapDocEntry: 12345,
        lines: [{ hubspotLineItemId: 'li-1', sapLineNum: 0 }],
      })
      .mockResolvedValueOnce(null);
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    const event = {
      ...convertEvent,
      payload: {
        ...convertEvent.payload,
        line_items: [{ hubspot_id: 'li-1', departamento: 'CCD-0004' }],
      },
    };

    await useCase.execute({ event, tenantModels });

    expect(deps.sapOrderAdapter.createOrder.mock.calls[0][0].orderPayload.DocumentLines).toEqual([
      { BaseType: 23, BaseEntry: 12345, BaseLine: 0, U_Departamento: 'CCD-0004' },
    ]);
  });

  // La linea base tiene que viajar igual: omitirla dejaria la orden sin ese renglon. Se avisa
  // con warn porque la causa es de configuracion (el workflow manda un line item que no existe
  // en la oferta que la integracion creo), no un error de SAP.
  it('ignora con warn el elemento de pedido que no empata con ninguna linea guardada', async () => {
    const context = buildContext();
    context.mappings.productOrdersQuotationsMappings = [
      { sourceField: 'U_Departamento', targetField: 'departamento' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository.resolveRuntimeContext.mockResolvedValue(context);
    deps.sapDocumentLinkRepository.findByDeal
      .mockResolvedValueOnce({
        cardCode: 'CL00129',
        sapDocEntry: 12345,
        lines: [{ hubspotLineItemId: 'li-1', sapLineNum: 0 }],
      })
      .mockResolvedValueOnce(null);
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    const event = {
      ...convertEvent,
      payload: {
        ...convertEvent.payload,
        lineItems: [{ hs_object_id: 'no-esta-en-la-oferta', departamento: 'CCD-0004' }],
      },
    };

    await useCase.execute({ event, tenantModels });

    expect(deps.sapOrderAdapter.createOrder.mock.calls[0][0].orderPayload.DocumentLines).toEqual([
      { BaseType: 23, BaseEntry: 12345, BaseLine: 0 },
    ]);
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  // Sin pickMappedLineFields, un mapeo hacia BaseLine reescribiria el renglon de la oferta al que
  // apunta la linea, y SAP lo aceptaria sin error: la orden saldria copiando el articulo
  // equivocado.
  it('no deja que un mapeo de linea pise BaseLine ni ItemCode', async () => {
    const context = buildContext();
    context.mappings.productOrdersQuotationsMappings = [
      { sourceField: 'BaseLine', targetField: 'departamento' },
      { sourceField: 'ItemCode', targetField: 'centro_de_costo_marca' },
      { sourceField: 'U_Departamento', targetField: 'departamento' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository.resolveRuntimeContext.mockResolvedValue(context);
    deps.sapDocumentLinkRepository.findByDeal
      .mockResolvedValueOnce({
        cardCode: 'CL00129',
        sapDocEntry: 12345,
        lines: [{ hubspotLineItemId: 'li-1', sapLineNum: 0 }],
      })
      .mockResolvedValueOnce(null);
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    const event = {
      ...convertEvent,
      payload: {
        ...convertEvent.payload,
        lineItems: [{ hs_object_id: 'li-1', departamento: '7', centro_de_costo_marca: 'CCM-0001' }],
      },
    };

    await useCase.execute({ event, tenantModels });

    expect(deps.sapOrderAdapter.createOrder.mock.calls[0][0].orderPayload.DocumentLines).toEqual([
      { BaseType: 23, BaseEntry: 12345, BaseLine: 0, U_Departamento: '7' },
    ]);
  });

  it('is idempotent: skips when an order link already exists', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal
      .mockResolvedValueOnce({ cardCode: 'CL00129', sapDocEntry: 12345, lines: [{ sapLineNum: 0 }] })
      .mockResolvedValueOnce({ cardCode: 'CL00129', sapDocEntry: 67890, sapDocNum: 9001 });
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    const result = await useCase.execute({ event: convertEvent, tenantModels });

    expect(deps.sapOrderAdapter.createOrder).not.toHaveBeenCalled();
    expect(result).toMatchObject({ docEntry: 67890, docNum: 9001 });
    expect(result.sapAudit.auditTrail.skipped).toEqual({
      reason: 'order_already_exists',
      sapDocEntry: 67890,
      sapDocNum: 9001,
    });
  });

  it('fails when there is no quotation to convert', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal.mockResolvedValue(null);
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    await expect(useCase.execute({ event: convertEvent, tenantModels })).rejects.toMatchObject({
      permanent: true,
    });
    expect(deps.sapOrderAdapter.createOrder).not.toHaveBeenCalled();
  });

  it('attaches sapAudit with the attempted order payload when SAP order creation fails', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal
      .mockResolvedValueOnce({
        cardCode: 'CL00129',
        sapDocEntry: 12345,
        sapDocNum: 8001,
        lines: [{ sapLineNum: 0 }],
      })
      .mockResolvedValueOnce(null);
    const sapError = new Error('SAP order create failed');
    deps.sapOrderAdapter.createOrder.mockRejectedValue(sapError);
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    await expect(useCase.execute({ event: convertEvent, tenantModels })).rejects.toBe(sapError);

    expect(sapError.sapAudit.auditTrail.payload_SAP.order).toMatchObject({
      DocumentLines: [{ BaseType: 23, BaseEntry: 12345, BaseLine: 0 }],
    });
  });

  // El bug reportado por el cliente: la orden llevaba un literal del integrador en Comments
  // y un HS-DEAL-<dealId> fabricado en NumAtCard.
  it('no manda un Comments default ni un NumAtCard fabricado', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal
      .mockResolvedValueOnce({
        cardCode: 'CL00129',
        sapDocEntry: 12345,
        sapDocNum: 8001,
        lines: [{ sapLineNum: 0 }],
      })
      .mockResolvedValueOnce(null);
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    await useCase.execute({ event: convertEvent, tenantModels });

    const { orderPayload } = deps.sapOrderAdapter.createOrder.mock.calls[0][0];
    expect(orderPayload).not.toHaveProperty('Comments');
    expect(orderPayload).not.toHaveProperty('NumAtCard');
  });

  it('toma Comments y NumAtCard del FieldMapping del contexto orders-quotations', async () => {
    const context = buildContext();
    context.mappings.dealOrdersQuotationsMappings = [
      { sourceField: 'Comments', targetField: 'comments' },
      { sourceField: 'NumAtCard', targetField: 'orden_de_compra' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    deps.sapDocumentLinkRepository.findByDeal
      .mockResolvedValueOnce({
        cardCode: 'CL00129',
        sapDocEntry: 12345,
        sapDocNum: 8001,
        lines: [{ sapLineNum: 0 }],
      })
      .mockResolvedValueOnce(null);
    const useCase = new ProcessHubspotConvertQuotationToOrder(deps);

    const event = {
      ...convertEvent,
      payload: {
        ...convertEvent.payload,
        deal: {
          hs_object_id: '59680314911',
          comments: 'Comentario real del comprador',
          orden_de_compra: 'OC #P06485',
        },
      },
    };

    await useCase.execute({ event, tenantModels });

    const { orderPayload } = deps.sapOrderAdapter.createOrder.mock.calls[0][0];
    expect(orderPayload.Comments).toBe('Comentario real del comprador');
    expect(orderPayload.NumAtCard).toBe('OC #P06485');
  });
});

// Task 7: cableado del trío de S/4 (createSalesDocumentStrategy) en ProcessHubspotCreateQuotation.
// No hay `buildRuntimeRepositoryStub`/`buildQuotationEvent` en este archivo -- se reusan los
// helpers reales de arriba (buildRuntimeRepository/buildContext/baseEvent), extendiendo el
// contexto con sapFlavor via el parametro overrides que buildContext ya soporta.
// Los cuatro campos de cabecera que S/4 exige en toda oferta. El caso de uso los valida ANTES
// de resolver al cliente, asi que un tenant de S/4 sin ellos ya no llega al alta.
const S4_SALES_DOCUMENT_CONFIG = {
  quotationType: 'AGN',
  salesOrganization: 'CFG_ORG',
  distributionChannel: 'CFG_CH',
  division: 'CFG_DIV',
  salesPersonPartnerFunction: null,
  priceConditionType: null,
};

describe('ProcessHubspotCreateQuotation con sapFlavor S4', () => {
  it('usa el trío de S/4 y persiste el número de oferta como DocEntry y DocNum', async () => {
    const createQuotation = jest.fn().mockResolvedValue({
      DocEntry: 20000123,
      DocNum: 20000123,
      DocumentLines: [{ LineNum: 10 }],
      raw: { SalesQuotation: '20000123' },
    });
    const buildQuotationPayloadMock = jest.fn().mockReturnValue({ SoldToParty: '100053', to_Item: [] });
    const findOrCreateForDocument = jest.fn().mockResolvedValue({
      cardCode: '100053',
      businessPartnerResult: { created: false, matchedBy: 'BusinessPartner' },
      contactEmployeeResult: { created: false, internalCodes: [] },
      contactEmployeeFailures: [],
      hubspotToken: 'token-1',
      dealContactIsContactEmployee: false,
    });
    const create = jest.fn().mockResolvedValue({});

    const useCase = new ProcessHubspotCreateQuotation({
      runtimeRepository: buildRuntimeRepository(buildContext({ sapFlavor: 'S4' })),
      sapOrderAdapter: {},
      sapQuotationAdapter: {},
      hubspotWebhookAdapter: { updateAfterSap: jest.fn().mockResolvedValue({}) },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      sapDocumentLinkRepository: { findByDeal: jest.fn().mockResolvedValue(null), create },
      salesDocumentConfigRepository: { getSalesDocumentConfig: async () => S4_SALES_DOCUMENT_CONFIG },
      salesDocumentStrategyFactory: () => ({
        documentBusinessPartnerResolver: { findOrCreateForDocument },
        salesDocumentBuilder: { buildQuotationPayload: buildQuotationPayloadMock },
        salesDocumentAdapter: { createQuotation },
      }),
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
      buildWebhookSapAudit: jest.fn().mockReturnValue({}),
      logger: { warn: jest.fn(), info: jest.fn() },
    });

    const result = await useCase.execute({ event: baseEvent, tenantModels });

    expect(createQuotation).toHaveBeenCalled();
    expect(result.docEntry).toBe(20000123);
    expect(result.docNum).toBe(20000123);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      link: expect.objectContaining({
        sapObject: 'A_SalesQuotation',
        sapBaseType: null,
        sapDocEntry: 20000123,
      }),
    }));
  });

  // Fix round 1 (hallazgo 2): la version anterior de este test solo comprobaba que la factory
  // fue llamada con cierto sabor, sin asserter nada de la CONDUCTA de B1 -- un `objectContaining`
  // no hubiera detectado que a las deps les faltara alguna clave. Ahora se comprueba que el
  // builder recibe documentLines no vacias (las arma mapDocumentLines, exclusivo de B1) y que lo
  // persistido lleva el vocabulario de B1 (sapObject/sapBaseType).
  it('un tenant sin sapFlavor sigue por el camino de B1', async () => {
    const createQuotation = jest.fn().mockResolvedValue({
      DocEntry: 55,
      DocNum: 900,
      DocumentLines: [{ LineNum: 0 }],
    });
    const buildQuotationPayloadMock = jest.fn().mockReturnValue({ CardCode: 'CL001' });
    const create = jest.fn().mockResolvedValue({});
    const strategyFactory = jest.fn().mockReturnValue({
      documentBusinessPartnerResolver: {
        findOrCreateForDocument: jest.fn().mockResolvedValue({
          cardCode: 'CL001',
          businessPartnerResult: { created: false, matchedBy: 'cardCode' },
          contactEmployeeResult: { created: false, internalCodes: [] },
          contactEmployeeFailures: [],
          hubspotToken: null,
          dealContactIsContactEmployee: false,
        }),
      },
      salesDocumentBuilder: { buildQuotationPayload: buildQuotationPayloadMock },
      salesDocumentAdapter: { createQuotation },
    });

    const useCase = new ProcessHubspotCreateQuotation({
      runtimeRepository: buildRuntimeRepository(buildContext({ sapFlavor: undefined })),
      sapOrderAdapter: {},
      sapQuotationAdapter: {},
      hubspotWebhookAdapter: { updateAfterSap: jest.fn().mockResolvedValue({}) },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      sapDocumentLinkRepository: { findByDeal: jest.fn().mockResolvedValue(null), create },
      salesDocumentStrategyFactory: strategyFactory,
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
      buildWebhookSapAudit: jest.fn().mockReturnValue({}),
      logger: { warn: jest.fn(), info: jest.fn() },
    });

    await useCase.execute({ event: baseEvent, tenantModels });

    // documentLines las arma mapDocumentLines (exclusivo de B1) a partir del unico line_item de
    // baseEvent (hs_sku A01, quantity 1, price 10, warehouses B03) -- si esto llegara vacio,
    // significaria que el use case tomo el camino de S/4 (documentLines forzado a []) para un
    // tenant sin sapFlavor.
    const builderArgs = buildQuotationPayloadMock.mock.calls[0][0];
    expect(builderArgs.documentLines.length).toBeGreaterThan(0);
    expect(builderArgs.documentLines[0]).toMatchObject({
      ItemCode: 'A01',
      Quantity: 1,
      WarehouseCode: 'B03',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      link: expect.objectContaining({
        sapObject: 'Quotations',
        sapBaseType: 23,
        sapDocEntry: 55,
        sapDocNum: 900,
      }),
    }));
    expect(strategyFactory).toHaveBeenCalledWith(expect.objectContaining({ sapFlavor: undefined }));
  });

  // Fix round 1 (hallazgo 1): el requisito mas delicado de la tarea -- el area de ventas
  // resuelta ANTES de la resolucion del cliente, con la precedencia mapeo-del-negocio > default
  // de configuracion -- no tenia ningun test. Un refactor que invirtiera el orden de esas dos
  // lineas pasaba toda la suite en verde.
  it('resuelve salesArea con la precedencia del mapeo sobre el default de configuración, antes de resolver el cliente', async () => {
    const baseContext = buildContext({ sapFlavor: 'S4' });
    const context = {
      ...baseContext,
      mappings: {
        ...baseContext.mappings,
        // Solo SalesOrganization esta mapeado desde el deal; DistributionChannel y
        // OrganizationDivision no tienen mapeo, asi que tienen que salir del default de
        // configuracion.
        dealOrdersQuotationsMappings: [
          { sourceField: 'SalesOrganization', targetField: 'sales_org' },
        ],
      },
    };
    const getSalesDocumentConfig = jest.fn().mockResolvedValue(S4_SALES_DOCUMENT_CONFIG);
    const findOrCreateForDocument = jest.fn().mockResolvedValue({
      cardCode: '100053',
      businessPartnerResult: { created: false, matchedBy: 'BusinessPartner' },
      contactEmployeeResult: { created: false, internalCodes: [] },
      contactEmployeeFailures: [],
      hubspotToken: null,
      dealContactIsContactEmployee: false,
    });

    const useCase = new ProcessHubspotCreateQuotation({
      runtimeRepository: buildRuntimeRepository(context),
      sapOrderAdapter: {},
      sapQuotationAdapter: {},
      hubspotWebhookAdapter: { updateAfterSap: jest.fn().mockResolvedValue({}) },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      sapDocumentLinkRepository: { findByDeal: jest.fn().mockResolvedValue(null), create: jest.fn() },
      salesDocumentConfigRepository: { getSalesDocumentConfig },
      salesDocumentStrategyFactory: () => ({
        documentBusinessPartnerResolver: { findOrCreateForDocument },
        salesDocumentBuilder: { buildQuotationPayload: jest.fn().mockReturnValue({ SoldToParty: '100053', to_Item: [] }) },
        salesDocumentAdapter: { createQuotation: jest.fn().mockResolvedValue({ DocEntry: 1, DocNum: 1, DocumentLines: [] }) },
      }),
      buildWebhookSyncErrorEntry: jest.fn(),
      buildErrorResponseSnapshot: jest.fn(),
      buildWebhookSapAudit: jest.fn().mockReturnValue({}),
      logger: { warn: jest.fn(), info: jest.fn() },
    });

    const event = {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        deal: { hs_object_id: '59680314911', sales_org: 'DEAL_ORG' },
      },
    };

    await useCase.execute({ event, tenantModels });

    expect(findOrCreateForDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        salesArea: {
          salesOrganization: 'DEAL_ORG',
          distributionChannel: 'CFG_CH',
          division: 'CFG_DIV',
        },
      })
    );
    // Orden: la config de documento de venta se lee ANTES de llamar al resolver de cliente --
    // invertir esas dos lineas dejaria al cliente nuevo registrado en un area de ventas distinta
    // de la del documento, y SAP rechazaria la oferta. invocationCallOrder da un numero global de
    // secuencia por invocacion de mock, comparable entre mocks distintos.
    expect(getSalesDocumentConfig.mock.invocationCallOrder[0])
      .toBeLessThan(findOrCreateForDocument.mock.invocationCallOrder[0]);
  });

  // Fix final: el area de ventas ya se validaba antes del alta, pero la clase de documento solo
  // la miraba el builder, que corre DESPUES. A un tenant al que solo le faltara ese dato se le
  // creaba el socio de negocio en el maestro de clientes de SAP y recien ahi fallaba, con un
  // error permanente (sin reintento), dejando un cliente huerfano por cada intento.
  it('no toca el maestro de clientes cuando falta SalesQuotationType: falla antes de resolver al cliente', async () => {
    const findOrCreateForDocument = jest.fn();
    const createQuotation = jest.fn();

    const useCase = new ProcessHubspotCreateQuotation({
      runtimeRepository: buildRuntimeRepository(buildContext({ sapFlavor: 'S4' })),
      sapOrderAdapter: {},
      sapQuotationAdapter: {},
      hubspotWebhookAdapter: { updateAfterSap: jest.fn() },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      sapDocumentLinkRepository: { findByDeal: jest.fn().mockResolvedValue(null), create: jest.fn() },
      salesDocumentConfigRepository: {
        getSalesDocumentConfig: async () => ({ ...S4_SALES_DOCUMENT_CONFIG, quotationType: null }),
      },
      salesDocumentStrategyFactory: () => ({
        documentBusinessPartnerResolver: { findOrCreateForDocument },
        salesDocumentBuilder: { buildQuotationPayload: jest.fn() },
        salesDocumentAdapter: { createQuotation },
      }),
      ...noopSyncError,
      logger: { warn: jest.fn(), info: jest.fn() },
    });

    // El error NOMBRA el campo que falta, igual que las validaciones que ya existian.
    await expect(useCase.execute({ event: baseEvent, tenantModels }))
      .rejects.toThrow(/SalesQuotationType/);

    expect(findOrCreateForDocument).not.toHaveBeenCalled();
    expect(createQuotation).not.toHaveBeenCalled();
  });

  it('valida tambien los tres campos del area de ventas antes de resolver al cliente', async () => {
    const findOrCreateForDocument = jest.fn();

    const useCase = new ProcessHubspotCreateQuotation({
      runtimeRepository: buildRuntimeRepository(buildContext({ sapFlavor: 'S4' })),
      sapOrderAdapter: {},
      sapQuotationAdapter: {},
      hubspotWebhookAdapter: { updateAfterSap: jest.fn() },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      sapDocumentLinkRepository: { findByDeal: jest.fn().mockResolvedValue(null), create: jest.fn() },
      salesDocumentConfigRepository: {
        getSalesDocumentConfig: async () => ({ ...S4_SALES_DOCUMENT_CONFIG, distributionChannel: '' }),
      },
      salesDocumentStrategyFactory: () => ({
        documentBusinessPartnerResolver: { findOrCreateForDocument },
        salesDocumentBuilder: { buildQuotationPayload: jest.fn() },
        salesDocumentAdapter: { createQuotation: jest.fn() },
      }),
      ...noopSyncError,
      logger: { warn: jest.fn(), info: jest.fn() },
    });

    await expect(useCase.execute({ event: baseEvent, tenantModels }))
      .rejects.toThrow(/DistributionChannel/);
    expect(findOrCreateForDocument).not.toHaveBeenCalled();
  });

  // Un tenant de B1 no puede verse afectado por la validacion de S/4: sus cuatro campos no
  // existen en su configuracion y la oferta tiene que crearse igual que siempre.
  it('B1 no pasa por la validacion de los campos de cabecera de S/4', async () => {
    const createQuotation = jest.fn().mockResolvedValue({ DocEntry: 55, DocNum: 900, DocumentLines: [{ LineNum: 0 }] });
    const findOrCreateForDocument = jest.fn().mockResolvedValue({
      cardCode: 'CL001',
      businessPartnerResult: { created: false, matchedBy: 'cardCode' },
      contactEmployeeResult: { created: false, internalCodes: [] },
      contactEmployeeFailures: [],
      hubspotToken: null,
      dealContactIsContactEmployee: false,
    });

    const useCase = new ProcessHubspotCreateQuotation({
      runtimeRepository: buildRuntimeRepository(buildContext({ sapFlavor: undefined })),
      sapOrderAdapter: {},
      sapQuotationAdapter: {},
      hubspotWebhookAdapter: { updateAfterSap: jest.fn().mockResolvedValue({}) },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      sapDocumentLinkRepository: { findByDeal: jest.fn().mockResolvedValue(null), create: jest.fn() },
      salesDocumentStrategyFactory: () => ({
        documentBusinessPartnerResolver: { findOrCreateForDocument },
        salesDocumentBuilder: { buildQuotationPayload: jest.fn().mockReturnValue({ CardCode: 'CL001' }) },
        salesDocumentAdapter: { createQuotation },
      }),
      ...noopSyncError,
      logger: { warn: jest.fn(), info: jest.fn() },
    });

    // salesDocumentConfigRepository no se inyecta: el default devuelve los cuatro campos en
    // null, que es exactamente la configuracion de un tenant de B1.
    const result = await useCase.execute({ event: baseEvent, tenantModels });

    expect(result.docEntry).toBe(55);
    expect(createQuotation).toHaveBeenCalled();
  });
});

// El trio por defecto solo existe para construcciones directas (tests que no pasan por
// composicion). Armaba SIEMPRE el trio de B1, ignorando el sabor: con un tenant de S/4 salia un
// hibrido -- builder de Business One, cero posiciones, persistido con el vocabulario de S/4 --
// justo lo que el trio existe para impedir.
describe('trio por defecto de ProcessHubspotCreateQuotation', () => {
  function buildUseCaseWithoutFactory(sapFlavor) {
    return new ProcessHubspotCreateQuotation({
      runtimeRepository: buildRuntimeRepository(buildContext({ sapFlavor })),
      sapOrderAdapter: {
        findOrCreateBusinessPartner: jest.fn().mockResolvedValue({
          cardCode: 'CL001',
          created: false,
          matchedBy: 'cardCode',
          businessPartner: { CardCode: 'CL001' },
          requestPayload: null,
          responsePayload: null,
        }),
        addContactEmployeesIfNeeded: jest.fn(),
      },
      sapQuotationAdapter: {
        createQuotation: jest.fn().mockResolvedValue({ DocEntry: 55, DocNum: 900, DocumentLines: [{ LineNum: 0 }] }),
      },
      hubspotWebhookAdapter: {
        getAccessToken: jest.fn().mockResolvedValue('token'),
        updateBusinessPartnerIds: jest.fn(),
        updateAfterSap: jest.fn().mockResolvedValue({}),
        updateContactEmployeeCodes: jest.fn().mockResolvedValue([]),
      },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      sapDocumentLinkRepository: { findByDeal: jest.fn().mockResolvedValue(null), create: jest.fn() },
      ...noopSyncError,
      logger: { warn: jest.fn(), info: jest.fn() },
    });
  }

  it('falla diciendo que para S/4 hay que inyectar la factory real, en vez de devolver una mezcla', async () => {
    await expect(buildUseCaseWithoutFactory('S4').execute({ event: baseEvent, tenantModels }))
      .rejects.toThrow(/composici/i);
  });

  it('sigue armando el trio de B1 para un tenant sin sapFlavor', async () => {
    const result = await buildUseCaseWithoutFactory(undefined)
      .execute({ event: baseEvent, tenantModels });

    expect(result.docEntry).toBe(55);
    expect(result.docNum).toBe(900);
  });
});
