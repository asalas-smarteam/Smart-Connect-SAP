import mappingService from './mapping.service.js';
import tenantConfigurationService from '#infrastructure/config/tenantConfiguration.service.js';
import {
  DEFAULT_SAP_ERROR_BYPASS_CONFIG,
  SAP_ERROR_BYPASS_CONFIG_KEY,
  normalizeSapErrorBypassConfig,
} from '#infrastructure/config/sapErrorBypass.config.js';
import { getUpsertDataSapConfig } from '#infrastructure/config/upsertDataSap.config.js';
import { resolvePriceListFromConfigValue } from '#domain/prices/price-list-config.service.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import { normalizePositiveInteger, toNonEmptyString } from '#shared/utils/string.utils.js';
import BusinessPartnerCreationConfigRepository from '#infrastructure/config/BusinessPartnerCreationConfigRepository.js';
import {
  BP_ADDRESS_OBJECT_TYPE,
  BP_ADDRESS_SOURCE_CONTEXT,
} from '#domain/business-partners/business-partner-creation.constants.js';

// Key intencionalmente escrita "groupCodeDefauls" (sin la "t") — así existe en los tenants.
const GROUP_CODE_DEFAULTS_CONFIG_KEY = 'groupCodeDefauls';
const businessPartnerCreationConfigRepository = new BusinessPartnerCreationConfigRepository();

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
      addressMappings,
      productMappings,
      productOrdersQuotationsMappings,
      dealMappings,
      dealOrdersQuotationsMappings,
      dealInventoryTransferRequestMappings,
      productInventoryTransferRequestMappings,
      dealPurchaseQuotationsMappings,
      productPurchaseQuotationsMappings,
      taxCodes,
      miscPriceCalculationConfig,
      requireDiscounts,
    ] = await Promise.all([
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'company', 'businessPartner', tenantModels),
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'contact', 'businessPartner', tenantModels),
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'contact', 'contactEmployee', tenantModels),
      // Direcciones de BPAddresses. El fallback a businessPartner queda
      // APAGADO a propósito: sin eso, un tenant sin filas bpAddress recibiría
      // las de contexto businessPartner y filtraría campos de cabecera
      // (CardName, CardCode, DocEntry...) dentro de cada BPAddresses[].
      mappingService.getMappingsByObjectType(
        hubspotCredentialId,
        BP_ADDRESS_OBJECT_TYPE,
        BP_ADDRESS_SOURCE_CONTEXT,
        tenantModels,
        { allowBusinessPartnerFallback: false }
      ),
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'product', 'product', tenantModels),
      // HubSpot -> SAP line fields. The fallback stays off so a tenant without this context
      // gets [] and its DocumentLines keep the exact shape they have today.
      mappingService.getMappingsByObjectType(
        hubspotCredentialId,
        'product',
        'orders-quotations',
        tenantModels,
        { allowBusinessPartnerFallback: false }
      ),
      mappingService.getMappingsByObjectType(hubspotCredentialId, 'deal', 'businessPartner', tenantModels),
      mappingService.getMappingsByObjectType(
        hubspotCredentialId,
        'deal',
        'orders-quotations',
        tenantModels,
        { allowBusinessPartnerFallback: false }
      ),
      // Inventory Transfer Request: every header/line field comes from this context. The
      // fallback stays off so a tenant without it gets [] instead of leaking businessPartner
      // fields (DocEntry, DocNum, DocTotal...) into the OWTQ header via the generic spread.
      mappingService.getMappingsByObjectType(
        hubspotCredentialId,
        'deal',
        'inventory-transfer-request',
        tenantModels,
        { allowBusinessPartnerFallback: false }
      ),
      mappingService.getMappingsByObjectType(
        hubspotCredentialId,
        'product',
        'inventory-transfer-request',
        tenantModels,
        { allowBusinessPartnerFallback: false }
      ),
      // Purchase Quotation: every header/line field comes from this context, CardCode (the
      // SUPPLIER) included -- this flow resolves no Business Partner. Same reason the fallback
      // stays off as on the two contexts above: a tenant without it must get [] instead of
      // leaking businessPartner fields into an OPQT header through the generic spread.
      mappingService.getMappingsByObjectType(
        hubspotCredentialId,
        'deal',
        'purchase-quotations',
        tenantModels,
        { allowBusinessPartnerFallback: false }
      ),
      mappingService.getMappingsByObjectType(
        hubspotCredentialId,
        'product',
        'purchase-quotations',
        tenantModels,
        { allowBusinessPartnerFallback: false }
      ),
      tenantConfigurationService.getValue(tenantModels, 'taxCodes', []),
      this.resolveMiscPriceCalculationConfig(tenantModels),
      tenantConfigurationService.getValue(
        tenantModels,
        'requireDiscounts',
        { isRequired: false, fieldMappings: {} }
      ),
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
        addressMappings,
        productMappings,
        productOrdersQuotationsMappings,
        dealMappings,
        dealOrdersQuotationsMappings,
        dealInventoryTransferRequestMappings,
        productInventoryTransferRequestMappings,
        dealPurchaseQuotationsMappings,
        productPurchaseQuotationsMappings,
      },
      taxCodes,
      miscPriceCalculationConfig,
      discountConfig: {
        isRequired: Boolean(requireDiscounts?.isRequired),
        fieldMappings: requireDiscounts?.fieldMappings ?? {},
      },
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

  // Qué errores de SAP se indultan en vez de tumbar el documento. Por default
  // NINGUNO: un ContactEmployee rechazado bloquea el negocio para que la data se
  // corrija en HubSpot y se reenvíe. El bypass es un acto explícito por tenant.
  async resolveSapErrorBypassConfig(tenantModels) {
    const value = await tenantConfigurationService.getValue(
      tenantModels,
      SAP_ERROR_BYPASS_CONFIG_KEY,
      { ...DEFAULT_SAP_ERROR_BYPASS_CONFIG }
    );

    return normalizeSapErrorBypassConfig(value);
  }

  async resolveGroupCodeDefaults(tenantModels) {
    const Configuration = tenantModels?.Configuration;

    if (typeof Configuration?.findOne !== 'function') {
      return null;
    }

    const query = Configuration.findOne({ key: GROUP_CODE_DEFAULTS_CONFIG_KEY });
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
    const priceListNum = resolvePriceListFromConfigValue(value);

    if (!priceListNum) {
      throw new PermanentWebhookError(
        'PriceListNum is required from HubSpot mapping or tenant configuration priceList '
        + '(currency map, e.g. { "default": 4, "GTQ": 4, "USD": 5 })'
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

  // upsertDataSAP: whether an already-existing BusinessPartner/ContactEmployee
  // should be PATCHed with the current HubSpot data, and which SAP fields are
  // eligible for each entity. Resolved once per webhook event (not per
  // resolver-per-item like the others) so the deal use cases can pass the
  // already-resolved value into findOrCreateBusinessPartner /
  // addContactEmployeeIfNeeded without an extra Mongo read.
  async resolveUpsertDataSap(tenantModels) {
    return getUpsertDataSapConfig({ tenantModels });
  }

  async resolveBusinessPartnerCreationConfig(tenantModels) {
    return businessPartnerCreationConfigRepository.getBusinessPartnerCreationConfig({ tenantModels });
  }

  async resolvePropertiesFlagsConfig(tenantModels) {
    return businessPartnerCreationConfigRepository.getPropertiesFlagsConfig({ tenantModels });
  }
}

export default TenantWebhookRuntimeRepository;
