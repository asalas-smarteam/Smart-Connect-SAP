import mappingService from './mapping.service.js';
import tenantConfigurationService from '#infrastructure/config/tenantConfiguration.service.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { normalizePositiveInteger, toNonEmptyString } from '#shared/utils/string.utils.js';

export class TenantWebhookRuntimeRepository {
  async resolveRuntimeContext({ tenantModels, payload, tenantId, tenantKey, portalId }) {
    const { HubspotCredentials, SapCredentials } = tenantModels;
    const resolvedPortalId = toNonEmptyString(payload?.portalId || portalId);
    const credentialQuery = resolvedPortalId ? { portalId: resolvedPortalId } : {};
    let hubspotCredentials = await HubspotCredentials.findOne(credentialQuery).lean();

    if (!hubspotCredentials) {
      hubspotCredentials = await HubspotCredentials.findOne({}).sort({ _id: 1 }).lean();
    }

    if (!hubspotCredentials?._id) {
      throw new Error('HubSpot credentials not found for tenant webhook processing');
    }

    const sapCredentials = await SapCredentials.findOne().lean();

    if (!sapCredentials?.serviceLayerBaseUrl) {
      throw new Error('SAP Service Layer credentials not configured for webhook processing');
    }

    const hubspotCredentialId = hubspotCredentials._id;
    const [
      companyMappings,
      contactBusinessPartnerMappings,
      contactEmployeeMappings,
      productMappings,
      dealMappings,
      taxCodes,
      miscPriceCalculationConfig,
    ] = await Promise.all([
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'company', 'businessPartner', tenantModels),
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'contact', 'businessPartner', tenantModels),
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'contact', 'contactEmployee', tenantModels),
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'product', 'product', tenantModels),
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'deal', 'businessPartner', tenantModels),
      tenantConfigurationService.getValue(tenantModels, 'taxCodes', []),
      this.resolveMiscPriceCalculationConfig(tenantModels),
    ]);

    return {
      hubspotCredentials,
      sapConfig: {
        ...sapCredentials,
        tenantId,
        tenantKey,
      },
      mappings: {
        companyMappings,
        contactBusinessPartnerMappings,
        contactEmployeeMappings,
        productMappings,
        dealMappings,
      },
      taxCodes,
      miscPriceCalculationConfig,
    };
  }

  async findOwnerMappingByHubspotOwner({ tenantModels, hubspotCredentialId, hubspotOwnerId }) {
    const query = tenantModels?.OwnerMapping?.findOne?.({
      hubspotCredentialId,
      hubspotOwnerId,
      active: true,
    });

    if (!query?.lean) {
      return query ?? null;
    }

    return query.lean();
  }

  async resolveMiscPriceCalculationConfig(tenantModels) {
    const Configuration = tenantModels?.Configuration;

    if (typeof Configuration?.findOne !== 'function') {
      return null;
    }

    const query = Configuration.findOne({ key: 'requireExtraValueInUnitPrice' });
    const configuration = typeof query?.lean === 'function'
      ? await query.lean()
      : await query;

    return configuration?.value ?? null;
  }

  async resolveDefaultPriceListNum(tenantModels) {
    const value = await tenantConfigurationService.getValue(
      tenantModels,
      'priceList',
      null
    );
    const priceListNum = normalizePositiveInteger(value);

    if (!priceListNum) {
      throw new PermanentWebhookError(
        'PriceListNum is required from HubSpot mapping or tenant configuration priceList'
      );
    }

    return priceListNum;
  }

  async resolveRequireRandCardCode(tenantModels) {
    const value = await tenantConfigurationService.getValue(
      tenantModels,
      'requireRandCardCode',
      true
    );

    return value;
  }

  async resolveDefaultSeries(tenantModels) {
    const value = await tenantConfigurationService.getValue(
      tenantModels,
      'defaultSeries',
      null
    );

    return normalizePositiveInteger(value);
  }

  async resolveDefaultFindSAP(tenantModels) {
    return tenantConfigurationService.getValue(
      tenantModels,
      'defaultFindSAP',
      'EmailAddress'
    );
  }
}

export default TenantWebhookRuntimeRepository;
