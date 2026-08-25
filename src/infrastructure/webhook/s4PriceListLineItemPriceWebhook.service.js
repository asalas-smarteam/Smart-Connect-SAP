import hubspotAuthService from '../hubspot/hubspotAuthService.js';
import tenantConfigurationService from '../config/tenantConfiguration.service.js';
import logger from '../logger/logger.js';
import lineItemPriceWebhookService from './lineItemPriceWebhook.service.js';
import {
  assertRequiredWebhookField,
  buildDuplicateFilter,
  extractAssociationIds,
  extractLineItemAssociationIds,
  fetchHubspotObject as defaultFetchHubspotObject,
  readLineItems as defaultReadLineItems,
  resolveHubspotCredentials as defaultResolveHubspotCredentials,
  toNonEmptyString,
  toNumberOrNull,
} from './lineItemPriceWebhook.shared.js';

const SUPPORTED_ASSOCIATION_TYPE = 'DEAL_TO_LINE_ITEM';
const SUPPORTED_ASSOCIATION_CHANGE_SOURCE = 'USER';
const SUPPORTED_LINE_ITEM_SUBSCRIPTION = 'line_item.propertyChange';
const SUPPORTED_LINE_ITEM_PROPERTY = 'quantity';
// CRM_UI evita bucles: las escrituras del propio integrador llegan con changeSource INTEGRATION.
const SUPPORTED_PROPERTY_CHANGE_SOURCE = 'CRM_UI';

// Propiedades del negocio que declaran el área de ventas y la moneda. En constantes exportadas
// y no como literales en la llamada, para que el test asierte contra la misma fuente que el
// código: si el nombre cambia en el portal, se cambia acá y el test sigue siendo válido.
export const DEAL_SALES_ORG_PROPERTY = 'sales_organization';
export const DEAL_DISTRIBUTION_CHANNEL_PROPERTY = 'distribution_channel';
export const DEAL_CURRENCY_PROPERTY = 'deal_currency_code';

const DEBOUNCE_CONFIG_KEY = 'requireSkippedInWebhooksInPropertyChange';
const DEBOUNCE_DEFAULT = { requireSkipped: true, secondsToSkipped: 3 };
const DUPLICATE_ERROR_MESSAGE = 'Duplicate event';
const DEBOUNCED_ERROR_MESSAGE = 'evento skipeado por envios multiples';

function skipResult(reason, extraMeta = {}) {
  return {
    skip: true,
    payload: null,
    executionId: null,
    meta: { skipped: true, reason, ...extraMeta },
  };
}

function classifyEvent(payload = {}) {
  if (
    payload?.associationType === SUPPORTED_ASSOCIATION_TYPE
    && payload?.changeSource === SUPPORTED_ASSOCIATION_CHANGE_SOURCE
  ) {
    return 'association';
  }

  if (
    payload?.subscriptionType === SUPPORTED_LINE_ITEM_SUBSCRIPTION
    && payload?.propertyName === SUPPORTED_LINE_ITEM_PROPERTY
    && payload?.changeSource === SUPPORTED_PROPERTY_CHANGE_SOURCE
  ) {
    return 'lineItemPropertyChange';
  }

  return null;
}

// El número de cliente de S/4 (`Customer` / `BusinessPartner`) viaja en HubSpot en `idsap`,
// igual que el CardCode de B1: mismo mecanismo, company primero y contacto como respaldo.
function resolveObjectIdSap(record) {
  return toNonEmptyString(record?.properties?.idsap)
    || toNonEmptyString(record?.properties?.idSap);
}

export class S4PriceListLineItemPriceWebhookService {
  constructor({
    hubspotAuth = hubspotAuthService,
    tenantConfiguration = tenantConfigurationService,
    resolveHubspotCredentials = defaultResolveHubspotCredentials,
    fetchHubspotObject = defaultFetchHubspotObject,
    readLineItems = defaultReadLineItems,
    log = logger,
  } = {}) {
    this.hubspotAuth = hubspotAuth;
    this.tenantConfiguration = tenantConfiguration;
    this.resolveHubspotCredentials = resolveHubspotCredentials;
    this.fetchHubspotObject = fetchHubspotObject;
    this.readLineItems = readLineItems;
    this.log = log;
  }

