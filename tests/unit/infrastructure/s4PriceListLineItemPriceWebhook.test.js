import { jest } from '@jest/globals';
import {
  DEAL_CURRENCY_PROPERTY,
  DEAL_DISTRIBUTION_CHANNEL_PROPERTY,
  DEAL_SALES_ORG_PROPERTY,
} from '../../../src/infrastructure/webhook/s4PriceListLineItemPriceWebhook.service.js';
import { S4PriceListLineItemPriceWebhookService } from '../../../src/infrastructure/webhook/s4PriceListLineItemPriceWebhook.service.js';

const ASSOCIATION_EVENT = {
  eventId: 1,
  subscriptionId: 2,
  portalId: 3,
  appId: 4,
  occurredAt: 5,
  fromObjectId: '77',
  associationType: 'DEAL_TO_LINE_ITEM',
  changeSource: 'USER',
};

const LINE_ITEM_PROPERTY_EVENT = {
  eventId: 10,
  subscriptionId: 20,
  portalId: 3,
  appId: 4,
  occurredAt: 50,
  objectId: '1',
  sourceId: 'userId:123',
  propertyName: 'quantity',
  propertyValue: '5',
  subscriptionType: 'line_item.propertyChange',
  changeSource: 'CRM_UI',
};

// `duplicate` es lo que ve el guard ANTES de insertar; `duplicateAfterConflict` es lo que ve la
// segunda lectura, la que ocurre sólo después de que el create() choca con el índice único (así
// se puede montar el caso "el guard no lo vio, pero existe"). `claimed` es lo que devuelve la
// reclamación atómica: un documento significa "era un intento fallado y lo gané", null significa
// "no había nada reclamable" (ya enviado o en vuelo).
function buildTenantModels({
  duplicate = null,
  recent = null,
  duplicateAfterConflict = null,
  claimed = null,
} = {}) {
  let duplicateReads = 0;
  const findOne = jest.fn().mockImplementation((filter) => ({
    select: () => ({
      lean: async () => {
        if (filter.dealId) {
          return recent;
        }

        duplicateReads += 1;
        return duplicateReads === 1 ? duplicate : duplicateAfterConflict;
      },
    }),
  }));

  return {
    LineItemPriceWebhookEvent: {
      findOne,
      findOneAndUpdate: jest.fn().mockImplementation(() => ({ lean: async () => claimed })),
      create: jest.fn(async (doc) => ({ _id: 'event-1', ...doc })),
      updateOne: jest.fn(async () => ({})),
    },
  };
}

// Filtro con el que se reclama: es la negación EXACTA del guard de duplicados. Si alguien lo
// relaja (por ejemplo saca `errorMessage: { $ne: null }`), la reclamación adoptaría un evento en
// vuelo o ya enviado y el negocio se valorizaría dos veces.
const ASSOCIATION_CLAIM_FILTER = {
  'payload.eventId': ASSOCIATION_EVENT.eventId,
  'payload.subscriptionId': ASSOCIATION_EVENT.subscriptionId,
  'payload.portalId': ASSOCIATION_EVENT.portalId,
  'payload.appId': ASSOCIATION_EVENT.appId,
  'payload.occurredAt': ASSOCIATION_EVENT.occurredAt,
  'payload.fromObjectId': ASSOCIATION_EVENT.fromObjectId,
  isSend: false,
  errorMessage: { $ne: null },
};

