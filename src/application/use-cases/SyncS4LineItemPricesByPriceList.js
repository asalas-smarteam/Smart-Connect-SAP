import { resolveS4PriceForMaterial } from '#domain/prices/s4-price-resolution.service.js';
import { normalizeNumber, toNonEmptyString } from '#shared/utils/string.utils.js';

const NO_PRICE_REASON = 'no ZPR0 condition record for the customer price list,'
  + ' the default price list or the product default';

// Valor que se escribe en `priceListProperty` cuando el precio NO salió de una lista de precios
// sino del default del producto (tablas 501/504, sin PriceListType). La propiedad se escribe
// SIEMPRE: si se dejaba sin escribir, la línea conservaba la etiqueta de la corrida anterior
// (decía `ZC`) al lado de un precio que no es de ZC. Está documentado en
// configuration_examples.md; si la propiedad del portal es un desplegable, hay que darle esta
// opción además de las listas.
export const PRODUCT_DEFAULT_PRICE_LIST_LABEL = 'PRODUCT_DEFAULT';

function normalizeQuantity(value) {
  const normalized = normalizeNumber(value, 0);
  return normalized > 0 ? normalized : 1;
}

function roundCurrency(value) {
  return Math.round((normalizeNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function toSalesArea(row) {
  return {
    salesOrganization: toNonEmptyString(row?.SalesOrganization)?.toUpperCase() ?? null,
    distributionChannel: toNonEmptyString(row?.DistributionChannel) ?? null,
    division: toNonEmptyString(row?.Division)?.toUpperCase() ?? null,
  };
}

// Forma legible para los mensajes de error: son lo único que el operador ve cuando la config no
// calza, así que tienen que mostrar los dos lados de la comparación campo por campo.
function describeSalesArea(salesArea) {
  return [
    toNonEmptyString(salesArea?.salesOrganization)?.toUpperCase() ?? '(empty)',
    toNonEmptyString(salesArea?.distributionChannel) ?? '(empty)',
    toNonEmptyString(salesArea?.division)?.toUpperCase() ?? '(empty)',
  ].join('/');
}

function describeSalesAreaRows(rows) {
  return rows.map((row) => describeSalesArea(toSalesArea(row))).join(', ');
}

// `division` se compara SOLO cuando los dos lados la traen.
//
// Por qué: hay clientes cuyas filas de A_CustomerSalesArea llegan con `Division` vacía. Si la
// comparación exigiera los tres campos, ese cliente no tendría configuración posible — sin
// `division` en la config el área colapsaba a null y el error pedía "configurá salesArea"
// aunque estuviera configurada, y con `division` el error decía que no pertenece al cliente.
// Ignorarla no afloja el filtro contra SAP: `division` nunca entra al $filter de las
// condiciones (ruling de Task 2), sólo sirve para desempatar entre áreas del mismo cliente. Si
// después de ignorarla quedan dos áreas empatadas, se falla explícitamente pidiendo la división
// en vez de elegir una al azar.
function matchesSalesArea(rowSalesArea, configuredSalesArea) {
  const wantedOrg = toNonEmptyString(configuredSalesArea?.salesOrganization)?.toUpperCase() ?? null;
  const wantedChannel = toNonEmptyString(configuredSalesArea?.distributionChannel) ?? null;
  const wantedDivision = toNonEmptyString(configuredSalesArea?.division)?.toUpperCase() ?? null;

  if (rowSalesArea.salesOrganization !== wantedOrg
    || rowSalesArea.distributionChannel !== wantedChannel) {
    return false;
  }

  if (!wantedDivision || !rowSalesArea.division) {
    return true;
  }

  return rowSalesArea.division === wantedDivision;
}

// Un cliente puede tener una lista de precios distinta por organización de ventas (100053 es
// ZD en CPDO y ZB en DPDO), así que con más de un área hay que elegir explícitamente. Con una
// sola se usa la del cliente y la config no interviene: es el caso simple y no queremos que
// una config vieja lo rompa.
function chooseSalesAreaRow(rows, configuredSalesArea, customer) {
  if (rows.length === 0) {
    throw new Error(`Customer ${customer} has no sales areas in SAP`);
  }

  if (rows.length === 1) {
    return rows[0];
  }

  if (!configuredSalesArea) {
    throw new Error(
      `Customer ${customer} has ${rows.length} sales areas in SAP`
      + ` (${describeSalesAreaRows(rows)});`
      + ' configure s4PriceList.salesArea (salesOrganization/distributionChannel/division,'
      + ' division optional) to choose one'
    );
  }

  const matches = rows.filter((row) => matchesSalesArea(toSalesArea(row), configuredSalesArea));

  if (matches.length === 0) {
    throw new Error(
      `Configured s4PriceList.salesArea ${describeSalesArea(configuredSalesArea)} does not belong`
      + ` to customer ${customer}; the customer sales areas are:`
      + ` ${describeSalesAreaRows(rows)} (salesOrganization/distributionChannel/division)`
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `Configured s4PriceList.salesArea ${describeSalesArea(configuredSalesArea)} matches`
      + ` ${matches.length} sales areas of customer ${customer}`
      + ` (${describeSalesAreaRows(matches)}); add s4PriceList.salesArea.division to choose one`
    );
  }

  return matches[0];
}

export class SyncS4LineItemPricesByPriceList {
  constructor({
    credentialRepository,
    createPriceListClient,
    hubspotPriceClient,
    buildErrorResponseSnapshot,
    buildWebhookSyncErrorEntry,
    buildLineItemPriceAudit = () => null,
    createSapCallRecorder = () => ({ record: (_options, run) => run(), calls: [], droppedCalls: 0 }),
    dateProvider,
    logger = { warn: () => {} },
  }) {
    // Sin default: la fecha decide qué condiciones de SAP están vigentes, y un default silencioso
    // acá no se distingue del cableado real desde ningún test (el patrón del parámetro que quedó
    // sin cablear con la suite en verde ya pasó tres veces en este repo). Se exige explícita para
    // que la composición no pueda dejar de pasarla sin que algo falle.
    if (typeof dateProvider !== 'function') {
      throw new Error('dateProvider is required for SyncS4LineItemPricesByPriceList');
    }

    this.credentialRepository = credentialRepository;
    this.createPriceListClient = createPriceListClient;
    this.hubspotPriceClient = hubspotPriceClient;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildLineItemPriceAudit = buildLineItemPriceAudit;
    this.createSapCallRecorder = createSapCallRecorder;
    this.dateProvider = dateProvider;
    this.logger = logger;
  }

  async execute(payload, { tenantModels, tenant, tenantKey }) {
    const dealId = toNonEmptyString(payload?.dealId);
    const customer = toNonEmptyString(payload?.customer);
    const lineItems = Array.isArray(payload?.lineItems) ? payload.lineItems : [];
    // El grabador se crea por invocación y viaja por parámetro, nunca en `this`: el caso de
    // uso es singleton en composition y guardarlo mezclaría el tráfico de un tenant con otro.
    const callRecorder = this.createSapCallRecorder();
    const auditTrail = {
      dealId,
      cardCode: customer,
      rounds: [],
      calls: callRecorder.calls,
      unresolved: Array.isArray(payload?.lineItemFailures) ? payload.lineItemFailures : [],
      amount: null,
      fatalError: null,
    };

    try {
      if (!dealId) {
        throw new Error('dealId is required');
      }

      if (!customer) {
        throw new Error('customer is required');
      }

      if (lineItems.length === 0) {
        throw new Error('lineItems must be a non-empty array');
      }

      const config = await this.credentialRepository.resolveS4PriceListConfig({ tenantModels });

      // La tarifa de SAP NO se convierte de moneda, y toda esa decisión se apoya en que la
      // moneda quede registrada en alguna parte. `Currency` del line item enriquecido no lo lee
      // nadie al armar el payload de HubSpot: la única señal en el CRM es `currencyProperty`.
      // Sin esa clave, un negocio en DOP puede recibir un precio en USD sin ningún rastro, así
      // que se avisa en CADA corrida (no se falla: el flujo sigue siendo útil sin la propiedad).
      if (!config.currencyProperty) {
        this.logger.warn?.({
          msg: 'S4 line item prices: s4PriceList.currencyProperty is not configured;'
            + ' the SAP condition currency will not be written anywhere in HubSpot',
          tenantKey,
          dealId,
          customer,
        });
      }

      const hubspotCredentials = await this.credentialRepository.resolveHubspotCredentials({
        tenantModels,
        tenant,
      });
      const sapCredentials = await this.credentialRepository.resolveSapCredentials({
        tenantModels,
        hubspotCredentials,
      });
      const token = await this.hubspotPriceClient.getAccessToken({
        hubspotCredentials,
        tenantModels,
      });
      const sapConfig = {
        ...(typeof sapCredentials?.toObject === 'function' ? sapCredentials.toObject() : sapCredentials),
        tenantKey,
      };
      const priceListClient = this.createPriceListClient({ sapConfig });
      const salesAreaRows = await callRecorder.record(
        { target: 'sap', method: 'GET', path: '/API_BUSINESS_PARTNER/A_CustomerSalesArea', params: { customer } },
        () => priceListClient.fetchCustomerSalesAreas(customer)
      );
      const salesAreaRow = chooseSalesAreaRow(
        Array.isArray(salesAreaRows) ? salesAreaRows : [],
        config.salesArea,
        customer
      );
      const salesArea = toSalesArea(salesAreaRow);
      // Vacío es un dato, no un error: 40 de los 5000 clientes revisados no tienen lista.
      //
      // Se guardan SEPARADAS la lista del cliente y la efectiva: al dominio se le pasa la del
      // cliente tal cual (null si no tiene), porque si se le pasaba la de config disfrazada de
      // lista del cliente, el `source` del resultado decía `customerPriceList` para un precio
      // que en realidad salió del default de config. La efectiva es sólo para reportar.
      const customerPriceListType = toNonEmptyString(salesAreaRow?.PriceListType)?.toUpperCase()
        ?? null;
      const effectivePriceListType = customerPriceListType ?? config.defaultPriceListType;
      const date = this.dateProvider();
      const candidatesByMaterial = new Map();
      const enrichedLineItems = [];
      const skippedLineItems = [];

      for (const lineItem of lineItems) {
        const itemCode = toNonEmptyString(lineItem?.itemCode);
        const id = toNonEmptyString(lineItem?.id);

        if (!itemCode || !id) {
          skippedLineItems.push({
            id: id ?? null,
            itemCode: itemCode ?? null,
            reason: 'line item has no id or hs_sku',
            priceListType: effectivePriceListType,
            defaultPriceListType: config.defaultPriceListType,
            salesArea,
          });
          continue;
        }

        // Caché por material: cliente, área y fecha son fijos en la invocación, así que dos
        // líneas del mismo producto comparten el resultado y no repiten las dos llamadas.
        if (!candidatesByMaterial.has(itemCode)) {
          // eslint-disable-next-line no-await-in-loop
          const candidates = await callRecorder.record(
            {
              target: 'sap',
              method: 'GET',
              path: '/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgCndnRecdValidity',
              params: { material: itemCode, conditionType: config.conditionType, salesArea },
            },
            () => priceListClient.fetchConditionCandidates({
              conditionType: config.conditionType,
              material: itemCode,
              salesArea,
              date,
            })
          );
          candidatesByMaterial.set(itemCode, candidates);
        }

        const resolved = resolveS4PriceForMaterial({
          candidates: candidatesByMaterial.get(itemCode),
          customerPriceListType,
          defaultPriceListType: config.defaultPriceListType,
        });

        if (!resolved) {
          this.logger.warn?.({
            msg: 'Line item skipped: no S4 price condition record found',
            tenantKey,
            dealId,
            lineItemId: id,
            itemCode,
            customerPriceListType,
            effectivePriceListType,
            defaultPriceListType: config.defaultPriceListType,
            salesArea,
          });
          skippedLineItems.push({
            id,
            itemCode,
            reason: NO_PRICE_REASON,
            priceListType: effectivePriceListType,
            defaultPriceListType: config.defaultPriceListType,
            salesArea,
          });
          continue;
        }

        const quantity = normalizeQuantity(lineItem?.quantity);
        const price = roundCurrency(resolved.price);

        enrichedLineItems.push({
          id,
          itemCode,
          quantity,
          Price: price,
          // La moneda es la de la condición en SAP y NO se convierte: no hay API de tipos de
          // cambio activada, y un tipo de cambio propio genera diferencias contra la factura.
          Currency: resolved.currency,
          lineTotal: roundCurrency(quantity * price),
          priceListType: resolved.priceListType,
          priceSource: resolved.source,
          conditionRecord: resolved.conditionRecord,
          // Unidad de la condición, tal como vino de SAP. NO se convierte: el precio unitario
          // supone que esta unidad es la unidad base del producto en HubSpot. Viaja hasta acá
          // (y por lo tanto al audit, vía auditTrail.rounds) para que un precio raro se pueda
          // reconstruir después; la conversión de unidades sigue fuera de alcance.
          conditionQuantityUnit: resolved.conditionQuantityUnit,
          // El flujo no gestiona descuentos: los maneja HubSpot nativamente.
          omitDiscount: true,
          additionalProperties: {
            // La lista se escribe SIEMPRE que la propiedad esté configurada, incluso cuando el
            // precio salió del default del producto: si no, la línea se quedaba con la etiqueta
            // de la corrida anterior al lado de un precio de otra procedencia.
            ...(config.priceListProperty
              ? {
                [config.priceListProperty]:
                  resolved.priceListType ?? PRODUCT_DEFAULT_PRICE_LIST_LABEL,
              }
              : {}),
            ...(config.currencyProperty && resolved.currency
              ? { [config.currencyProperty]: resolved.currency }
              : {}),
            // Distingue los tres orígenes posibles (customerPriceList / defaultPriceList /
            // productDefault), que la etiqueta de lista sola no alcanza a separar: la lista de
            // config y la del cliente pueden ser la misma.
            ...(config.priceSourceProperty
              ? { [config.priceSourceProperty]: resolved.source }
              : {}),
          },
        });
      }

      auditTrail.rounds = [{
        salesArea,
        customerPriceListType,
        effectivePriceListType,
        enrichedLineItems,
        skippedLineItems,
      }];

      if (enrichedLineItems.length === 0) {
        throw new Error('No line item prices could be resolved from S4 condition records');
      }

      const hubspotUpdate = await callRecorder.record(
        { target: 'hubspot', method: 'POST', path: '/crm/v3/objects/line_items/batch/update' },
        () => this.hubspotPriceClient.updateLineItems({ token, enrichedLineItems, tenantKey })
      );
      // La decisión de NO convertir monedas está tomada; el problema es agregar unidades
      // distintas. Si las líneas valorizadas traen tarifas en más de una moneda (hay materiales
      // en USD y otros en DOP), la suma no es correcta en ninguna de las dos, así que el `amount`
      // del negocio NO se toca: se deja el que tenía, se avisa con el detalle y el resultado lo
      // dice (`meta.dealUpdated: false` + motivo). Las líneas sí se escriben: cada una es
      // correcta en su propia moneda.
      const currencies = [...new Set(
        enrichedLineItems.map((lineItem) => lineItem.Currency).filter(Boolean)
      )];
      const hasMixedCurrencies = currencies.length > 1;
      const totalAmount = hasMixedCurrencies
        ? null
        : roundCurrency(enrichedLineItems.reduce((sum, lineItem) => sum + lineItem.lineTotal, 0));
      let dealNotUpdatedReason = null;

      if (hasMixedCurrencies) {
        dealNotUpdatedReason = `line item prices are in ${currencies.length} currencies`
          + ` (${currencies.join(', ')}); the deal amount would mix them and was left untouched`;

        this.logger.warn?.({
          msg: 'S4 line item prices: deal amount not updated, mixed line item currencies',
          tenantKey,
          dealId,
          customer,
          currencies,
          lineItems: enrichedLineItems.map((lineItem) => ({
            id: lineItem.id,
            itemCode: lineItem.itemCode,
            currency: lineItem.Currency,
            lineTotal: lineItem.lineTotal,
          })),
        });
      }

      const dealUpdate = hasMixedCurrencies
        ? null
        : await callRecorder.record(
          { target: 'hubspot', method: 'PATCH', path: `/crm/v3/objects/deals/${dealId}` },
          () => this.hubspotPriceClient.updateDealAmount({ token, dealId, totalAmount, tenantKey })
        );

      auditTrail.amount = {
        totalAmount,
        currencies,
        skippedReason: dealNotUpdatedReason,
        response: dealUpdate?.response ?? null,
      };

      return {
        data: {
          dealId,
          customer,
          salesArea,
          priceListType: effectivePriceListType,
          totalAmount,
          currencies,
          lineItems: enrichedLineItems,
          skippedLineItems,
        },
        meta: {
          requestedCount: lineItems.length,
          updatedCount: Array.isArray(hubspotUpdate?.response?.results)
            ? hubspotUpdate.response.results.length
            : enrichedLineItems.length,
          skippedCount: skippedLineItems.length,
          dealUpdated: !hasMixedCurrencies,
          ...(dealNotUpdatedReason ? { dealNotUpdatedReason } : {}),
        },
        // buildLineItemPriceAudit es obligatorio: los `params` de OData ($filter, $select) se
        // aplanan a un string clave=valor (nunca quedan como clave de objeto), y sanitizeAuditKeys
        // renombra `$x` -> `_$x` en los cuerpos de request/response de las llamadas. Sin eso el
        // $set del WebhookEvent se cae completo contra el Mongo de producción (< 5.0).
        audit: this.buildLineItemPriceAudit({ ...auditTrail, droppedCalls: callRecorder.droppedCalls }),
      };
    } catch (error) {
      auditTrail.fatalError = {
        message: error.message,
        status: error?.response?.status ?? null,
        endpoint: error?.details?.endpoint ?? null,
      };

      error.lineItemPriceAudit = this.buildLineItemPriceAudit({
        ...auditTrail,
        droppedCalls: callRecorder.droppedCalls,
      });
      error.syncLogWebhookErrors = [
        this.buildWebhookSyncErrorEntry({
          payloadHubspot: { dealId, customer },
          payloadSap: callRecorder.calls,
          responseHubspot: null,
          responseSap: this.buildErrorResponseSnapshot(error),
        }),
      ];

      throw error;
    }
  }
}

export default SyncS4LineItemPricesByPriceList;
