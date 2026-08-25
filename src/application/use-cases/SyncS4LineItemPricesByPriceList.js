import { resolveS4PriceForMaterial } from '#domain/prices/s4-price-resolution.service.js';
import { buildLineItemPriceNoteBody } from '#domain/prices/lineItemPriceNote.service.js';
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

// Motivos por los que el negocio no se pudo valorizar, tal como los recibe la nota. Son códigos
// y no textos porque el texto vive en el dominio de la nota; acá sólo se clasifica.
export const PRICE_FAILURE_REASONS = Object.freeze({
  salesAreaMissing: 'salesAreaMissing',
  salesAreaNotFound: 'salesAreaNotFound',
});

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

// El área de ventas la declara el NEGOCIO (`sales_organization` + `distribution_channel`), así
// que la consulta a SAP ya llega filtrada por ella y acá sólo queda validar el resultado. Antes
// esto desempataba entre las áreas del cliente con la config del tenant, y no podía funcionar:
// un cliente tiene hasta cinco áreas con listas distintas (100061: ZD en CPDO, ZC en DPDO, ZD en
// GPDO, ZD en MQDO, ZC en TMDO) y en qué organización se cotiza es una decisión comercial, no un
// dato deducible del maestro.
//
// `Customer + SalesOrganization + DistributionChannel` identifica una sola fila: verificado el
// 2026-08-24 sobre las 8974 filas del sistema, cero clientes con dos filas en el mismo org/canal
// y `Division` = `SC` en todas. El caso de más de una fila igual se contempla y falla explícito:
// si SAP cambia y aparece una segunda división, hay que enterarse en vez de elegir al azar.
function chooseSalesAreaRow(rows, { customer, salesOrganization, distributionChannel }) {
  if (rows.length === 0) {
    // Tipado y no reconocido por el texto: el llamador tiene que escribir ceros y una nota antes
    // de propagarlo, y parsear `error.message` para decidir eso es frágil.
    throw Object.assign(
      new Error(
        `Customer ${customer} is not registered in sales area`
        + ` ${salesOrganization}/${distributionChannel} in SAP`
      ),
      { salesAreaNotFound: true }
    );
  }

  if (rows.length === 1) {
    return rows[0];
  }

  throw new Error(
    `Customer ${customer} has ${rows.length} rows in sales area`
    + ` ${salesOrganization}/${distributionChannel} (${describeSalesAreaRows(rows)});`
    + ' the division is needed to choose one'
  );
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
    notifyLineItemPriceOutcome,
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

    // Exigida por el mismo motivo que dateProvider: un default no-op acá significa "las notas
    // nunca se escriben" y ningún test lo distingue de la composición cableada, que es
    // exactamente el bug que ya se colgó tres veces en este repo.
    if (typeof notifyLineItemPriceOutcome !== 'function') {
      throw new Error('notifyLineItemPriceOutcome is required for SyncS4LineItemPricesByPriceList');
    }

    this.credentialRepository = credentialRepository;
    this.createPriceListClient = createPriceListClient;
    this.hubspotPriceClient = hubspotPriceClient;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.buildLineItemPriceAudit = buildLineItemPriceAudit;
    this.createSapCallRecorder = createSapCallRecorder;
    this.notifyLineItemPriceOutcome = notifyLineItemPriceOutcome;
    this.dateProvider = dateProvider;
    this.logger = logger;
  }

  async execute(payload, { tenantModels, tenant, tenantKey }) {
    const dealId = toNonEmptyString(payload?.dealId);
    const customer = toNonEmptyString(payload?.customer);
    const salesOrganization = toNonEmptyString(payload?.salesOrganization)?.toUpperCase() ?? null;
    // Sin `toUpperCase`: SAP devuelve el canal como '01' y así entra al $filter y a la clave del
    // mapa de listas por defecto.
    const distributionChannel = toNonEmptyString(payload?.distributionChannel);
    const dealCurrency = toNonEmptyString(payload?.dealCurrency)?.toUpperCase() ?? null;
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
    // Fuera del try: la nota del camino de error los necesita, y ahí ya no están en scope.
    let hubspotToken = null;
    let priceListClient = null;
    let noteContext = {
      customer,
      salesArea: null,
      priceListType: null,
      reasonCode: null,
      customerSalesAreas: [],
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

      // El área de ventas del negocio se valida ACÁ pero se lanza más abajo, después de tener el
      // token de HubSpot. Parece un orden arbitrario y no lo es: el asesor sólo se entera de que
      // le falta el campo por la nota en el negocio, y la nota necesita el token. Lanzar antes
      // dejaría el error únicamente en Mongo, donde no lo ve nadie fuera de soporte.
      const missingSalesArea = !salesOrganization || !distributionChannel;

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
      hubspotToken = token;

      // Recién acá se lanza: ver el comentario de `missingSalesArea`. Los precios NO se tocan —
      // sin área no se consultó nada en SAP, así que no hay nada que afirmar sobre las líneas.
      if (missingSalesArea) {
        noteContext = { ...noteContext, reasonCode: PRICE_FAILURE_REASONS.salesAreaMissing };

        throw Object.assign(
          new Error(
            'Deal has no sales organization or distribution channel'
            + ` (received salesOrganization=${JSON.stringify(payload?.salesOrganization)}`
            + ` distributionChannel=${JSON.stringify(payload?.distributionChannel)})`
          ),
          { salesAreaMissing: true }
        );
      }

      const sapConfig = {
        ...(typeof sapCredentials?.toObject === 'function' ? sapCredentials.toObject() : sapCredentials),
        tenantKey,
      };
      priceListClient = this.createPriceListClient({ sapConfig });
      const salesAreaRows = await callRecorder.record(
        {
          target: 'sap',
          method: 'GET',
          path: '/API_BUSINESS_PARTNER/A_CustomerSalesArea',
          params: { customer, salesOrganization, distributionChannel },
        },
        () => priceListClient.fetchCustomerSalesAreas(customer, {
          salesOrganization,
          distributionChannel,
        })
      );
      const salesAreaRow = chooseSalesAreaRow(
        Array.isArray(salesAreaRows) ? salesAreaRows : [],
        { customer, salesOrganization, distributionChannel }
      );
      const salesArea = toSalesArea(salesAreaRow);
      // Vacío es un dato, no un error: 391 clientes del sistema no tienen lista asignada.
      //
      // Se guardan SEPARADAS la lista del cliente y la efectiva: al dominio se le pasa la del
      // cliente tal cual (null si no tiene), porque si se le pasaba la de config disfrazada de
      // lista del cliente, el `source` del resultado decía `customerPriceList` para un precio
      // que en realidad salió del default. La efectiva es sólo para reportar.
      const customerPriceListType = toNonEmptyString(salesAreaRow?.PriceListType)?.toUpperCase()
        ?? null;
      // El default es POR ÁREA y no global: la lista mayoritaria cambia según la combinación, y
      // un default global acierta en 5 de las 16 que existen (verificado el 2026-08-24). El mapa
      // se resuelve acá y al dominio le llega un solo código: no conoce la clave compuesta.
      const areaDefaultPriceListType = config.defaultPriceListBySalesArea?.[
        `${salesOrganization}/${distributionChannel}`
      ] ?? config.defaultPriceListType;
      const effectivePriceListType = customerPriceListType ?? areaDefaultPriceListType;
      noteContext = {
        ...noteContext,
        salesArea,
        priceListType: effectivePriceListType,
      };
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
            defaultPriceListType: areaDefaultPriceListType,
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
          defaultPriceListType: areaDefaultPriceListType,
          dealCurrency,
        });

        // El campo `price` del line item NO lleva moneda propia: hereda la del negocio. Escribir
        // ahí una tarifa en otra moneda es un precio silenciosamente equivocado, no un redondeo
        // — en DPDO/01 hay 200 condiciones en USD y 136 en DOP sobre materiales distintos, así
        // que el caso es real. Se saltea la línea y la nota lo dice.
        if (resolved?.currencyMismatch) {
          const reason = `condition currency ${resolved.currency} does not match the deal`
            + ` currency ${dealCurrency}`;

          this.logger.warn?.({
            msg: 'Line item skipped: SAP condition currency does not match the deal currency',
            tenantKey,
            dealId,
            lineItemId: id,
            itemCode,
            conditionCurrency: resolved.currency,
            dealCurrency,
            conditionRecord: resolved.conditionRecord,
            salesArea,
          });
          skippedLineItems.push({
            id,
            itemCode,
            reason,
            priceListType: effectivePriceListType,
            defaultPriceListType: areaDefaultPriceListType,
            salesArea,
          });
          continue;
        }

        if (!resolved) {
          this.logger.warn?.({
            msg: 'Line item skipped: no S4 price condition record found',
            tenantKey,
            dealId,
            lineItemId: id,
            itemCode,
            customerPriceListType,
            effectivePriceListType,
            defaultPriceListType: areaDefaultPriceListType,
            salesArea,
          });
          skippedLineItems.push({
            id,
            itemCode,
            reason: NO_PRICE_REASON,
            priceListType: effectivePriceListType,
            defaultPriceListType: areaDefaultPriceListType,
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

      // Después de las escrituras: la nota cuenta lo que YA pasó. Si algo de esto falla, el
      // error se propaga y la nota la escribe el camino de error con el motivo real.
      await this.notifyLineItemPriceOutcome({
        tenantModels,
        tenantKey,
        token,
        dealId,
        body: buildLineItemPriceNoteBody({
          ...noteContext,
          updatedCount: enrichedLineItems.length,
          skippedLineItems,
        }),
      });

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
      // El cliente no está registrado en el área que declara el negocio: los precios se ponen en
      // 0 y el negocio queda en 0.
      //
      // Es destructivo a propósito y la decisión es del cliente (2026-08-24): un 0 es
      // obviamente inválido y frena la cotización, mientras un precio de una corrida anterior al
      // lado de un área equivocada se cotiza sin que nadie lo note. En la práctica pisa poco: la
      // propiedad es la `price` nativa del line item y el único que la escribe es este webhook
      // (el sync de productos usa los campos de `fieldsPricesHS`, por defecto `hs_price_usd`, y
      // no toca la `price` nativa del producto, así que las líneas nacen en 0).
      if (error?.salesAreaNotFound && hubspotToken && priceListClient) {
        // Segunda consulta SIN filtro de área: es lo único que le dice al asesor qué poner. Si
        // falla, se sigue: la nota queda peor pero los ceros importan más.
        let customerSalesAreas = [];

        try {
          const allRows = await callRecorder.record(
            {
              target: 'sap',
              method: 'GET',
              path: '/API_BUSINESS_PARTNER/A_CustomerSalesArea',
              params: { customer },
            },
            () => priceListClient.fetchCustomerSalesAreas(customer)
          );

          customerSalesAreas = (Array.isArray(allRows) ? allRows : []).map((row) => ({
            salesOrganization: toNonEmptyString(row?.SalesOrganization)?.toUpperCase() ?? null,
            distributionChannel: toNonEmptyString(row?.DistributionChannel) ?? null,
            priceListType: toNonEmptyString(row?.PriceListType)?.toUpperCase() ?? null,
          }));
        } catch (listError) {
          this.logger.warn?.({
            msg: 'S4 line item prices: could not list the customer sales areas for the note',
            tenantKey,
            dealId,
            customer,
            error: listError.message,
          });
        }

        noteContext = {
          ...noteContext,
          salesArea: { salesOrganization, distributionChannel, division: null },
          reasonCode: PRICE_FAILURE_REASONS.salesAreaNotFound,
          customerSalesAreas,
        };

        // `quantity` va con su valor real: buildHubspotBatchPayload escribe precio Y cantidad en
        // la misma llamada, así que omitirla la sobreescribiría con 1.
        const zeroedLineItems = lineItems
          .filter((lineItem) => toNonEmptyString(lineItem?.id))
          .map((lineItem) => ({
            id: toNonEmptyString(lineItem.id),
            itemCode: toNonEmptyString(lineItem?.itemCode),
            quantity: normalizeQuantity(lineItem?.quantity),
            Price: 0,
            lineTotal: 0,
            omitDiscount: true,
          }));

        if (zeroedLineItems.length > 0) {
          try {
            await callRecorder.record(
              { target: 'hubspot', method: 'POST', path: '/crm/v3/objects/line_items/batch/update' },
              () => this.hubspotPriceClient.updateLineItems({
                token: hubspotToken,
                enrichedLineItems: zeroedLineItems,
                tenantKey,
              })
            );
            await callRecorder.record(
              { target: 'hubspot', method: 'PATCH', path: `/crm/v3/objects/deals/${dealId}` },
              () => this.hubspotPriceClient.updateDealAmount({
                token: hubspotToken,
                dealId,
                totalAmount: 0,
                tenantKey,
              })
            );
          } catch (zeroError) {
            this.logger.error?.({
              msg: 'S4 line item prices: could not zero the line items of a deal whose sales area'
                + ' does not belong to the customer',
              tenantKey,
              dealId,
              customer,
              error: zeroError.message,
            });
          }
        }
      }

      auditTrail.fatalError = {
        message: error.message,
        status: error?.response?.status ?? null,
        endpoint: error?.details?.endpoint ?? null,
      };

      error.lineItemPriceAudit = this.buildLineItemPriceAudit({
        ...auditTrail,
        droppedCalls: callRecorder.droppedCalls,
      });
      await this.notifyLineItemPriceOutcome({
        tenantModels,
        tenantKey,
        token: hubspotToken,
        dealId,
        body: buildLineItemPriceNoteBody({
          ...noteContext,
          skippedLineItems: auditTrail.rounds[0]?.skippedLineItems ?? [],
          fatalErrorMessage: error.message,
        }),
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
