import { SapLineItemPriceClient } from '#infrastructure/external-services/SapLineItemPriceClient.js';

function toPlainObject(value) {
  return typeof value?.toObject === 'function' ? value.toObject() : value;
}

function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizePriceListValue(value) {
  return toNonEmptyString(value);
}

export class ProductPriceListAdapter {
  constructor({ sapPriceClient = new SapLineItemPriceClient() } = {}) {
    this.sapPriceClient = sapPriceClient;
  }

  async getItemPricesByPriceLists({
    clientConfig,
    tenantModels,
    credentials,
    itemCode,
    priceLists,
    tenantKey,
  }) {
    const sapCredentials = await this.resolveSapCredentials({
      tenantModels,
      clientConfig,
      hubspotCredentials: credentials,
    });
    const sapConfig = {
      ...toPlainObject(sapCredentials),
      ...toPlainObject(clientConfig),
      tenantKey,
    };
    const sapItemData = await this.sapPriceClient.fetchItemPrices({
      sapConfig,
      itemCode,
      tenantKey,
      selectFields: ['ItemPrices'],
    });
    const requestedValues = new Set(priceLists.map((priceList) => normalizePriceListValue(priceList.value)));
    const pricesByList = new Map();

    if (Array.isArray(sapItemData?.ItemPrices)) {
      sapItemData.ItemPrices.forEach((itemPrice) => {
        const priceListValue = normalizePriceListValue(itemPrice?.PriceList);

        if (requestedValues.has(priceListValue)) {
          pricesByList.set(priceListValue, itemPrice);
        }
      });
    }

    return pricesByList;
  }

  async resolveSapCredentials({ tenantModels, clientConfig, hubspotCredentials }) {
    const SapCredentials = tenantModels?.SapCredentials;

    if (typeof SapCredentials?.findOne !== 'function') {
      throw new Error('SAP Service Layer credentials model not available for product sync');
    }

    const hubspotClientConfigId = toNonEmptyString(hubspotCredentials?.clientConfigId);
    if (hubspotClientConfigId) {
      const byHubspotConfig = await SapCredentials.findOne({ clientConfigId: hubspotClientConfigId });
      if (byHubspotConfig) {
        return byHubspotConfig;
      }
    }

    const clientConfigId = toNonEmptyString(clientConfig?._id ?? clientConfig?.id);
    if (clientConfigId) {
      const byClientConfig = await SapCredentials.findOne({ clientConfigId });
      if (byClientConfig) {
        return byClientConfig;
      }
    }

    const credentials = await SapCredentials.findOne({});
    if (!credentials) {
      throw new Error('SAP Service Layer credentials not found for product sync');
    }

    return credentials;
  }
}

export default ProductPriceListAdapter;