function buildService({
  deal = {
    id: '77',
    // El área de ventas la declara el negocio: son propiedades obligatorias al crearlo.
    properties: {
      sales_organization: 'mqgt',
      distribution_channel: '01',
      deal_currency_code: 'usd',
    },
    associations: {
      companies: { results: [{ id: '900' }] },
      'line items': { results: [{ id: '1' }, { id: '2' }] },
    },
  },
  company = { id: '900', properties: { idsap: '105049' } },
  lineItems = {
    lineItems: [
      { id: '1', itemCode: '80000017', quantity: '3' },
      { id: '2', itemCode: '80000029', quantity: '1' },
    ],
    failures: [],
  },
} = {}) {
  const fetchHubspotObject = jest.fn(async (_token, objectType) => (
    objectType === 'deals' ? deal : company
  ));

  return {
    fetchHubspotObject,
    service: new S4PriceListLineItemPriceWebhookService({
      hubspotAuth: { getAccessToken: jest.fn(async () => 'token') },
      tenantConfiguration: { getValue: jest.fn(async (_models, _key, fallback) => fallback) },
      resolveHubspotCredentials: jest.fn(async () => ({ clientConfigId: 'cfg' })),
      fetchHubspotObject,
      readLineItems: jest.fn(async () => lineItems),
      log: { info: jest.fn(), warn: jest.fn() },
    }),
  };
}

