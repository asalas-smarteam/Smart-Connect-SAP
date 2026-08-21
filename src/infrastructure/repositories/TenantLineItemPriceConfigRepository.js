import tenantConfigurationService from '../config/tenantConfiguration.service.js';
import { getHubspotWarehouseStockPropertiesForTenant } from '../hubspot/warehouseStock.js';
import { resolvePriceListFromConfigValue } from '#domain/prices/price-list-config.service.js';

function toNonEmptyString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
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

  async resolveTenantPriceList({ tenantModels, currency = null }) {
    const value = await tenantConfigurationService.getValue(
      tenantModels,
      'priceList',
      null
    );
    const priceList = resolvePriceListFromConfigValue(value, { currency });

    if (!priceList) {
      throw new Error(
        'Configuration priceList must be a currency map with positive integer values, e.g. { "default": 4, "GTQ": 4, "USD": 5 }'
      );
    }

    return priceList;
  }

  // La lista efectiva del cliente sale de S/4 (PriceListType de su área de ventas); acá solo
  // vive lo que el tenant decide: el default cuando el cliente no tiene lista, el área de
  // ventas a usar si el cliente tiene varias, y las propiedades de HubSpot donde dejar rastro.
  async resolveS4PriceListConfig({ tenantModels }) {
    // Lectura directa y NO tenantConfigurationService.getValue: ese helper UPSERTA la clave con
    // el fallback cuando falta, así que el primer webhook de un tenant sin configurar dejaba
    // `{ key: 's4PriceList', value: null }` en la base del cliente antes de tirar el error.
    // Mismo patrón que resolveTenantTaxSettings / resolveMiscPriceCalculationConfig.
    const Configuration = tenantModels?.Configuration;
    const query = typeof Configuration?.findOne === 'function'
      ? Configuration.findOne({ key: 's4PriceList' })
      : null;
    const configuration = typeof query?.lean === 'function' ? await query.lean() : await query;
    const rawConfiguration = typeof configuration?.toObject === 'function'
      ? configuration.toObject()
      : configuration;
    const value = rawConfiguration?.value ?? null;

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(
        'Configuration s4PriceList is required for the S4 line item price webhook,'
        + ' e.g. { "conditionType": "ZPR0", "defaultPriceListType": "ZC",'
        + ' "salesArea": { "salesOrganization": "FQCR", "distributionChannel": "01", "division": "SC" } }'
      );
    }

    const defaultPriceListType = toNonEmptyString(value.defaultPriceListType)?.toUpperCase() ?? null;

    if (!defaultPriceListType) {
      throw new Error('s4PriceList.defaultPriceListType is required');
    }

    const salesOrganization = toNonEmptyString(value.salesArea?.salesOrganization)?.toUpperCase() ?? null;
    const distributionChannel = toNonEmptyString(value.salesArea?.distributionChannel) ?? null;
    const division = toNonEmptyString(value.salesArea?.division)?.toUpperCase() ?? null;
    // `salesOrganization` y `distributionChannel` son obligatorios juntos: son los dos que
    // entran al $filter de las condiciones, y un área a medias devolvería precios de otro canal.
    // `division` es OPCIONAL: nunca entra al filtro, sólo desempata entre áreas del mismo
    // cliente, y hay clientes cuyas filas de S/4 la traen vacía — exigirla los dejaba sin
    // ninguna configuración posible (ver matchesSalesArea en SyncS4LineItemPricesByPriceList).
    const salesArea = salesOrganization && distributionChannel
      ? { salesOrganization, distributionChannel, division }
      : null;

    return {
      conditionType: toNonEmptyString(value.conditionType)?.toUpperCase() ?? 'ZPR0',
      defaultPriceListType,
      salesArea,
      priceListProperty: toNonEmptyString(value.priceListProperty),
      currencyProperty: toNonEmptyString(value.currencyProperty),
      priceSourceProperty: toNonEmptyString(value.priceSourceProperty),
    };
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

  async resolveMiscPriceCalculationConfig({ tenantModels }) {
    const Configuration = tenantModels?.Configuration;

    if (typeof Configuration?.findOne !== 'function') {
      return null;
    }

    const query = Configuration.findOne({ key: 'requireExtraValueInUnitPrice' });
    const configuration = typeof query?.lean === 'function'
      ? await query.lean()
      : await query;

    const rawConfiguration = typeof configuration?.toObject === 'function'
      ? configuration.toObject()
      : configuration;

    return rawConfiguration?.value ?? null;
  }

  async resolveWarehouseStockProperties({ tenantModels, itemWarehouseInfoCollection }) {
    return getHubspotWarehouseStockPropertiesForTenant(
      tenantModels,
      itemWarehouseInfoCollection
    );
  }

  async resolveDiscountConfig({ tenantModels }) {
    const value = await tenantConfigurationService.getValue(
      tenantModels,
      'requireDiscounts',
      { isRequired: false, fieldMappings: {} }
    );

    return {
      isRequired: Boolean(value?.isRequired),
      fieldMappings: value?.fieldMappings ?? {},
    };
  }
}

export default TenantLineItemPriceConfigRepository;
