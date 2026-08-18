import { jest } from '@jest/globals';
import ProcessHubspotWebhookEvent from '#application/use-cases/ProcessHubspotWebhookEvent.js';
import { SapWebhookOrderAdapter } from '#infrastructure/sap/SapWebhookOrderAdapter.js';
import { createSapCallRecorder } from '#infrastructure/sap/sapCallRecorder.js';
import {
  buildErrorResponseSnapshot,
  buildWebhookSapAudit,
  buildWebhookSyncErrorEntry,
} from '#infrastructure/sync/syncLog.service.js';

// REGRESION DEL CASO REAL: un createDeal cuyo POST /BusinessPartners fue rechazado por un
// stored procedure de SAP quedo en Mongo con lastError
// "(1) SP - ERROR - el subgrupo NO es valido para este cliente." y sapAudit: null, o sea
// sin ninguna pista de que se le habia mandado a SAP. Causa: el auditTrail solo se llenaba
// con el valor de retorno de las llamadas exitosas, asi que la llamada que fallaba se
// perdia completa. Esta suite usa el adapter real (con `request` stubbeado) y el
// buildWebhookSapAudit real: es el unico punto donde se ve el recorrido completo
// transporte -> auditTrail -> sapAudit.

const SAP_SUBGROUP_ERROR = Object.assign(new Error('Request failed with status code 400'), {
  response: {
    status: 400,
    statusText: 'Bad Request',
    data: {
      error: {
        code: -2028,
        message: { lang: 'es-GT', value: '(1) SP - ERROR - el subgrupo NO es valido para este cliente.' },
      },
    },
  },
});

function buildContext() {
  return {
    mappings: {
      companyMappings: [],
      contactBusinessPartnerMappings: [
        { sourceField: 'CardName', targetField: 'firstname', isActive: true },
        { sourceField: 'EmailAddress', targetField: 'email', isActive: true },
        { sourceField: 'GroupCode', targetField: 'groupcode', isActive: true },
      ],
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

function buildDeps({ sapOrderAdapter }) {
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
    },
    sapOrderAdapter,
    hubspotWebhookAdapter: {
      getAccessToken: jest.fn().mockResolvedValue('token'),
      updateBusinessPartnerIds: jest.fn().mockResolvedValue({ contact: { ok: true } }),
      updateAfterSap: jest.fn().mockResolvedValue({ deal: { ok: true } }),
      updateContactEmployeeCodes: jest.fn().mockResolvedValue([]),
    },
    webhookReferenceRepository: { persistReferences: jest.fn() },
    webhookEventProgressRepository: { markOrderCreated: jest.fn() },
    buildWebhookSyncErrorEntry,
    buildErrorResponseSnapshot,
    buildWebhookSapAudit,
    createSapCallRecorder,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

const event = {
  _id: 'event-1',
  eventType: 'createDeal',
  payload: {
    portalId: '50082681',
    deal: { hs_object_id: '60275617685', groupnum: '13' },
    company: null,
    contact: {
      hs_object_id: '154441149528',
      firstname: 'Dany Sec',
      email: 'danysec@gmail.com',
      groupcode: '105',
    },
    line_items: [{ hubspot_id: 'li-1', hs_sku: '1T02T90US1L', quantity: '1', price: '476.00' }],
  },
};

const tenantModels = { WebhookEvent: {} };

describe('sapAudit cuando SAP rechaza la creacion del BusinessPartner', () => {
  it('guarda el POST /BusinessPartners que fallo, con su payload y el error de SAP', async () => {
    const sapOrderAdapter = new SapWebhookOrderAdapter();
    jest.spyOn(sapOrderAdapter, 'request').mockImplementation(async (_sapConfig, { method, path }) => {
      if (method === 'post' && path === '/BusinessPartners') {
        throw SAP_SUBGROUP_ERROR;
      }
      return { value: [] };
    });
    const useCase = new ProcessHubspotWebhookEvent(buildDeps({ sapOrderAdapter }));

    const error = await useCase.execute({ event, tenantModels }).then(
      () => { throw new Error('se esperaba que el use case fallara'); },
      (thrown) => thrown
    );

    expect(error.sapAudit).not.toBeNull();

    const failedCall = error.sapAudit.sapCalls.find((call) => call.ok === false);
    expect(failedCall).toMatchObject({
      method: 'POST',
      path: '/BusinessPartners',
      status: 400,
    });
    expect(failedCall.request).toMatchObject({
      CardName: 'Dany Sec',
      EmailAddress: 'danysec@gmail.com',
    });
    expect(failedCall.error.message).toContain('el subgrupo NO es valido');
  });

  it('guarda tambien las busquedas previas, no solo la llamada que fallo', async () => {
    const sapOrderAdapter = new SapWebhookOrderAdapter();
    jest.spyOn(sapOrderAdapter, 'request').mockImplementation(async (_sapConfig, { method, path }) => {
      if (method === 'post' && path === '/BusinessPartners') {
        throw SAP_SUBGROUP_ERROR;
      }
      return { value: [] };
    });
    const useCase = new ProcessHubspotWebhookEvent(buildDeps({ sapOrderAdapter }));

    const error = await useCase.execute({ event, tenantModels }).catch((thrown) => thrown);

    const searchCall = error.sapAudit.sapCalls.find((call) => call.method === 'GET');
    expect(searchCall.path).toBe('/BusinessPartners');
    // Query string, no objeto: las claves `$top`/`$select`/`$filter` son las que Mongo
    // rechaza dentro de un $set.
    expect(searchCall.params).toContain("$filter=EmailAddress eq 'danysec@gmail.com'");
    expect(searchCall.ok).toBe(true);
  });

  it('registra el trafico tambien cuando el evento termina bien', async () => {
    const sapOrderAdapter = new SapWebhookOrderAdapter();
    jest.spyOn(sapOrderAdapter, 'request').mockImplementation(async (_sapConfig, { method, path }) => {
      if (method === 'post' && path === '/BusinessPartners') {
        return { CardCode: 'CL00129' };
      }
      if (method === 'post' && path === '/Orders') {
        return { DocEntry: 67890, DocNum: 9001 };
      }
      if (method === 'get' && path.startsWith("/BusinessPartners('")) {
        return { CardCode: 'CL00129', ContactEmployees: [] };
      }
      return { value: [] };
    });
    const useCase = new ProcessHubspotWebhookEvent(buildDeps({ sapOrderAdapter }));

    const result = await useCase.execute({ event, tenantModels });

    expect(result.docEntry).toBe(67890);
    const paths = result.sapAudit.sapCalls.map((call) => `${call.method} ${call.path}`);
    expect(paths).toContain('POST /BusinessPartners');
    expect(paths).toContain('POST /Orders');
    expect(result.sapAudit.sapCalls.every((call) => call.ok)).toBe(true);
  });
});