  async preparePayload(payload, { tenantModels, tenant, tenantKey }) {
    const eventKind = classifyEvent(payload);

    if (!eventKind) {
      return skipResult('unsupported_event');
    }

    assertRequiredWebhookField(payload, 'portalId');
    assertRequiredWebhookField(payload, 'eventId');
    assertRequiredWebhookField(payload, 'subscriptionId');
    assertRequiredWebhookField(payload, 'appId');
    assertRequiredWebhookField(payload, 'occurredAt');
    assertRequiredWebhookField(payload, eventKind === 'association' ? 'fromObjectId' : 'objectId');

    const { LineItemPriceWebhookEvent } = tenantModels;
    const duplicateFilter = this.buildDuplicateFilterFor(payload, eventKind);
    const duplicate = await this.findDuplicate(LineItemPriceWebhookEvent, payload, eventKind);

    if (duplicate) {
      // A diferencia del flujo B1, acá NO se inserta un documento marca de duplicado. El
      // esquema tiene un índice ÚNICO sobre (eventId, subscriptionId, portalId, appId,
      // occurredAt, fromObjectId) y los eventos de asociación traen las seis claves, así que
      // ese insert choca con E11000 y la excepción reemplaza al skip. El duplicado ya está
      // identificado por el documento que encontró findDuplicate.
      this.log.info?.({
        msg: 'S4 line item price webhook: duplicate event ignored',
        reason: DUPLICATE_ERROR_MESSAGE,
        duplicateOf: String(duplicate._id),
        eventKind,
      });

      return skipResult('duplicate_event', { duplicateOf: String(duplicate._id) });
    }

    const token = await this.resolveToken({ tenantModels, tenant });
    const dealId = await this.resolveDealId(payload, eventKind, token);

    if (!dealId) {
      await LineItemPriceWebhookEvent.create({
        payload,
        isSend: false,
        errorMessage: 'Line item has no associated deal',
      });

      throw new Error('Line item has no associated deal');
    }

    const debounced = await this.isDebounced(LineItemPriceWebhookEvent, dealId, tenantModels);

    if (debounced) {
      // Tampoco se inserta marca acá, por el mismo índice único: la ventana de debounce solo
      // cuenta documentos con errorMessage null, así que la marca no aportaba nada al cálculo.
      this.log.info?.({
        msg: 'S4 line item price webhook: event debounced',
        reason: DEBOUNCED_ERROR_MESSAGE,
        dealId,
        eventKind,
      });

      return skipResult('debounced_event', { dealId });
    }

    // Se crea ANTES de leer HubSpot por dos razones: los webhooks concurrentes del mismo deal
    // se debouncean contra este registro, y un fallo de lectura (deal sin cliente, líneas
    // ilegibles) queda asentado en el evento en vez de morir solo en el SyncLog. El recálculo
    // es idempotente: siempre parte de los precios de SAP.
    let createdEvent;

    try {
      createdEvent = await LineItemPriceWebhookEvent.create({
        payload,
        dealId,
        isSend: false,
        errorMessage: null,
      });
    } catch (error) {
      if (error?.code !== 11000) {
        throw error;
      }

      // El create() chocó con el índice único, así que YA existe un documento con estas claves
      // de evento. findDuplicate no lo vio porque exige `isSend: true` o `errorMessage: null`,
      // o sea que el caso frecuente que llega acá es el REINTENTO SECUENCIAL de HubSpot sobre
      // una entrega que ya falló (isSend false + errorMessage no nulo). Tratarlo como duplicado
      // devolvía 200, HubSpot dejaba de reintentar y el negocio se quedaba con los precios
      // viejos sin error en ninguna parte. Tres casos distintos:
      //
      //   1. intento anterior FALLADO  -> se reclama el registro y se sigue procesando
      //   2. `errorMessage: null`      -> otra entrega en vuelo lo va a procesar: skip
      //   3. `isSend: true`            -> duplicado real de un evento ya procesado: skip
      //
      // La reclamación es un único findOneAndUpdate condicionado a que el registro siga
      // fallado: dos reintentos simultáneos no pueden reclamarlo los dos, el perdedor recibe
      // null y cae al skip por "en vuelo".
      const claimed = await this.claimFailedAttempt(
        LineItemPriceWebhookEvent,
        duplicateFilter,
        dealId
      );

      if (!claimed) {
        const existing = await this.findDuplicate(LineItemPriceWebhookEvent, payload, eventKind);

        this.log.info?.({
          msg: 'S4 line item price webhook: duplicate event race on insert',
          reason: DUPLICATE_ERROR_MESSAGE,
          duplicateOf: existing ? String(existing._id) : null,
          dealId,
          eventKind,
        });

        return skipResult('duplicate_event', { raceCondition: true, dealId });
      }

      this.log.info?.({
        msg: 'S4 line item price webhook: failed attempt reclaimed for reprocessing',
        executionId: String(claimed._id),
        dealId,
        eventKind,
      });

      createdEvent = claimed;
    }

    try {
      // `properties` explícitas: sin ellas HubSpot devuelve su set por defecto, que NO incluye
      // las dos propiedades del área de ventas. Nada más abajo depende de una propiedad del deal
      // que llegara por default — `resolveCustomer` usa las asociaciones y hace sus propios GET a
      // company/contact con `properties: ['idsap', 'idSap']`, y `extractLineItemAssociationIds`
      // también lee asociaciones, no propiedades.
      const deal = await this.fetchHubspotObject(token, 'deals', dealId, {
        properties: [
          DEAL_SALES_ORG_PROPERTY,
          DEAL_DISTRIBUTION_CHANNEL_PROPERTY,
          DEAL_CURRENCY_PROPERTY,
        ],
        associations: ['companies', 'contacts', 'line_items'],
      });
      const salesOrganization = toNonEmptyString(
        deal?.properties?.[DEAL_SALES_ORG_PROPERTY]
      )?.toUpperCase() ?? null;
      // El canal NO se pasa a mayúsculas ni se re-normaliza: SAP lo devuelve como '01' y así
      // tiene que viajar, tanto al $filter como a la clave del mapa de listas por defecto.
      const distributionChannel = toNonEmptyString(
        deal?.properties?.[DEAL_DISTRIBUTION_CHANNEL_PROPERTY]
      );
      const dealCurrency = toNonEmptyString(
        deal?.properties?.[DEAL_CURRENCY_PROPERTY]
      )?.toUpperCase() ?? null;
      // El cliente se resuelve ANTES de tocar las líneas: sin cliente no hay lista de precios
      // que aplicar y el evento se rechaza sin importar el estado de las líneas.
      const customer = await this.resolveCustomer(token, deal);

      if (!customer) {
        throw new Error('Deal has no associated SAP customer (idsap on company or contact)');
      }

      const lineItemIds = extractLineItemAssociationIds(deal);

      if (lineItemIds.length === 0) {
        throw new Error('Deal has no associated line items');
      }

      const { lineItems, failures } = await this.readLineItems({ token, lineItemIds });

      if (lineItems.length === 0) {
        // Los fallos van PEGADOS al error: son los que llevan endpoint y status de cada 404.
        throw Object.assign(new Error('Deal has no readable line items'), {
          lineItemFailures: failures,
        });
      }

      return {
        skip: false,
        payload: {
          dealId,
          customer,
          salesOrganization,
          distributionChannel,
          dealCurrency,
          lineItems: lineItems.map((lineItem) => ({
            id: lineItem.id,
            itemCode: lineItem.itemCode,
            quantity: lineItem.quantity,
          })),
          lineItemFailures: failures,
        },
        executionId: createdEvent._id,
        meta: { eventKind, dealId, customer, salesOrganization, distributionChannel },
      };
    } catch (error) {
      await LineItemPriceWebhookEvent.updateOne(
        { _id: createdEvent._id },
        { $set: { isSend: false, errorMessage: error.message } }
      );

      throw error;
    }
  }

