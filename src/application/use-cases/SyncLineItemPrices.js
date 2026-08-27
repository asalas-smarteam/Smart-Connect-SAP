import { calculateUnitPriceWithMisc } from '#domain/prices/misc-price-calculation.service.js';
import { resolveDiscount } from '#domain/products/discount-resolver.service.js';
import { createNoopSapCallRecorder } from '#application/services/sap-call-audit.service.js';

// Tope de llamadas grabadas para ESTE flujo. El default del grabador (40) se llena antes de la
// fase de escritura en un deal de ~13 líneas, así que justo las llamadas con más probabilidad de
// fallar (los batch a HubSpot, los search por SKU limitados a 5/s, el PATCH del deal) quedaban
// fuera del audit. Duplica a propósito el `MAX_AUDIT_CALLS` del serializador: application no
// puede importar infrastructure (tests/unit/architecture/hexagonalBoundaries.test.js).
const AUDIT_MAX_CALLS = 200;

const SAP_ITEM_PRICES_SELECT_PATH = '/b1s/v2/Items';
const DEFAULT_SAP_ITEM_SELECT_FIELDS = ['ItemPrices', 'ItemWarehouseInfoCollection'];

function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function formatCurrentDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function normalizeNumber(value, fallback = 0) {
  const normalized = Number(String(value ?? '').trim());
  return Number.isFinite(normalized) ? normalized : fallback;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeQuantity(value) {
  const normalized = normalizeNumber(value, 0);
  return normalized > 0 ? normalized : 1;
}

function roundCurrency(value) {
  return Math.round((normalizeNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function validatePayload(payload = {}) {
  if (!Array.isArray(payload.lineItems) || payload.lineItems.length === 0) {
    throw new Error('lineItems must be a non-empty array');
  }

  payload.lineItems.forEach((lineItem, index) => {
    if (!toNonEmptyString(lineItem?.itemCode)) {
      throw new Error(`lineItems[${index}].itemCode is required`);
    }

    if (!toNonEmptyString(lineItem?.id)) {
      throw new Error(`lineItems[${index}].id is required`);
    }
  });
}

function buildSapPricePayload({ cardCode, itemCode, date }) {
  return {
    ItemPriceParams: {
      ItemCode: itemCode,
      CardCode: cardCode,
      Date: date,
    },
  };
}

function buildItemSelectFields(taxFieldItem, includeGroupCode = false) {
  return [
    ...DEFAULT_SAP_ITEM_SELECT_FIELDS,
    includeGroupCode ? 'ItemsGroupCode' : null,
    toNonEmptyString(taxFieldItem),
  ].filter((field, index, fields) => field && fields.indexOf(field) === index);
}

function buildSapItemPricesPath(itemCode, selectFields = DEFAULT_SAP_ITEM_SELECT_FIELDS) {
  return `${SAP_ITEM_PRICES_SELECT_PATH}('${encodeURIComponent(String(itemCode))}')?$select=${selectFields.join(',')}`;
}

function selectConfiguredItemPrice(itemPrices, priceList, itemCode) {
  const selectedPrice = Array.isArray(itemPrices)
    ? itemPrices.find((itemPrice) => Number(itemPrice?.PriceList) === priceList)
    : null;

  if (!selectedPrice) {
    throw new Error(`Price list ${priceList} not found for item ${itemCode}`);
  }

  return selectedPrice;
}

// `unresolved` tiene que significar lo que dice su nombre. Dos razones por las que la simple
// concatenación de las dos listas de fallos miente:
//
// - La reconciliación reintenta toda línea que no quedó en `updatedIds`, y `resolveSapPricing`
//   sólo memoiza éxitos, así que una línea que falló en SAP en la ronda 1 se vuelve a pedir y
//   puede salir bien. Su entrada de la ronda 1 sigue en `roundFailures`, y dejarla acá diría
//   que quedó sin resolver una línea que sí se escribió.
// - Una línea que falla en las DOS rondas aparece en las dos listas, y saldría duplicada.
//
// El detalle por ronda no se pierde: sigue completo en `rounds[].failures`. Acá sólo se filtra.
//
// Las entradas SIN `id` no representan una línea -- el fallo de pasada completa
// `stage: 'reconciliation'` no trae `id` ni `itemCode` -- así que no se filtran ni se
// deduplican nunca. Los tres shapes (`hubspot_read`, `sap_price`, `reconciliation`) salen tal
// como entraron, sin normalizarse.
function collectUnresolvedFailures(roundFailures = [], reconciliation = {}) {
  const resolvedIds = new Set(
    (reconciliation?.priced ?? [])
      .map((line) => toNonEmptyString(line?.id))
      .filter(Boolean)
  );
  const seenIds = new Set();

  return [...roundFailures, ...(reconciliation?.failures ?? [])].filter((failure) => {
    const id = toNonEmptyString(failure?.id);

    if (!id) {
      return true;
    }

    if (resolvedIds.has(id) || seenIds.has(id)) {
      return false;
    }

    // Se conserva la PRIMERA aparición: es la evidencia más temprana del fallo.
    seenIds.add(id);
    return true;
  });
}

export class SyncLineItemPrices {
  constructor({
    credentialRepository,
    sapPriceClient,
    hubspotPriceClient,
    buildErrorResponseSnapshot,
    buildWebhookSyncErrorEntry,
    sapDiscountClient = null,
    dateProvider = () => new Date(),
    logger = { warn: () => {} },
    createSapCallRecorder = createNoopSapCallRecorder,
    buildLineItemPriceAudit = () => null,
  }) {
    this.credentialRepository = credentialRepository;
    this.sapPriceClient = sapPriceClient;
    this.hubspotPriceClient = hubspotPriceClient;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.sapDiscountClient = sapDiscountClient;
    this.dateProvider = dateProvider;
    this.logger = logger;
    this.createSapCallRecorder = createSapCallRecorder;
    this.buildLineItemPriceAudit = buildLineItemPriceAudit;
  }

  // Una sola entrada por itemCode: cardCode y fecha son fijos durante la invocación, así que
  // dos líneas del mismo producto comparten resultado. La caché también es la que le permite
  // a la reconciliación reescribir una línea sin volver a SAP.
  // `callRecorder` y `sapCache` llegan por parámetro y no viven en `this`: el caso de uso es
  // un singleton y guardarlos en la instancia mezclaría el tráfico de un tenant con otro.
  async resolveSapPricing({
    itemCode,
    sapCache,
    callRecorder,
    sapConfig,
    cardCode,
    currentDate,
    tenantKey,
    itemSelectFields,
    fallbackPriceList,
    useBusinessPartnerPrice,
    auditTrail,
  }) {
    const cached = sapCache.get(itemCode);

    if (cached) {
      return { ...cached, source: 'cache' };
    }

    let priceData;
    let sapItemData;

    if (useBusinessPartnerPrice) {
      const sapRequestPayload = buildSapPricePayload({ cardCode, itemCode, date: currentDate });
      auditTrail.payload_SAP.push(sapRequestPayload);

      priceData = await callRecorder.record(
        {
          target: 'sap',
          method: 'POST',
          path: '/b1s/v2/CompanyService_GetItemPrice',
          data: sapRequestPayload,
        },
        () => this.sapPriceClient.fetchBusinessPartnerPrice({
          sapConfig,
          cardCode,
          itemCode,
          date: currentDate,
          tenantKey,
          requestPayload: sapRequestPayload,
        })
      );
      auditTrail.response_SAP.push(priceData);

      sapItemData = await callRecorder.record(
        { target: 'sap', method: 'GET', path: buildSapItemPricesPath(itemCode, itemSelectFields) },
        () => this.sapPriceClient.fetchItemPrices({
          sapConfig,
          itemCode,
          tenantKey,
          selectFields: itemSelectFields,
        })
      );
    } else {
      const sapRequestPayload = {
        method: 'GET',
        endpoint: buildSapItemPricesPath(itemCode, itemSelectFields),
        priceList: fallbackPriceList,
      };
      auditTrail.payload_SAP.push(sapRequestPayload);

      sapItemData = await callRecorder.record(
        { target: 'sap', method: 'GET', path: sapRequestPayload.endpoint },
        () => this.sapPriceClient.fetchItemPrices({
          sapConfig,
          itemCode,
          tenantKey,
          selectFields: itemSelectFields,
        })
      );

      const selectedPrice = selectConfiguredItemPrice(
        sapItemData?.ItemPrices,
        fallbackPriceList,
        itemCode
      );

      priceData = {
        Price: selectedPrice?.Price ?? 0,
        Currency: selectedPrice?.Currency ?? null,
        Discount: 0,
        PriceList: selectedPrice?.PriceList ?? fallbackPriceList,
      };

      auditTrail.response_SAP.push({ ...sapItemData, selectedPrice });
    }

    const entry = { priceData, sapItemData };
    sapCache.set(itemCode, entry);

    return { ...entry, source: 'sap' };
  }

  // ÚNICA fuente del enriquecimiento de una línea, compartida por la ronda 1 y por la
  // reconciliación. Antes cada ronda tenía su copia y las copias divergieron: la ronda 2 perdió
  // el uplift de misc y el descuento de SAP, así que la pasada de SEGURIDAD escribía un precio
  // equivocado encima de uno correcto. Con una sola función esa clase de deriva no puede volver.
  //
  // `lineItem` llega en dos formas: la del payload de la ronda 1 (`quantity` o `Quantity`) y la
  // del lector tolerante de la ronda 2 (`quantity`, más los `extraProperties` en el nivel
  // superior). Las dos se normalizan acá.
  async buildEnrichedLineItem({
    lineItem,
    pricing,
    tenantModels,
    tenantKey,
    taxSettings,
    discountConfig,
    activeDiscountGroups,
    discountHsField,
    miscPriceCalculationConfig,
  }) {
    const itemCode = toNonEmptyString(lineItem.itemCode);
    const id = toNonEmptyString(lineItem.id);
    const { priceData, sapItemData: sapItemStockData } = pricing;

    const warehouseStockProperties = await this.credentialRepository.resolveWarehouseStockProperties({
      tenantModels,
      itemWarehouseInfoCollection: sapItemStockData?.ItemWarehouseInfoCollection,
    });
    const tax = taxSettings?.taxCodes?.find((entry) => toNonEmptyString(entry?.Code) === toNonEmptyString(sapItemStockData?.[taxSettings.fieldItem])) || {};

    // El descuento sale de SAP (grupos de descuento) o es 0. Nunca de la tasa de
    // impuesto: eso era `resolveTaxRate`, que escribía el Rate del código de
    // impuesto en el campo de descuento y se eliminó junto con este bloque.
    let finalDiscount = 0;

    // Un descuento que YA está en la línea de HubSpot gana sobre el de SAP: el asesor lo puso
    // a mano y SAP no lo conoce, así que resolver contra los grupos devolvería 0 y lo pisaría
    // en cada webhook. Solo un campo vacío o en 0 cae a la resolución de SAP.
    const discountReadProperty = discountHsField || 'discount';
    const existingHubspotDiscount = toNumberOrNull(
      lineItem?.[discountReadProperty] ?? lineItem?.properties?.[discountReadProperty]
    );

    if (existingHubspotDiscount !== null && existingHubspotDiscount !== 0) {
      finalDiscount = existingHubspotDiscount;
    } else if (discountConfig?.isRequired && (activeDiscountGroups ?? []).length > 0) {
      const sapDiscount = resolveDiscount(activeDiscountGroups, {
        itemCode,
        itemsGroupCode: sapItemStockData?.ItemsGroupCode,
        currentDate: this.dateProvider(),
      });
      if (sapDiscount !== null) {
        finalDiscount = sapDiscount;
      }
    }
    const quantity = normalizeQuantity(lineItem.quantity ?? lineItem.Quantity);
    const priceCalculation = calculateUnitPriceWithMisc({
      sapPrice: priceData?.Price ?? 0,
      lineItem,
      config: miscPriceCalculationConfig,
    });
    const price = priceCalculation.price;
    const lineTotal = roundCurrency(quantity * price);

    if (priceCalculation.warning) {
      this.logger.warn({
        msg: priceCalculation.warning,
        tenantKey,
        itemCode,
        lineItemId: id,
      });
    }

    return {
      itemCode,
      id,
      quantity,
      Price: price,
      ...(priceCalculation.originalPriceTargetProperty
        ? {
          originalPrice: priceCalculation.originalPrice,
          originalPriceTargetProperty: priceCalculation.originalPriceTargetProperty,
        }
        : {}),
      Currency: priceData?.Currency ?? null,
      Discount: finalDiscount,
      lineTotal,
      ...(toNonEmptyString(tax.HSCode) ? { tax: tax.HSCode } : {}),
      ...(discountHsField ? { _discountHsProperty: discountHsField } : {}),
      warehouseStockProperties,
    };
  }

  // Segunda pasada de seguridad, UNA sola vez. Existe porque el índice de asociaciones de
  // HubSpot va unos segundos atrasado: cuando el asesor quita o agrega líneas, la lectura de
  // la ronda 1 puede traer una línea ya archivada (404) o perderse una recién creada.
  //
  // Sólo corre si hay señal de que algo quedó mal: diferencia de cantidad, o una línea en
  // precio 0 que la caché de SAP contradice. Un 0 que SAP mismo reporta es correcto y no
  // dispara trabajo.
  async reconcile({
    token,
    dealId,
    updatedIds,
    sapCache,
    callRecorder,
    sapConfig,
    cardCode,
    currentDate,
    tenantKey,
    itemSelectFields,
    fallbackPriceList,
    useBusinessPartnerPrice,
    auditTrail,
    // Mismo objeto que usa la ronda 1: taxSettings, descuentos, misc, tenantModels y tenantKey
    // viajan juntos para que las dos rondas no puedan enriquecer con configuraciones distintas.
    enrichment,
  }) {
    const freshIds = await this.hubspotPriceClient.readDealLineItemIds({ token, dealId });
    // El `miscSourceProperty` del tenant NO es una propiedad estándar de HubSpot: si no se pide
    // acá, `calculateUnitPriceWithMisc` lo lee como null y devuelve el precio crudo de SAP.
    const miscSourceProperty = enrichment?.miscPriceCalculationConfig
      ?.enableMiscPriceCalculation === true
      ? toNonEmptyString(enrichment.miscPriceCalculationConfig?.miscSourceProperty)
      : null;
    // La propiedad de descuento se relee por la misma razón que misc: si la ronda 2 no la trae,
    // el enriquecimiento no ve el descuento manual del asesor y lo pisa con el de SAP.
    const discountReadProperty = enrichment?.discountHsField || 'discount';
    const { lineItems: freshLines, failures: readFailures } = await this.hubspotPriceClient
      .readLineItems({
        token,
        lineItemIds: freshIds,
        extraProperties: [miscSourceProperty, 'price', discountReadProperty].filter(Boolean),
      });

    const trigger = [];

    if (freshIds.length !== updatedIds.size) {
      trigger.push('count_mismatch');
    }

    const zeroPriceLines = freshLines.filter((line) => {
      if (normalizeNumber(line.price, 0) !== 0) {
        return false;
      }

      const cached = sapCache.get(line.itemCode);

      // El 0 viene de SAP: es correcto, no se toca.
      return !(cached && roundCurrency(cached.priceData?.Price ?? 0) === 0);
    });

    if (zeroPriceLines.length > 0) {
      trigger.push('zero_price');
    }

    if (trigger.length === 0) {
      return { triggered: false, trigger: [], priced: [], failures: readFailures, enriched: [] };
    }

    const pending = freshLines.filter(
      (line) => !updatedIds.has(String(line.id)) || zeroPriceLines.includes(line)
    );
    const enriched = [];
    const priced = [];
    const failures = [...readFailures];

    for (const line of pending) {
      let pricing;

      try {
        // eslint-disable-next-line no-await-in-loop
        pricing = await this.resolveSapPricing({
          itemCode: line.itemCode,
          sapCache,
          callRecorder,
          sapConfig,
          cardCode,
          currentDate,
          tenantKey,
          itemSelectFields,
          fallbackPriceList,
          useBusinessPartnerPrice,
          auditTrail,
        });
      } catch (error) {
        failures.push({
          id: String(line.id),
          itemCode: line.itemCode,
          stage: 'sap_price',
          reason: error.message,
          status: error?.response?.status ?? error?.details?.status ?? null,
        });
        // eslint-disable-next-line no-continue
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const enrichedLine = await this.buildEnrichedLineItem({
        lineItem: line,
        pricing,
        ...enrichment,
      });

      enriched.push(enrichedLine);
      priced.push({
        id: enrichedLine.id,
        itemCode: enrichedLine.itemCode,
        price: enrichedLine.Price,
        source: pricing.source,
      });
    }

    if (enriched.length > 0) {
      await callRecorder.record(
        { target: 'hubspot', method: 'POST', path: '/crm/v3/objects/line_items/batch/update' },
        () => this.hubspotPriceClient.updateLineItems({
          token,
          enrichedLineItems: enriched,
          tenantKey,
        })
      );
    }

    return { triggered: true, trigger, priced, failures, enriched };
  }

  async execute(payload, { tenantModels, tenant, tenantKey }) {
    const callRecorder = this.createSapCallRecorder({ maxCalls: AUDIT_MAX_CALLS });
    const auditTrail = {
      payload_Hubspot: payload,
      payload_SAP: [],
      response_hubspot: null,
      response_SAP: [],
    };
    // Los cuatro viven fuera del `try` porque el `catch` los LEE para armar
    // `error.lineItemPriceAudit`: `auditRounds` y `callRecorder` van directo al audit, y
    // `roundFailures` + `reconciliation` alimentan su `unresolved`.
    //
    // `roundFailures` se siembra ACÁ, antes de cualquier await, y no dentro del `try`: los
    // fallos `hubspot_read` que el lector tolerante de `preparePayload` ya dejó en el payload
    // son la evidencia del 404 por línea que este audit existe para capturar, y un fallo
    // temprano (credenciales, config, SAP caído en `fetchActiveDiscountGroups`) tira antes del
    // ciclo de la ronda 1. Si se sembrara adentro, ese camino escribiría el audit con
    // `rounds: []` y `unresolved: []`, o sea sin la evidencia.
    const auditRounds = [];
    const roundFailures = Array.isArray(payload?.lineItemFailures)
      ? [...payload.lineItemFailures]
      : [];
    let reconciliation = { triggered: false, trigger: [], priced: [], failures: [], enriched: [] };

    try {
      validatePayload(payload);

      const cardCode = toNonEmptyString(payload.cardCode);
      const dealId = toNonEmptyString(payload.dealId) || toNonEmptyString(payload.fromObjectId);
      const useBusinessPartnerPrice = Boolean(cardCode);
      const currentDate = formatCurrentDate(this.dateProvider());
      const hubspotCredentials = await this.credentialRepository.resolveHubspotCredentials({
        tenantModels,
        tenant,
      });
      const sapCredentials = await this.credentialRepository.resolveSapCredentials({
        tenantModels,
        hubspotCredentials,
      });
      const fallbackPriceList = useBusinessPartnerPrice
        ? null
        : await this.credentialRepository.resolveTenantPriceList({ tenantModels });
      const taxSettings = typeof this.credentialRepository.resolveTenantTaxSettings === 'function'
        ? await this.credentialRepository.resolveTenantTaxSettings({ tenantModels })
        : { fieldItem: null, taxCodes: [] };
      const miscPriceCalculationConfig = typeof this.credentialRepository.resolveMiscPriceCalculationConfig === 'function'
        ? await this.credentialRepository.resolveMiscPriceCalculationConfig({ tenantModels })
        : null;
      const discountConfig = typeof this.credentialRepository.resolveDiscountConfig === 'function'
        ? await this.credentialRepository.resolveDiscountConfig({ tenantModels })
        : { isRequired: false, fieldMappings: {} };
      const itemSelectFields = buildItemSelectFields(taxSettings?.fieldItem, discountConfig.isRequired);
      const sapCredentialsData = typeof sapCredentials?.toObject === 'function'
        ? sapCredentials.toObject()
        : sapCredentials;
      const sapConfig = {
        ...sapCredentialsData,
        tenantKey,
      };
      const discountHsField = discountConfig?.fieldMappings?.Discount ?? null;
      const activeDiscountGroups = discountConfig.isRequired && this.sapDiscountClient
        ? await this.sapDiscountClient.fetchActiveDiscountGroups({ sapConfig, tenantKey })
        : [];
      const sapCache = new Map();
      const enrichedLineItems = [];
      const pricedLog = [];
      // Contexto de enriquecimiento: lo comparten la ronda 1 y la reconciliación, así que las
      // dos escriben con la MISMA configuración de misc, impuestos y descuentos.
      const enrichment = {
        tenantModels,
        tenantKey,
        taxSettings,
        discountConfig,
        activeDiscountGroups,
        discountHsField,
        miscPriceCalculationConfig,
      };

      for (const lineItem of payload.lineItems) {
        const itemCode = toNonEmptyString(lineItem.itemCode);
        const id = toNonEmptyString(lineItem.id);
        let pricing;

        try {
          // eslint-disable-next-line no-await-in-loop
          pricing = await this.resolveSapPricing({
            itemCode,
            sapCache,
            callRecorder,
            sapConfig,
            cardCode,
            currentDate,
            tenantKey,
            itemSelectFields,
            fallbackPriceList,
            useBusinessPartnerPrice,
            auditTrail,
          });
        } catch (error) {
          // Una línea sin precio en SAP no puede dejar sin precio a las demás del deal.
          this.logger.warn({
            msg: 'Line item skipped: SAP price could not be resolved',
            tenantKey,
            lineItemId: id,
            itemCode,
            error: error.message,
          });
          roundFailures.push({
            id,
            itemCode,
            stage: 'sap_price',
            reason: error.message,
            status: error?.response?.status ?? error?.details?.status ?? null,
          });
          // eslint-disable-next-line no-continue
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        const enrichedLineItem = await this.buildEnrichedLineItem({
          lineItem,
          pricing,
          ...enrichment,
        });

        enrichedLineItems.push(enrichedLineItem);
        pricedLog.push({
          id: enrichedLineItem.id,
          itemCode: enrichedLineItem.itemCode,
          price: enrichedLineItem.Price,
          source: pricing.source,
        });
      }

      // Se empuja ANTES del fatal de abajo: si ninguna línea se valorizó, este es el único
      // lugar del audit que dice por qué falló cada una.
      auditRounds.push({
        round: 1,
        // Del payload, no del deal: las líneas que fallaron `hubspot_read` no están acá (viajan
        // en `failures`), así que llamarlo "FromDeal" haría concluir que el deal tenía menos
        // líneas de las que tenía.
        lineItemIdsInPayload: payload.lineItems.map((line) => String(line.id)),
        priced: pricedLog,
        failures: roundFailures,
      });

      if (enrichedLineItems.length === 0) {
        throw new Error('No line item prices could be resolved for this deal');
      }

      const token = await this.hubspotPriceClient.getAccessToken({
        hubspotCredentials,
        tenantModels,
      });
      const hubspotUpdate = await callRecorder.record(
        { target: 'hubspot', method: 'POST', path: '/crm/v3/objects/line_items/batch/update' },
        () => this.hubspotPriceClient.updateLineItems({ token, enrichedLineItems, tenantKey })
      );
      const hubspotProductUpdate = await callRecorder.record(
        { target: 'hubspot', method: 'POST', path: '/crm/v3/objects/products/batch/update' },
        () => this.hubspotPriceClient.updateProducts({ token, enrichedLineItems, tenantKey, callRecorder })
      );

      auditTrail.response_hubspot = {
        lineItems: {
          payload: hubspotUpdate.payload,
          response: hubspotUpdate.response,
        },
        products: {
          payload: hubspotProductUpdate.payload,
          response: hubspotProductUpdate.response,
        },
      };

      const updatedIds = new Set(
        (Array.isArray(hubspotUpdate.response?.results)
          ? hubspotUpdate.response.results.map((entry) => String(entry?.id))
          : hubspotUpdate.payload.inputs.map((input) => String(input.id))
        ).filter(Boolean)
      );

      // La reconciliación es una pasada de seguridad best-effort: si se cae (la relectura del
      // deal SÍ lanza, por diseño), no puede tirar a la basura una ronda 1 que ya escribió los
      // precios bien. Se registra el fallo, se marca `aborted` y la ejecución sigue para que el
      // amount se escriba con lo que sí se valorizó.
      if (dealId) {
        try {
          reconciliation = await this.reconcile({
            token, dealId, updatedIds, sapCache, callRecorder, sapConfig, cardCode,
            currentDate, tenantKey, itemSelectFields, fallbackPriceList,
            useBusinessPartnerPrice, auditTrail, enrichment,
          });
        } catch (error) {
          this.logger.warn({
            msg: 'Reconciliation pass aborted: deal line items could not be re-read',
            tenantKey,
            dealId,
            error: error.message,
          });
          reconciliation = {
            triggered: false,
            trigger: [],
            priced: [],
            enriched: [],
            aborted: true,
            failures: [{
              stage: 'reconciliation',
              reason: error.message,
              status: error?.details?.status ?? error?.response?.status ?? null,
              endpoint: error?.details?.endpoint ?? null,
            }],
          };
        }
      }

      if (reconciliation.triggered) {
        auditRounds.push({
          round: 2,
          trigger: reconciliation.trigger,
          priced: reconciliation.priced,
          failures: reconciliation.failures,
        });
      }

      let dealUpdate = null;
      // El amount se escribe al cierre y una sola vez, con lo que se pudo valorizar en las dos
      // rondas: es preferible un total parcial a dejar el deal con el amount viejo.
      const allPricedLines = [...enrichedLineItems, ...reconciliation.enriched];
      const totalAmount = roundCurrency(
        allPricedLines.reduce((sum, line) => sum + line.lineTotal, 0)
      );

      if (dealId) {
        dealUpdate = await callRecorder.record(
          { target: 'hubspot', method: 'PATCH', path: `/crm/v3/objects/deals/${dealId}` },
          () => this.hubspotPriceClient.updateDealAmount({ token, dealId, totalAmount, tenantKey })
        );

        auditTrail.response_hubspot.deal = {
          payload: dealUpdate.payload,
          response: dealUpdate.response,
        };
      }

      return {
        data: {
          cardCode,
          dealId,
          totalAmount,
          lineItems: enrichedLineItems,
        },
        meta: {
          requestedCount: hubspotUpdate.payload.inputs.length,
          updatedCount: Array.isArray(hubspotUpdate.response?.results)
            ? hubspotUpdate.response.results.length
            : hubspotUpdate.payload.inputs.length,
          productsRequestedCount: hubspotProductUpdate.payload.inputs.length,
          productsUpdatedCount: Array.isArray(hubspotProductUpdate.response?.results)
            ? hubspotProductUpdate.response.results.length
            : hubspotProductUpdate.payload.inputs.length,
          skippedCount: roundFailures.length,
          dealUpdated: Boolean(dealUpdate),
          reconciliation: {
            triggered: reconciliation.triggered,
            trigger: reconciliation.trigger,
            pricedCount: reconciliation.priced.length,
            // Distingue "no hizo falta correr" de "corrió y no pudo".
            aborted: Boolean(reconciliation.aborted),
            failures: reconciliation.failures,
          },
        },
        audit: this.buildLineItemPriceAudit({
          dealId,
          cardCode,
          rounds: auditRounds,
          calls: callRecorder.calls,
          // Lo que el grabador ya descartó por su propio tope: sin esto el audit informa 0.
          droppedCalls: callRecorder.droppedCalls,
          unresolved: collectUnresolvedFailures(roundFailures, reconciliation),
          amount: { written: Boolean(dealUpdate), total: totalAmount },
        }),
      };
    } catch (error) {
      const errorSnapshot = this.buildErrorResponseSnapshot(error);
      const message = String(error?.message || '').toLowerCase();
      const responseHubspot = message.includes('hubspot')
        ? {
          ...(auditTrail.response_hubspot || {}),
          error: errorSnapshot,
        }
        : auditTrail.response_hubspot;
      const responseSap = auditTrail.response_SAP.length > 0
        ? [...auditTrail.response_SAP]
        : [];

      if (!responseHubspot && !message.includes('hubspot') && errorSnapshot) {
        responseSap.push(errorSnapshot);
      }

      error.syncLogWebhookErrors = [
        this.buildWebhookSyncErrorEntry({
          payloadHubspot: auditTrail.payload_Hubspot,
          payloadSap: auditTrail.payload_SAP,
          responseHubspot,
          responseSap,
        }),
      ];

      error.lineItemPriceAudit = this.buildLineItemPriceAudit({
        dealId: toNonEmptyString(payload?.dealId) || toNonEmptyString(payload?.fromObjectId),
        cardCode: toNonEmptyString(payload?.cardCode),
        rounds: auditRounds,
        calls: callRecorder.calls,
        droppedCalls: callRecorder.droppedCalls,
        // Mismo filtro que el camino de éxito: un fallo tardío (el PATCH del amount) ocurre
        // DESPUÉS de la reconciliación, así que acá también hay líneas que la ronda 2 resolvió.
        unresolved: collectUnresolvedFailures(roundFailures, reconciliation),
        fatalError: {
          message: error.message,
          status: error?.details?.status ?? error?.response?.status ?? null,
          endpoint: error?.details?.endpoint ?? null,
        },
      });

      throw error;
    }
  }
}

export default SyncLineItemPrices;