describe('S4PriceListLineItemPriceWebhookService.preparePayload', () => {
  it('arma el payload con el cliente del idsap de la company y las líneas del deal', async () => {
    const { service } = buildService();
    const tenantModels = buildTenantModels();

    const result = await service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels,
      tenant: {},
      tenantKey: 'multiquimica',
    });

    expect(result.skip).toBe(false);
    expect(result.executionId).toBe('event-1');
    expect(result.payload).toEqual({
      dealId: '77',
      customer: '105049',
      // Organización y moneda en mayúsculas; el canal INTACTO: SAP devuelve '01' y un '1'
      // normalizado nunca matchearía la clave del mapa de defaults.
      salesOrganization: 'MQGT',
      distributionChannel: '01',
      dealCurrency: 'USD',
      lineItems: [
        { id: '1', itemCode: '80000017', quantity: '3' },
        { id: '2', itemCode: '80000029', quantity: '1' },
      ],
      lineItemFailures: [],
    });
  });

  it('pide al deal las tres propiedades del área de ventas y la moneda', async () => {
    const { service, fetchHubspotObject } = buildService();

    await service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels: buildTenantModels(),
      tenant: {},
      tenantKey: 'multiquimica',
    });

    expect(fetchHubspotObject).toHaveBeenCalledWith(
      'token',
      'deals',
      '77',
      expect.objectContaining({
        properties: expect.arrayContaining([
          DEAL_SALES_ORG_PROPERTY,
          DEAL_DISTRIBUTION_CHANNEL_PROPERTY,
          DEAL_CURRENCY_PROPERTY,
        ]),
        // Las asociaciones se siguen pidiendo: de ahí salen el cliente y las líneas.
        associations: ['companies', 'contacts', 'line_items'],
      })
    );
  });

  // El adapter sólo transporta. Quien decide qué hacer con el vacío es el caso de uso, que es el
  // único que puede escribirle la nota al asesor pidiéndole que complete el campo.
  it('propaga null cuando el negocio no trae las propiedades, sin fallar', async () => {
    const { service } = buildService({
      deal: {
        id: '77',
        properties: {},
        associations: {
          companies: { results: [{ id: '900' }] },
          'line items': { results: [{ id: '1' }, { id: '2' }] },
        },
      },
    });

    const result = await service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels: buildTenantModels(),
      tenant: {},
      tenantKey: 'multiquimica',
    });

    expect(result.skip).toBe(false);
    expect(result.payload).toMatchObject({
      salesOrganization: null,
      distributionChannel: null,
      dealCurrency: null,
    });
  });

  it('lleva el área de ventas al meta, para que el log y el skip la muestren', async () => {
    const { service } = buildService();

    const result = await service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels: buildTenantModels(),
      tenant: {},
      tenantKey: 'multiquimica',
    });

    expect(result.meta).toMatchObject({
      dealId: '77',
      customer: '105049',
      salesOrganization: 'MQGT',
      distributionChannel: '01',
    });
  });

  it('ignora eventos que no son de asociación deal→line item ni property change soportado', async () => {
    const { service } = buildService();

    const result = await service.preparePayload(
      { ...ASSOCIATION_EVENT, associationType: 'DEAL_TO_CONTACT' },
      { tenantModels: buildTenantModels(), tenant: {}, tenantKey: 'multiquimica' }
    );

    expect(result).toEqual({
      skip: true,
      payload: null,
      executionId: null,
      meta: { skipped: true, reason: 'unsupported_event' },
    });
  });

  it('saltea el duplicado SIN insertar un documento (el índice único lo rechazaría)', async () => {
    const { service } = buildService();
    const tenantModels = buildTenantModels({ duplicate: { _id: 'previo' } });

    const result = await service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels,
      tenant: {},
      tenantKey: 'multiquimica',
    });

    expect(result).toEqual({
      skip: true,
      payload: null,
      executionId: null,
      meta: { skipped: true, reason: 'duplicate_event', duplicateOf: 'previo' },
    });
    // El esquema tiene un índice único sobre las claves del evento de asociación: insertar la
    // marca de duplicado daría E11000 en vez de un skip.
    expect(tenantModels.LineItemPriceWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('debouncea cuando ya hubo una ejecución reciente del mismo deal', async () => {
    const service = new S4PriceListLineItemPriceWebhookService({
      hubspotAuth: { getAccessToken: jest.fn(async () => 'token') },
      tenantConfiguration: { getValue: jest.fn(async () => ({ requireSkipped: true, secondsToSkipped: 3 })) },
      resolveHubspotCredentials: jest.fn(async () => ({ clientConfigId: 'cfg' })),
      fetchHubspotObject: jest.fn(async () => ({})),
      readLineItems: jest.fn(),
      log: { info: jest.fn(), warn: jest.fn() },
    });
    const tenantModels = buildTenantModels({ recent: { _id: 'reciente' } });

    const result = await service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels,
      tenant: {},
      tenantKey: 'multiquimica',
    });

    expect(result).toEqual({
      skip: true,
      payload: null,
      executionId: null,
      meta: { skipped: true, reason: 'debounced_event', dealId: '77' },
    });
    expect(tenantModels.LineItemPriceWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('falla cuando el deal no tiene company ni contacto con idsap, y deja el fallo en el evento', async () => {
    const { service } = buildService({
      deal: { id: '77', associations: { 'line items': { results: [{ id: '1' }] } } },
      company: { id: '900', properties: {} },
    });
    const tenantModels = buildTenantModels();

    await expect(service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels,
      tenant: {},
      tenantKey: 'multiquimica',
    })).rejects.toThrow('Deal has no associated SAP customer');

    // El evento se creó antes de leer HubSpot, así que el fallo queda diagnosticable.
    expect(tenantModels.LineItemPriceWebhookEvent.updateOne).toHaveBeenCalledWith(
      { _id: 'event-1' },
      { $set: { isSend: false, errorMessage: expect.stringContaining('Deal has no associated SAP customer') } }
    );
  });

  it('falla cuando el deal no tiene líneas legibles y adjunta los fallos', async () => {
    const { service } = buildService({
      lineItems: { lineItems: [], failures: [{ id: '1', stage: 'hubspot_read', reason: 'boom' }] },
    });

    const error = await service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels: buildTenantModels(),
      tenant: {},
      tenantKey: 'multiquimica',
    }).catch((caught) => caught);

    expect(error.message).toBe('Deal has no readable line items');
    expect(error.lineItemFailures).toEqual([{ id: '1', stage: 'hubspot_read', reason: 'boom' }]);
  });

  it('clasifica un property change de quantity con CRM_UI, resuelve el deal por la asociación del line item y arma el payload', async () => {
    const lineItemRecord = {
      id: '1',
      associations: { deals: { results: [{ id: '77' }] } },
    };
    const deal = {
      id: '77',
      properties: {
        sales_organization: 'mqgt',
        distribution_channel: '01',
        deal_currency_code: 'usd',
      },
      associations: {
        companies: { results: [{ id: '900' }] },
        'line items': { results: [{ id: '1' }, { id: '2' }] },
      },
    };
    const company = { id: '900', properties: { idsap: '105049' } };
    const lineItems = {
      lineItems: [
        { id: '1', itemCode: '80000017', quantity: '3' },
        { id: '2', itemCode: '80000029', quantity: '1' },
      ],
      failures: [],
    };

    const fetchHubspotObject = jest.fn(async (_token, objectType) => {
      if (objectType === 'line_items') return lineItemRecord;
      if (objectType === 'deals') return deal;
      return company;
    });

    const service = new S4PriceListLineItemPriceWebhookService({
      hubspotAuth: { getAccessToken: jest.fn(async () => 'token') },
      tenantConfiguration: { getValue: jest.fn(async (_models, _key, fallback) => fallback) },
      resolveHubspotCredentials: jest.fn(async () => ({ clientConfigId: 'cfg' })),
      fetchHubspotObject,
      readLineItems: jest.fn(async () => lineItems),
      log: { info: jest.fn(), warn: jest.fn() },
    });
    const tenantModels = buildTenantModels();

    const result = await service.preparePayload(LINE_ITEM_PROPERTY_EVENT, {
      tenantModels,
      tenant: {},
      tenantKey: 'multiquimica',
    });

    expect(result.skip).toBe(false);
    expect(result.payload).toEqual({
      dealId: '77',
      customer: '105049',
      salesOrganization: 'MQGT',
      distributionChannel: '01',
      dealCurrency: 'USD',
      lineItems: [
        { id: '1', itemCode: '80000017', quantity: '3' },
        { id: '2', itemCode: '80000029', quantity: '1' },
      ],
      lineItemFailures: [],
    });
    expect(fetchHubspotObject).toHaveBeenCalledWith(
      'token',
      'line_items',
      LINE_ITEM_PROPERTY_EVENT.objectId,
      { associations: ['deals'] }
    );
  });

  it('descarta un property change con changeSource INTEGRATION (protección anti-bucle), sin crear documento ni llamar a HubSpot', async () => {
    const fetchHubspotObject = jest.fn();
    const service = new S4PriceListLineItemPriceWebhookService({
      hubspotAuth: { getAccessToken: jest.fn(async () => 'token') },
      tenantConfiguration: { getValue: jest.fn(async (_models, _key, fallback) => fallback) },
      resolveHubspotCredentials: jest.fn(async () => ({ clientConfigId: 'cfg' })),
      fetchHubspotObject,
      readLineItems: jest.fn(),
      log: { info: jest.fn(), warn: jest.fn() },
    });
    const tenantModels = buildTenantModels();

    const result = await service.preparePayload(
      { ...LINE_ITEM_PROPERTY_EVENT, changeSource: 'INTEGRATION' },
      { tenantModels, tenant: {}, tenantKey: 'multiquimica' }
    );

    expect(result).toEqual({
      skip: true,
      payload: null,
      executionId: null,
      meta: { skipped: true, reason: 'unsupported_event' },
    });
    expect(tenantModels.LineItemPriceWebhookEvent.create).not.toHaveBeenCalled();
    expect(fetchHubspotObject).not.toHaveBeenCalled();
  });

  // Los tres tests que siguen reemplazan al que afirmaba que TODO E11000 es un duplicado
  // benigno. No lo es: findDuplicate exige `isSend: true` o `errorMessage: null`, así que el
  // documento de un intento FALLADO no cuenta como duplicado, el flujo sigue, el create() choca
  // con el índice único y el skip devolvía 200. HubSpot dejaba de reintentar y el negocio se
  // quedaba con los precios viejos sin error en ninguna parte.
  it('E11000 con un intento anterior FALLADO: reclama ese registro y sigue procesando con su _id', async () => {
    const { service } = buildService();
    const tenantModels = buildTenantModels({ claimed: { _id: 'intento-fallado' } });
    const duplicateKeyError = Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    tenantModels.LineItemPriceWebhookEvent.create = jest.fn(async () => {
      throw duplicateKeyError;
    });

    const result = await service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels,
      tenant: {},
      tenantKey: 'multiquimica',
    });

    // Lo que importa: NO es un skip. El payload se arma y el procesamiento sigue sobre el
    // registro reclamado, así que el controlador no responde 200 sin haber hecho nada.
    expect(result.skip).toBe(false);
    expect(result.executionId).toBe('intento-fallado');
    expect(result.payload).toEqual({
      dealId: '77',
      customer: '105049',
      salesOrganization: 'MQGT',
      distributionChannel: '01',
      dealCurrency: 'USD',
      lineItems: [
        { id: '1', itemCode: '80000017', quantity: '3' },
        { id: '2', itemCode: '80000029', quantity: '1' },
      ],
      lineItemFailures: [],
    });
    // Reclamación atómica y condicionada: un findOne + updateOne dejaría que dos reintentos
    // simultáneos se pisaran.
    expect(tenantModels.LineItemPriceWebhookEvent.findOneAndUpdate).toHaveBeenCalledWith(
      ASSOCIATION_CLAIM_FILTER,
      { $set: { errorMessage: null, dealId: '77' } },
      { new: true, projection: { _id: 1 } }
    );
  });

  it('E11000 con el registro existente en vuelo (errorMessage null): skipea sin reclamar nada', async () => {
    const { service } = buildService();
    const tenantModels = buildTenantModels({
      claimed: null,
      duplicateAfterConflict: { _id: 'en-vuelo' },
    });
    const duplicateKeyError = Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    tenantModels.LineItemPriceWebhookEvent.create = jest.fn(async () => {
      throw duplicateKeyError;
    });
    const logInfo = jest.fn();
    service.log = { info: logInfo, warn: jest.fn() };

    const result = await service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels,
      tenant: {},
      tenantKey: 'multiquimica',
    });

    expect(result.skip).toBe(true);
    expect(result.payload).toBeNull();
    expect(result.executionId).toBeNull();
    expect(result.meta).toEqual({
      skipped: true,
      reason: 'duplicate_event',
      raceCondition: true,
      dealId: '77',
    });
    // La reclamación se intentó y la rechazó el propio filtro: el documento en vuelo no se toca.
    expect(tenantModels.LineItemPriceWebhookEvent.findOneAndUpdate).toHaveBeenCalledWith(
      ASSOCIATION_CLAIM_FILTER,
      { $set: { errorMessage: null, dealId: '77' } },
      { new: true, projection: { _id: 1 } }
    );
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ duplicateOf: 'en-vuelo' }));
  });

  it('E11000 con el registro existente ya enviado (isSend true): skipea como duplicado real', async () => {
    const { service } = buildService();
    const tenantModels = buildTenantModels({
      claimed: null,
      duplicateAfterConflict: { _id: 'ya-enviado' },
    });
    const duplicateKeyError = Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    tenantModels.LineItemPriceWebhookEvent.create = jest.fn(async () => {
      throw duplicateKeyError;
    });
    const logInfo = jest.fn();
    service.log = { info: logInfo, warn: jest.fn() };

    const result = await service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels,
      tenant: {},
      tenantKey: 'multiquimica',
    });

    expect(result.skip).toBe(true);
    expect(result.meta).toEqual({
      skipped: true,
      reason: 'duplicate_event',
      raceCondition: true,
      dealId: '77',
    });
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ duplicateOf: 'ya-enviado' }));
  });

  it('un error de escritura que NO es E11000 se propaga en vez de quedar tragado como skip', async () => {
    const { service } = buildService();
    const tenantModels = buildTenantModels();
    tenantModels.LineItemPriceWebhookEvent.create = jest.fn(async () => {
      throw Object.assign(new Error('connection to mongo lost'), { code: 251 });
    });

    await expect(service.preparePayload(ASSOCIATION_EVENT, {
      tenantModels,
      tenant: {},
      tenantKey: 'multiquimica',
    })).rejects.toThrow('connection to mongo lost');

    expect(tenantModels.LineItemPriceWebhookEvent.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
