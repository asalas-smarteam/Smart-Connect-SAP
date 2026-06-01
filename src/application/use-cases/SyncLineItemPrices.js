import { calculateUnitPriceWithMisc } from '#domain/prices/misc-price-calculation.service.js';

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

function normalizeOptionalNumber(value) {
  const rawValue = String(value ?? '').trim();
  if (!rawValue) {
    return null;
  }

  const normalized = Number(rawValue);
  return Number.isFinite(normalized) ? normalized : null;
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

function buildItemSelectFields(taxFieldItem) {
  return [
    ...DEFAULT_SAP_ITEM_SELECT_FIELDS,
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

function resolveTaxRate({ sapItemData, taxSettings, fallbackDiscount }) {
  const taxFieldItem = toNonEmptyString(taxSettings?.fieldItem);
  if (!taxFieldItem) {
    return fallbackDiscount;
  }

  const taxCode = toNonEmptyString(sapItemData?.[taxFieldItem]);
  if (!taxCode || !Array.isArray(taxSettings?.taxCodes)) {
    return fallbackDiscount;
  }

  const taxCodeConfig = taxSettings.taxCodes.find(
    (entry) => toNonEmptyString(entry?.Code) === taxCode
  );
  const taxRate = normalizeOptionalNumber(taxCodeConfig?.Rate);

  return taxRate ?? fallbackDiscount;
}

export class SyncLineItemPrices {
  constructor({
    credentialRepository,
    sapPriceClient,
    hubspotPriceClient,
    buildErrorResponseSnapshot,
    buildWebhookSyncErrorEntry,
    dateProvider = () => new Date(),
    logger = { warn: () => {} },
  }) {
    this.credentialRepository = credentialRepository;
    this.sapPriceClient = sapPriceClient;
    this.hubspotPriceClient = hubspotPriceClient;
    this.buildErrorResponseSnapshot = buildErrorResponseSnapshot;
    this.buildWebhookSyncErrorEntry = buildWebhookSyncErrorEntry;
    this.dateProvider = dateProvider;
    this.logger = logger;
  }

  async execute(payload, { tenantModels, tenant, tenantKey }) {
    const auditTrail = {
      payload_Hubspot: payload,
      payload_SAP: [],
      response_hubspot: null,
      response_SAP: [],
    };

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
      const itemSelectFields = buildItemSelectFields(taxSettings?.fieldItem);
      const sapCredentialsData = typeof sapCredentials?.toObject === 'function'
        ? sapCredentials.toObject()
        : sapCredentials;
      const sapConfig = {
        ...sapCredentialsData,
        tenantKey,
      };
      const enrichedLineItems = [];

      for (const lineItem of payload.lineItems) {
        const itemCode = toNonEmptyString(lineItem.itemCode);
        const id = toNonEmptyString(lineItem.id);
        let priceData;

        if (useBusinessPartnerPrice) {
          const sapRequestPayload = buildSapPricePayload({
            cardCode,
            itemCode,
            date: currentDate,
          });

          auditTrail.payload_SAP.push(sapRequestPayload);

          priceData = await this.sapPriceClient.fetchBusinessPartnerPrice({
            sapConfig,
            cardCode,
            itemCode,
            date: currentDate,
            tenantKey,
            requestPayload: sapRequestPayload,
          });
        } else {
          const sapRequestPayload = {
            method: 'GET',
            endpoint: buildSapItemPricesPath(itemCode, itemSelectFields),
            priceList: fallbackPriceList,
          };

          auditTrail.payload_SAP.push(sapRequestPayload);

          const sapItemData = await this.sapPriceClient.fetchItemPrices({
            sapConfig,
            itemCode,
            tenantKey,
            selectFields: itemSelectFields,
          });
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

          auditTrail.response_SAP.push({
            ...sapItemData,
            selectedPrice,
          });
        }

        if (useBusinessPartnerPrice) {
          auditTrail.response_SAP.push(priceData);
        }

        const sapItemStockData = useBusinessPartnerPrice
          ? await this.sapPriceClient.fetchItemPrices({
            sapConfig,
            itemCode,
            tenantKey,
            selectFields: itemSelectFields,
          })
          : auditTrail.response_SAP[auditTrail.response_SAP.length - 1];
        const warehouseStockProperties = await this.credentialRepository.resolveWarehouseStockProperties({
          tenantModels,
          itemWarehouseInfoCollection: sapItemStockData?.ItemWarehouseInfoCollection,
        });
        const tax = taxSettings?.taxCodes?.find((entry) => toNonEmptyString(entry?.Code) === toNonEmptyString(sapItemStockData?.[taxSettings.fieldItem])) || {};
        const discount = resolveTaxRate({
          sapItemData: sapItemStockData,
          taxSettings,
          fallbackDiscount: normalizeNumber(priceData?.Discount, 0),
        });
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

        enrichedLineItems.push({
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
          Discount: discount,
          lineTotal,
          ...(toNonEmptyString(tax.HSCode) ? { tax: tax.HSCode } : {}),
          warehouseStockProperties,
        });
      }

      const token = await this.hubspotPriceClient.getAccessToken({
        hubspotCredentials,
        tenantModels,
      });
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

      let dealUpdate = null;
      const totalAmount = roundCurrency(
        enrichedLineItems.reduce((sum, lineItem) => sum + lineItem.lineTotal, 0)
      );

      if (dealId) {
        dealUpdate = await this.hubspotPriceClient.updateDealAmount({
          token,
          dealId,
          totalAmount,
          tenantKey,
        });

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
          dealUpdated: Boolean(dealUpdate),
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

export default SyncLineItemPrices;
