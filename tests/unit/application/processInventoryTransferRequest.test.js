import { jest } from '@jest/globals';
import ProcessHubspotInventoryTransferRequest from '../../../src/application/use-cases/ProcessHubspotInventoryTransferRequest.js';

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
      ],
      dealMappings: [
        { sourceField: 'DocEntry', targetField: 'sap_docentry' },
        { sourceField: 'DocNum', targetField: 'sap_docnum' },
      ],
      dealOrdersQuotationsMappings: [
        { sourceField: 'PaymentGroupCode', targetField: 'paymentGroupCode' },
      ],
      dealInventoryTransferRequestMappings: [
        { sourceField: 'FromWarehouse', targetField: 'filler' },
        { sourceField: 'ToWarehouse', targetField: 'towhscode' },
      ],
      productInventoryTransferRequestMappings: [
        { sourceField: 'ItemCode', targetField: 'hs_sku' },
        { sourceField: 'Quantity', targetField: 'quantity' },
        { sourceField: 'FromWarehouseCode', targetField: 'filler' },
        { sourceField: 'WarehouseCode', targetField: 'towhscode' },
      ],
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
    // Espeja el default de produccion: sin bypass, un ContactEmployee rechazado bloquea.
    resolveSapErrorBypassConfig: jest.fn().mockResolvedValue({ contactEmployee: false }),
  };
}

const baseEvent = {
  _id: 'event-1',
  eventType: 'inventoryTransferRequest',
  payload: {
    portalId: '50564010',
    deal: { hs_object_id: '59680314911', filler: 'B01', towhscode: 'B02' },
    // A deal always has a company or a contact in production; resolveBusinessPartnerAndContactEmployees
    // (wired in by Task 10) now enforces that invariant for real instead of it being silently
    // absorbed by the fully-mocked findOrCreateBusinessPartner used throughout this suite.
    contact: { hs_object_id: 'contact-1', firstname: 'Cliente Mostrador' },
    line_items: [
      { hubspot_id: 'li-1', hs_sku: 'A01', quantity: '3', filler: 'B01', towhscode: 'B02' },
    ],
  },
};

const tenantModels = { WebhookEvent: {}, SapDocumentLink: {} };