  async resolveToken({ tenantModels, tenant }) {
    const hubspotCredentials = await this.resolveHubspotCredentials(tenantModels, tenant);

    return this.hubspotAuth.getAccessToken(
      hubspotCredentials.clientConfigId,
      hubspotCredentials,
      tenantModels
    );
  }

  async resolveDealId(payload, eventKind, token) {
    if (eventKind === 'association') {
      return toNonEmptyString(payload.fromObjectId);
    }

    const lineItem = await this.fetchHubspotObject(token, 'line_items', payload.objectId, {
      associations: ['deals'],
    });

    return extractAssociationIds(lineItem, 'deals')[0] ?? null;
  }

  async resolveCustomer(token, deal) {
    const companyIds = extractAssociationIds(deal, 'companies');

    if (companyIds.length > 0) {
      const company = await this.fetchHubspotObject(token, 'companies', companyIds[0], {
        properties: ['idsap', 'idSap'],
      });
      const customer = resolveObjectIdSap(company);

      if (customer) {
        return customer;
      }
    }

    const contactIds = extractAssociationIds(deal, 'contacts');

    if (contactIds.length > 0) {
      const contact = await this.fetchHubspotObject(token, 'contacts', contactIds[0], {
        properties: ['idsap', 'idSap'],
      });

      return resolveObjectIdSap(contact);
    }

    return null;
  }

