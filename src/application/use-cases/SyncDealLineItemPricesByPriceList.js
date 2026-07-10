import { getPriceForCurrency, selectPriceListRow } from '#domain/prices/price-currency.service.js';
import { normalizeNumber, normalizePositiveInteger, toNonEmptyString } from '#shared/utils/string.utils.js';
import { extractLineItemAssociationIds } from '#shared/utils/hubspot-associations.utils.js';

const DEFAULT_SAP_ITEM_SELECT_FIELDS = ['ItemPrices', 'ItemWarehouseInfoCollection'];

function normalizeQuantity(value) {
  const normalized = normalizeNumber(value, 0);
  return normalized > 0 ? normalized : 1;
}

function roundCurrency(value) {
  return Math.round((normalizeNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function buildItemSelectFields(taxFieldItem) {
  return [...DEFAULT_SAP_ITEM_SELECT_FIELDS, toNonEmptyString(taxFieldItem)]
    .filter((field, index, fields) => field && fields.indexOf(field) === index);
}

function assertStrategyConfig(strategyConfig = {}) {
  ['dealPriceListProperty', 'lineItemPriceListProperty', 'dealCurrencyProperty', 'safePriceProperty']
    .forEach((field) => {
      if (!toNonEmptyString(strategyConfig[field])) {
        throw new Error(`lineItemPriceStrategy configuration is missing ${field}`);
      }
    });
}

export class SyncDealLineItemPricesByPriceList {
  constructor({
    credentialRepository,
    sapPriceClient,
    hubspotPriceClient,
    buildErrorResponseSnapshot,
    buildWebhookSyncErrorEntry,
    logger = { warn: () => {} },
  }) {
    this.credentialRepository = credentialRepository;
    this.sapPriceClient = sapPriceClient;
    this.hubspotPriceClient = hubspotPriceClient;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.logger = logger;
  }

  async execute({ dealId, strategyConfig }, { tenantModels, tenant, tenantKey }) {
    const auditTrail = {
      payload_Hubspot: { dealId },
      payload_SAP: [],
      response_hubspot: null,
      response_SAP: [],
    };

    try {
      const normalizedDealId = toNonEmptyString(dealId);

      if (!normalizedDealId) {
        throw new Error('dealId is required');
      }

      assertStrategyConfig(strategyConfig);

      const {
        dealPriceListProperty,
        lineItemPriceListProperty,
        dealCurrencyProperty,
        safePriceProperty,
        currencyCodes,
      } = strategyConfig;

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

      const deal = await this.hubspotPriceClient.fetchObject({
        token,
        objectType: 'deals',
        objectId: normalizedDealId,
        properties: [dealPriceListProperty, dealCurrencyProperty],
        associations: ['line_items'],
      });
      const lineItemIds = extractLineItemAssociationIds(deal);

      if (lineItemIds.length === 0) {
        throw new Error('Deal has no associated line items');
      }

      const dealCurrency = toNonEmptyString(deal?.properties?.[dealCurrencyProperty])?.toUpperCase();

      if (!dealCurrency) {
        throw new Error(`Deal property ${dealCurrencyProperty} is required to resolve prices`);
      }

      // HubSpot manda el ISO (GTQ) pero SAP puede usar otro código (QTZ).
      const sapCurrency = toNonEmptyString(currencyCodes?.[dealCurrency])?.toUpperCase() || dealCurrency;
      const dealPriceList = normalizePositiveInteger(deal?.properties?.[dealPriceListProperty]);
      const defaultPriceList = await this.credentialRepository.resolveTenantPriceList({
        tenantModels,
        currency: dealCurrency,
      });
      const taxSettings = typeof this.credentialRepository.resolveTenantTaxSettings === 'function'
        ? await this.credentialRepository.resolveTenantTaxSettings({ tenantModels })
        : { fieldItem: null, taxCodes: [] };
      const itemSelectFields = buildItemSelectFields(taxSettings?.fieldItem);
      const sapCredentialsData = typeof sapCredentials?.toObject === 'function'
        ? sapCredentials.toObject()
        : sapCredentials;
      const sapConfig = {
        ...sapCredentialsData,
        tenantKey,
      };
      const enrichedLineItems = [];
      const skippedLineItems = [];

      for (const lineItemId of lineItemIds) {
        const lineItem = await this.hubspotPriceClient.fetchObject({
          token,
          objectType: 'line_items',
          objectId: lineItemId,
          properties: ['hs_sku', 'quantity', lineItemPriceListProperty],
        });
        const itemCode = toNonEmptyString(lineItem?.properties?.hs_sku);

        if (!itemCode) {
          throw new Error(`Line item ${lineItemId} has no hs_sku to resolve its SAP item`);
        }

        // Lista efectiva: la del line item si tiene, si no la del deal, si no la default.
        const linePriceList = normalizePositiveInteger(
          lineItem?.properties?.[lineItemPriceListProperty]
        );
        const requestedPriceList = linePriceList ?? dealPriceList ?? defaultPriceList;

        auditTrail.payload_SAP.push({
          method: 'GET',
          endpoint: `/b1s/v2/Items('${itemCode}')?$select=${itemSelectFields.join(',')}`,
          priceList: requestedPriceList,
          currency: sapCurrency,
        });

        const sapItemData = await this.sapPriceClient.fetchItemPrices({
          sapConfig,
          itemCode,
          tenantKey,
          selectFields: itemSelectFields,
        });

        auditTrail.response_SAP.push(sapItemData);

        let usedPriceList = requestedPriceList;
        let price = getPriceForCurrency(
          selectPriceListRow(sapItemData?.ItemPrices, requestedPriceList),
          sapCurrency
        );

        if (price === null && defaultPriceList && defaultPriceList !== requestedPriceList) {
          price = getPriceForCurrency(
            selectPriceListRow(sapItemData?.ItemPrices, defaultPriceList),
            sapCurrency
          );
          usedPriceList = defaultPriceList;
        }

        if (price === null) {
          this.logger.warn({
            msg: 'Line item skipped: no SAP price for the requested or default price list in the deal currency',
            tenantKey,
            dealId: normalizedDealId,
            lineItemId,
            itemCode,
            requestedPriceList,
            defaultPriceList,
            currency: sapCurrency,
          });
          skippedLineItems.push({ id: lineItemId, itemCode });
          continue;
        }

        const warehouseStockProperties = await this.credentialRepository.resolveWarehouseStockProperties({
          tenantModels,
          itemWarehouseInfoCollection: sapItemData?.ItemWarehouseInfoCollection,
        });
        const tax = taxSettings?.taxCodes?.find(
          (entry) => toNonEmptyString(entry?.Code) === toNonEmptyString(sapItemData?.[taxSettings.fieldItem])
        ) || {};
        const quantity = normalizeQuantity(lineItem?.properties?.quantity);
        const roundedPrice = roundCurrency(price);
        const lineTotal = roundCurrency(quantity * roundedPrice);

        enrichedLineItems.push({
          itemCode,
          id: toNonEmptyString(lineItem?.id) || lineItemId,
          quantity,
          Price: roundedPrice,
          Currency: dealCurrency,
          lineTotal,
          priceList: usedPriceList,
          ...(toNonEmptyString(tax.HSCode) ? { tax: tax.HSCode } : {}),
          omitDiscount: true,
          additionalProperties: {
            [safePriceProperty]: String(roundedPrice),
            [lineItemPriceListProperty]: String(usedPriceList),
          },
          warehouseStockProperties,
        });
      }

      if (enrichedLineItems.length === 0) {
        throw new Error(
          'No line item prices could be resolved for the requested or default price lists'
        );
      }

      const hubspotUpdate = await this.hubspotPriceClient.updateLineItems({
        token,
        enrichedLineItems,
        tenantKey,
      });
      const hubspotProductUpdate = await this.hubspotPriceClient.updateProducts({
        token,
        enrichedLineItems,
        tenantKey,
      });
      const totalAmount = roundCurrency(
        enrichedLineItems.reduce((sum, lineItem) => sum + lineItem.lineTotal, 0)
      );
      const dealUpdate = await this.hubspotPriceClient.updateDealAmount({
        token,
        dealId: normalizedDealId,
        totalAmount,
        tenantKey,
      });

      auditTrail.response_hubspot = {
        lineItems: {
          payload: hubspotUpdate.payload,
          response: hubspotUpdate.response,
        },
        products: {
          payload: hubspotProductUpdate.payload,
          response: hubspotProductUpdate.response,
        },
        deal: {
          payload: dealUpdate.payload,
          response: dealUpdate.response,
        },
      };

      return {
        data: {
          dealId: normalizedDealId,
          currency: dealCurrency,
          totalAmount,
          lineItems: enrichedLineItems,
          skippedLineItems,
        },
        meta: {
          requestedCount: lineItemIds.length,
          updatedCount: Array.isArray(hubspotUpdate.response?.results)
            ? hubspotUpdate.response.results.length
            : hubspotUpdate.payload.inputs.length,
          skippedCount: skippedLineItems.length,
          dealUpdated: true,
        },
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

      throw error;
    }
  }
}

export default SyncDealLineItemPricesByPriceList;
