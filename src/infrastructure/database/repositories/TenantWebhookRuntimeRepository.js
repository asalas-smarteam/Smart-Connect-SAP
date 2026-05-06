import mappingService from './mapping.service.js';
import tenantConfigurationService from '../../config/tenantConfiguration.service.js';
import { PermanentWebhookError } from '../../../shared/errors/index.js';
import { normalizePositiveInteger, toNonEmptyString } from '../../../shared/utils/string.utils.js';

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
    ] = await Promise.all([
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'company', 'businessPartner', tenantModels),
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'contact', 'businessPartner', tenantModels),
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'contact', 'contactEmployee', tenantModels),
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'product', 'product', tenantModels),
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'deal', 'businessPartner', tenantModels),
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
    };
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
}

export default TenantWebhookRuntimeRepository;