  // Un solo lugar donde se decide qué identifica al evento: lo usan el guard de duplicados y la
  // reclamación del intento fallido, y tienen que mirar EXACTAMENTE el mismo documento.
  buildDuplicateFilterFor(payload, eventKind) {
    return eventKind === 'association'
      ? buildDuplicateFilter(payload)
      : {
        'payload.objectId': payload.objectId,
        'payload.sourceId': payload.sourceId,
        'payload.propertyValue': payload.propertyValue,
        'payload.occurredAt': payload.occurredAt,
      };
  }

  async findDuplicate(LineItemPriceWebhookEvent, payload, eventKind) {
    return LineItemPriceWebhookEvent.findOne({
      ...this.buildDuplicateFilterFor(payload, eventKind),
      $or: [{ isSend: true }, { errorMessage: null }],
    }).select({ _id: 1 }).lean();
  }

  // Reclama el registro de un intento fallido NUESTRO para reprocesarlo, de forma atómica.
  //
  // El filtro es la negación exacta del guard de duplicados: sólo `isSend: false` con
  // `errorMessage` no nulo es un fallo propio reintentable. `isSend: true` es un evento ya
  // procesado y `errorMessage: null` es uno en vuelo, y ninguno de los dos se toca.
  //
  // Va en un único findOneAndUpdate y no en un findOne + updateOne porque dos reintentos
  // simultáneos leerían los dos el mismo registro fallido y lo procesarían los dos. Acá el
  // `$set` es parte de la condición, así que sólo uno gana; el otro recibe null.
  //
  // El `$set` pone `errorMessage` en null (= en vuelo, que es lo que hace que el guard y el
  // debounce descarten al perdedor) y estampa el `dealId`, que el registro fallido puede no
  // tener: sin él el índice {dealId, createdAt} no sirve para reconstruir la historia del deal.
  async claimFailedAttempt(LineItemPriceWebhookEvent, duplicateFilter, dealId) {
    return LineItemPriceWebhookEvent.findOneAndUpdate(
      {
        ...duplicateFilter,
        isSend: false,
        errorMessage: { $ne: null },
      },
      { $set: { errorMessage: null, dealId } },
      { new: true, projection: { _id: 1 } }
    ).lean();
  }

  async isDebounced(LineItemPriceWebhookEvent, dealId, tenantModels) {
    const debounceConfig = await this.tenantConfiguration.getValue(
      tenantModels,
      DEBOUNCE_CONFIG_KEY,
      DEBOUNCE_DEFAULT
    );

    if (debounceConfig?.requireSkipped !== true) {
      return false;
    }

    const secondsToSkipped = toNumberOrNull(debounceConfig?.secondsToSkipped)
      ?? DEBOUNCE_DEFAULT.secondsToSkipped;

    const recentExecution = await LineItemPriceWebhookEvent.findOne({
      dealId,
      createdAt: { $gte: new Date(Date.now() - secondsToSkipped * 1000) },
      errorMessage: null,
    }).select({ _id: 1 }).lean();

    return Boolean(recentExecution);
  }

  // Persistencia del cierre del evento: se delega en el servicio B1 sin modificarlo, porque
  // escribe sobre el mismo modelo LineItemPriceWebhookEvent y ya pasa el audit por persistAudit.
  markAsSent(LineItemPriceWebhookEvent, executionId, audit = null) {
    return lineItemPriceWebhookService.markAsSent(LineItemPriceWebhookEvent, executionId, audit);
  }

  markAsError(LineItemPriceWebhookEvent, executionId, error, audit = null) {
    return lineItemPriceWebhookService.markAsError(
      LineItemPriceWebhookEvent,
      executionId,
      error,
      audit
    );
  }
}

export const s4PriceListLineItemPriceWebhookService = new S4PriceListLineItemPriceWebhookService();

export default s4PriceListLineItemPriceWebhookService;