describe('ProcessHubspotInventoryTransferRequest', () => {
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
      sapInventoryTransferRequestAdapter: {
        createInventoryTransferRequest: jest.fn().mockResolvedValue({
          DocEntry: 12345,
          DocNum: 8001,
          StockTransferLines: [{ LineNum: 0 }],
        }),
      },
      hubspotWebhookAdapter: {
        getAccessToken: jest.fn().mockResolvedValue('token'),
        updateBusinessPartnerIds: jest.fn(),
        updateAfterSap: jest.fn().mockResolvedValue({ deal: { ok: true } }),
      },
      webhookReferenceRepository: { persistReferences: jest.fn() },
      sapDocumentLinkRepository: {
        findByDeal: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      ...noopSyncError,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };
  }

  // El PATCH de ContactEmployees se traga el error a proposito para no tumbar el
  // documento, pero antes no lo logueaba, no lo auditaba y no lo devolvia: el evento
  // quedaba `completed` limpio con contactos que SAP nunca aceptó.
  describe('ContactEmployees rechazados por SAP', () => {
    // Con company presente el contacto del deal se resuelve como ContactEmployee, que es lo
    // que hace que el flujo llegue a addContactEmployeesIfNeeded. Sin company el contacto ES
    // el Business Partner y no hay ContactEmployee que crear.
    const eventWithCompanyForFailures = {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        company: { hs_object_id: 'company-1', name: 'FUNDAP' },
      },
    };

    function buildDepsWithRejectedContactEmployee() {
      const deps = buildDeps();
      const sapError = new Error('Request failed with status code 400');
      sapError.response = {
        data: {
          error: {
            message: { lang: 'en-us', value: "Value too long in property 'Title' of 'ContactEmployee'" },
          },
        },
      };
      deps.sapOrderAdapter.addContactEmployeesIfNeeded.mockResolvedValue({
        created: false,
        internalCodes: [],
        results: [],
        requestPayload: [{ Name: 'LINDA MARIBEL COLOP', Title: 'MICROCREDITOS CNTRAL' }],
        responsePayload: [],
        updateResults: [],
        errors: [{
          contact: { email: 'linda.colop@fundap.com.gt' },
          requestPayload: { Name: 'LINDA MARIBEL COLOP', E_Mail: 'linda.colop@fundap.com.gt' },
          error: sapError,
        }],
      });
      return deps;
    }

    const EXPECTED_FAILURES = [
      {
        email: 'linda.colop@fundap.com.gt',
        name: 'LINDA MARIBEL COLOP',
        message: "Value too long in property 'Title' of 'ContactEmployee'",
      },
    ];

    // Sin bypass (el default) el negocio NO se sincroniza: el punto es que el traslado no
    // exista en SAP para que la data se corrija en HubSpot y se reenvie.
    describe('sin bypass configurado', () => {
      it('falla como permanente y NO crea el documento en SAP', async () => {
        const deps = buildDepsWithRejectedContactEmployee();
        const useCase = new ProcessHubspotInventoryTransferRequest(deps);

        const error = await useCase
          .execute({ event: eventWithCompanyForFailures, tenantModels })
          .then(() => null, (rejected) => rejected);

        expect(error).not.toBeNull();
        // permanent: la data no se arregla sola, reintentar 3 veces es gastar viajes a SAP.
        expect(error.permanent).toBe(true);
        expect(deps.sapInventoryTransferRequestAdapter.createInventoryTransferRequest)
          .not.toHaveBeenCalled();
        expect(deps.sapDocumentLinkRepository.create).not.toHaveBeenCalled();
      });

      it('el mensaje del error dice que no se sincronizo y nombra al contacto', async () => {
        const deps = buildDepsWithRejectedContactEmployee();
        const useCase = new ProcessHubspotInventoryTransferRequest(deps);

        const error = await useCase
          .execute({ event: eventWithCompanyForFailures, tenantModels })
          .then(() => null, (rejected) => rejected);

        expect(error.message).toContain('No se sincronizó');
        expect(error.message).toContain('HubSpot');
        expect(error.message).toContain('linda.colop@fundap.com.gt');
        expect(error.message).toContain("Value too long in property 'Title'");
      });

      it('el sapAudit del error conserva los ContactEmployees rechazados', async () => {
        const deps = buildDepsWithRejectedContactEmployee();
        const useCase = new ProcessHubspotInventoryTransferRequest(deps);

        const error = await useCase
          .execute({ event: eventWithCompanyForFailures, tenantModels })
          .then(() => null, (rejected) => rejected);

        expect(error.sapAudit.auditTrail.response_SAP.contactEmployeeErrors)
          .toEqual(EXPECTED_FAILURES);
        expect(deps.logger.error).toHaveBeenCalledWith(expect.objectContaining({
          msg: 'ContactEmployee rechazado por SAP: el documento sigue adelante sin el',
          email: 'linda.colop@fundap.com.gt',
        }));
      });
    });

    // Con bypass el tenant acepta el trade-off: el documento vale mas que el contacto.
    describe('con bypass activo', () => {
      function buildDepsWithBypass() {
        const deps = buildDepsWithRejectedContactEmployee();
        deps.runtimeRepository.resolveSapErrorBypassConfig
          .mockResolvedValue({ contactEmployee: true });
        return deps;
      }

      it('crea el documento y devuelve los fallos para que el batch avise a HubSpot', async () => {
        const deps = buildDepsWithBypass();
        const useCase = new ProcessHubspotInventoryTransferRequest(deps);

        const result = await useCase.execute({ event: eventWithCompanyForFailures, tenantModels });

        expect(result.docNum).toBe(8001);
        expect(result.contactEmployeeFailures).toEqual(EXPECTED_FAILURES);
      });

      it('deja el fallo en el sapAudit y en el log igual que sin bypass', async () => {
        const deps = buildDepsWithBypass();
        const useCase = new ProcessHubspotInventoryTransferRequest(deps);

        const result = await useCase.execute({ event: eventWithCompanyForFailures, tenantModels });

        expect(result.sapAudit.auditTrail.response_SAP.contactEmployeeErrors)
          .toEqual(EXPECTED_FAILURES);
        expect(deps.logger.error).toHaveBeenCalledWith(expect.objectContaining({
          email: 'linda.colop@fundap.com.gt',
        }));
      });
    });

    it('no agrega contactEmployeeFailures cuando todos los contactos entran', async () => {
      const deps = buildDeps();
      deps.sapOrderAdapter.addContactEmployeesIfNeeded.mockResolvedValue({
        created: true,
        internalCodes: [],
        results: [],
        requestPayload: [],
        responsePayload: [],
        updateResults: [],
        errors: [],
      });
      const useCase = new ProcessHubspotInventoryTransferRequest(deps);

      const result = await useCase.execute({ event: eventWithCompanyForFailures, tenantModels });

      expect(result.contactEmployeeFailures).toEqual([]);
      expect(result.sapAudit.auditTrail.response_SAP).not.toHaveProperty('contactEmployeeErrors');
    });
  });

  it('creates an Inventory Transfer Request, persists the link and updates the deal', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    const result = await useCase.execute({
      event: baseEvent,
      tenantModels,
      tenantId: 't1',
      tenantKey: 'k1',
      portalId: '50564010',
    });

    expect(deps.sapInventoryTransferRequestAdapter.createInventoryTransferRequest)
      .toHaveBeenCalledTimes(1);

    const linkArg = deps.sapDocumentLinkRepository.create.mock.calls[0][0].link;
    expect(linkArg).toMatchObject({
      dealId: '59680314911',
      documentType: 'inventoryTransferRequest',
      sapObject: 'InventoryTransferRequests',
      sapDocEntry: 12345,
      sapDocNum: 8001,
      sapBaseType: 1250000001,
    });
    expect(linkArg.lines[0]).toMatchObject({ hubspotLineItemId: 'li-1', sapLineNum: 0 });

    expect(deps.hubspotWebhookAdapter.updateAfterSap).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      cardCode: 'CL00129',
      docEntry: 12345,
      docNum: 8001,
      dealId: '59680314911',
    });

    const { inventoryTransferRequestPayload } = deps.sapInventoryTransferRequestAdapter
      .createInventoryTransferRequest.mock.calls[0][0];
    expect(inventoryTransferRequestPayload).toMatchObject({
      FromWarehouse: 'B01',
      ToWarehouse: 'B02',
      StockTransferLines: [{ ItemCode: 'A01', Quantity: 3, FromWarehouseCode: 'B01', WarehouseCode: 'B02' }],
    });
    expect(result.sapAudit.auditTrail.payload_SAP.inventoryTransferRequest).toMatchObject({
      FromWarehouse: 'B01',
      ToWarehouse: 'B02',
    });
  });

  it('is idempotent: skips creation when an inventoryTransferRequest link already exists', async () => {
    const deps = buildDeps();
    deps.sapDocumentLinkRepository.findByDeal.mockResolvedValue({
      cardCode: 'CL00129',
      sapDocEntry: 12345,
      sapDocNum: 8001,
    });
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    const result = await useCase.execute({ event: baseEvent, tenantModels });

    expect(deps.sapInventoryTransferRequestAdapter.createInventoryTransferRequest).not.toHaveBeenCalled();
    expect(deps.sapDocumentLinkRepository.findByDeal.mock.calls[0][0]).toMatchObject({
      documentType: 'inventoryTransferRequest',
    });
    expect(result).toMatchObject({
      cardCode: 'CL00129',
      docEntry: 12345,
      docNum: 8001,
      dealId: '59680314911',
    });
    // Sin trafico a SAP no hay nada que auditar, pero el documento tiene que decir POR QUE
    // esta vacio: un sapAudit en null se lee igual que una auditoria rota.
    expect(result.sapAudit.auditTrail.skipped).toEqual({
      reason: 'inventory_transfer_request_already_exists',
      sapDocEntry: 12345,
      sapDocNum: 8001,
    });
  });

  it('fails permanently and never calls the adapter when both warehouses are unmapped', async () => {
    const context = buildContext();
    context.mappings.dealInventoryTransferRequestMappings = [];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    const error = await useCase.execute({ event: baseEvent, tenantModels }).catch((e) => e);

    expect(error.permanent).toBe(true);
    expect(deps.sapInventoryTransferRequestAdapter.createInventoryTransferRequest).not.toHaveBeenCalled();
    expect(error.sapOrderCreated).toBeUndefined();
    expect(error.syncLogWebhookErrors).toHaveLength(1);
  });

  it('marks sapOrderCreated when the document was created in SAP but the HubSpot write-back fails', async () => {
    const deps = buildDeps();
    deps.hubspotWebhookAdapter.updateAfterSap.mockRejectedValue(new Error('HubSpot down'));
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    const error = await useCase.execute({ event: baseEvent, tenantModels }).catch((e) => e);

    expect(error.sapOrderCreated).toBe(true);
    expect(error.sapOrderResult).toMatchObject({ docEntry: 12345, docNum: 8001 });
  });

  it('does not leak fields mapped only for orders-quotations into the ITR payload', async () => {
    const event = {
      ...baseEvent,
      payload: { ...baseEvent.payload, deal: { ...baseEvent.payload.deal, paymentGroupCode: '3' } },
    };
    const deps = buildDeps();
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    await useCase.execute({ event, tenantModels });

    const { inventoryTransferRequestPayload } = deps.sapInventoryTransferRequestAdapter
      .createInventoryTransferRequest.mock.calls[0][0];
    expect(inventoryTransferRequestPayload).not.toHaveProperty('PaymentGroupCode');
  });

  it('writes DocEntry/DocNum back using the inventory-transfer-request mappings when they define them', async () => {
    const context = buildContext();
    context.mappings.dealInventoryTransferRequestMappings = [
      { sourceField: 'FromWarehouse', targetField: 'filler' },
      { sourceField: 'ToWarehouse', targetField: 'towhscode' },
      { sourceField: 'DocEntry', targetField: 'itr_docentry' },
      { sourceField: 'DocNum', targetField: 'itr_docnum' },
    ];
    const deps = buildDeps();
    deps.runtimeRepository = buildRuntimeRepository(context);
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    await useCase.execute({ event: baseEvent, tenantModels });

    const { dealMappings } = deps.hubspotWebhookAdapter.updateAfterSap.mock.calls[0][0];
    expect(dealMappings).toEqual(context.mappings.dealInventoryTransferRequestMappings);
  });

  it('falls back to the plain deal mappings for write-back when the ITR context has no DocEntry/DocNum', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    await useCase.execute({ event: baseEvent, tenantModels });

    const { dealMappings } = deps.hubspotWebhookAdapter.updateAfterSap.mock.calls[0][0];
    expect(dealMappings).toEqual([
      { sourceField: 'DocEntry', targetField: 'sap_docentry' },
      { sourceField: 'DocNum', targetField: 'sap_docnum' },
    ]);
  });

  it('never resolves group code defaults: OWTQ has no PaymentGroupCode', async () => {
    const deps = buildDeps();
    const useCase = new ProcessHubspotInventoryTransferRequest(deps);

    await useCase.execute({ event: baseEvent, tenantModels });

    expect(deps.runtimeRepository.resolveGroupCodeDefaults).not.toHaveBeenCalled();
  });

  // El write-back legacy de internalcode le escribe al contact del deal. Solo es
  // correcto en modo dealContact, donde ese contact ES el ContactEmployee real.
  describe('internalcode al contact del deal', () => {
    const eventWithCompany = {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        company: { hs_object_id: 'company-1', name: 'ACME' },
      },
    };

    function buildDepsWithContactEmployees(internalCodes) {
      const deps = buildDeps();
      deps.hubspotWebhookAdapter.updateContactEmployeeCodes = jest.fn().mockResolvedValue([]);
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

    it('dealContact: le escribe su propio internalcode (conducta historica)', async () => {
      const deps = buildDepsWithContactEmployees([
        { contact: eventWithCompany.payload.contact, internalCode: 501 },
      ]);
      const useCase = new ProcessHubspotInventoryTransferRequest(deps);

      await useCase.execute({ event: eventWithCompany, tenantModels });

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
      const useCase = new ProcessHubspotInventoryTransferRequest(deps);

      await useCase.execute({
        event: {
          ...eventWithCompany,
          payload: { ...eventWithCompany.payload, contactEmployees: [{ firstname: 'Ana' }] },
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
