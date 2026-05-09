import tenantConfigurationService from '../config/tenantConfiguration.service.js';
import { getHubspotWarehouseStockPropertiesForTenant } from '../hubspot/warehouseStock.js';

const DEFAULT_PRICE_LIST = '4';

function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizePriceList(value) {
  const normalized = Number(String(value ?? '').trim());
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function normalizeOptionalNumber(value) {
  const rawValue = String(value ?? '').trim();
  if (!rawValue) {
    return null;
  }

  const normalized = Number(rawValue);
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeTaxSettings(configuration) {
  const rawConfiguration = typeof configuration?.toObject === 'function'
    ? configuration.toObject()
    : configuration;

  return {
    fieldItem: toNonEmptyString(rawConfiguration?.FieldItem),
    taxCodes: Array.isArray(rawConfiguration?.value)
      ? rawConfiguration.value
        .map((taxCode) => ({
          Code: toNonEmptyString(taxCode?.Code),
          Rate: normalizeOptionalNumber(taxCode?.Rate),
          HSCode: toNonEmptyString(taxCode?.HSCode),
        }))
        .filter((taxCode) => taxCode.Code && taxCode.Rate !== null)
      : [],
  };
}

export class TenantLineItemPriceConfigRepository {
  async resolveHubspotCredentials({ tenantModels, tenant }) {
    const { HubspotCredentials } = tenantModels;
    const portalId = toNonEmptyString(tenant?.client?.hubspot?.portalId);

    if (portalId) {
      const byPortalId = await HubspotCredentials.findOne({ portalId });
      if (byPortalId) {
        return byPortalId;
      }
    }

    const credentials = await HubspotCredentials.findOne({});
    if (!credentials) {
      throw new Error('HubSpot credentials not found for tenant');
    }

    return credentials;
  }

  async resolveSapCredentials({ tenantModels, hubspotCredentials }) {
    const { SapCredentials } = tenantModels;

    if (hubspotCredentials?.clientConfigId) {
      const byClientConfig = await SapCredentials.findOne({
        clientConfigId: hubspotCredentials.clientConfigId,
      });

      if (byClientConfig) {
        return byClientConfig;
      }
    }

    const credentials = await SapCredentials.findOne({});
    if (!credentials) {
      throw new Error('SAP Service Layer credentials not found for tenant');
    }

    return credentials;
  }

  async resolveTenantPriceList({ tenantModels }) {
    const value = await tenantConfigurationService.getValue(
      tenantModels,
      'priceList',
      DEFAULT_PRICE_LIST
    );
    const priceList = normalizePriceList(value);

    if (!priceList) {
      throw new Error('Configuration priceList must be a positive integer');
    }

    return priceList;
  }

  async resolveTenantTaxSettings({ tenantModels }) {
    const Configuration = tenantModels?.Configuration;

    if (typeof Configuration?.findOne !== 'function') {
      return normalizeTaxSettings(null);
    }

    const query = Configuration.findOne({ key: 'taxCodes' });
    const configuration = typeof query?.lean === 'function'
      ? await query.lean()
      : await query;

    return normalizeTaxSettings(configuration);
  }

  async resolveWarehouseStockProperties({ tenantModels, itemWarehouseInfoCollection }) {
    return getHubspotWarehouseStockPropertiesForTenant(
      tenantModels,
      itemWarehouseInfoCollection
    );
  }
}

export default TenantLineItemPriceConfigRepository;
