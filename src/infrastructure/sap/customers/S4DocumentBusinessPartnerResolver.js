import { mapHubspotToSapFields } from '#domain/orders/order-builder.service.js';
import { buildS4BusinessPartnerCreatePayload } from '#domain/business-partners/s4-business-partner-payload.service.js';
import { resolveBusinessPartnerSyncPlan } from '#application/use-cases/webhookQuotationSupport.js';
import { escapeODataString, toNonEmptyString } from '#shared/utils/string.utils.js';

const BUSINESS_PARTNER_PATH = '/API_BUSINESS_PARTNER/A_BusinessPartner';
const BUSINESS_PARTNER_KEY_FIELD = 'BusinessPartner';

// S/4 no tiene ContactEmployees: un contacto es otro BusinessPartner con relación BUR001.
// Esta entrega no los crea (D6 del spec), así que el resultado es siempre este objeto vacío,
// con la MISMA forma que devuelve el camino de B1 para que el caso de uso no distinga.
const EMPTY_CONTACT_EMPLOYEE_RESULT = Object.freeze({
  created: false,
  internalCode: null,
  internalCodes: [],
  requestPayload: null,
  responsePayload: null,
  updateResults: [],
});

// El sourceField del FieldMapping usa punto ('to_Customer.BPTaxLongNumber'); un $filter de
// OData usa barra. Sin esta conversión el gateway devuelve 400 por sintaxis.
function toODataPath(field) {
  return String(field).split('.').join('/');
}

// Este gateway es OData **v2**: S4GatewayTransport devuelve `normalizeODataV2Response(...)`, y
// `unwrapODataV2Envelope` desenvuelve `{d:{results:[...]}}` entregando el ARRAY PELADO. Leer
// `response.value` (la forma de v4) no encontraba NUNCA: todo campo de búsqueda que no fuera la
// clave primaria -- incluido el 'EmailAddress' heredado por defecto -- caía a la creación, así
// que cada oferta (y cada reintento) daba de alta un cliente duplicado. Se acepta también la
// forma `.value` por si algún día el transporte deja de desenvolver, igual que
// S4GatewayTransport.fetchAll y S4CustomerAdapter contemplan las dos.
function readCollection(response) {
  if (Array.isArray(response)) {
    return response;
  }

  return Array.isArray(response?.value) ? response.value : [];
}

export class S4DocumentBusinessPartnerResolver {
  constructor({
    transport,
    runtimeRepository,
    salesDocumentConfigRepository,
    hubspotWebhookAdapter,
    webhookReferenceRepository,
    logger = { warn: () => {} },
  }) {
    if (!transport) {
      throw new Error('transport is required for S4DocumentBusinessPartnerResolver');
    }
    this.transport = transport;
    this.runtimeRepository = runtimeRepository;
    this.salesDocumentConfigRepository = salesDocumentConfigRepository;
    this.hubspotWebhookAdapter = hubspotWebhookAdapter;
    this.webhookReferenceRepository = webhookReferenceRepository;
    this.logger = logger;
  }

  async findByKey(businessPartner) {
    try {
      return await this.transport.request({
        method: 'get',
        // Dos escapes distintos porque son dos problemas distintos: escapeODataString duplica
        // la comilla simple, que es lo que cierra el literal de clave de OData (sin eso un
        // valor con comilla busca OTRA clave, da 404 y termina en un alta duplicada), y
        // encodeURIComponent deja la URL válida (espacios, acentos). encodeURIComponent NO
        // toca la comilla simple, así que el literal duplicado sobrevive intacto. La búsqueda
        // por campo usa el mismo escapeODataString dentro del $filter.
        path: `${BUSINESS_PARTNER_PATH}('${encodeURIComponent(escapeODataString(businessPartner))}')`,
        query: { $select: 'BusinessPartner' },
      });
    } catch (error) {
      if (error?.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async findByField(field, value) {
    const response = await this.transport.request({
      method: 'get',
      path: BUSINESS_PARTNER_PATH,
      query: {
        $top: 1,
        $select: 'BusinessPartner',
        $filter: `${toODataPath(field)} eq '${escapeODataString(value)}'`,
      },
    });

    return readCollection(response)[0] ?? null;
  }

  async findOrCreateForDocument({
    payload,
    company,
    contact,
    companyExists,
    context,
    auditTrail,
    salesArea,
  }) {
    const { mappings, tenantModels, hubspotCredentials } = context;
    const mappedCompany = mapHubspotToSapFields(company || {}, mappings.companyMappings, {
      logger: this.logger,
    });

    const [defaultFindSAP, creationConfig] = await Promise.all([
      this.runtimeRepository.resolveDefaultFindSAP(tenantModels),
      this.salesDocumentConfigRepository.getBusinessPartnerCreationConfig({ tenantModels }),
    ]);

    const businessPartnerResult = await this.resolveBusinessPartner({
      mappedCompany,
      defaultFindSAP,
      creationConfig,
      salesArea,
    });

    auditTrail.payload_SAP.businessPartner = businessPartnerResult.requestPayload;
    auditTrail.response_SAP.businessPartner = businessPartnerResult.responsePayload;

    const cardCode = businessPartnerResult.cardCode;
    const syncPlan = resolveBusinessPartnerSyncPlan({
      businessPartnerResult,
      company,
      contact,
      companyExists,
      // Sin ContactEmployees no hay nada que escribirle al contacto, así que nunca se
      // sincroniza su idsap por esta vía.
      contactExists: false,
    });

    let hubspotToken = null;

    if (syncPlan.shouldSyncBusinessPartnerIds) {
      hubspotToken = await this.hubspotWebhookAdapter.getAccessToken({
        tenantModels,
        hubspotCredentials,
      });
      auditTrail.response_hubspot = await this.hubspotWebhookAdapter.updateBusinessPartnerIds({
        token: hubspotToken,
        payload,
        cardCode,
        syncCompany: syncPlan.shouldSyncCompanySapId,
        syncContact: false,
      });
    }

    return {
      cardCode,
      businessPartnerResult,
      contactEmployeeResult: { ...EMPTY_CONTACT_EMPLOYEE_RESULT },
      contactEmployeeFailures: [],
      hubspotToken,
      dealContactIsContactEmployee: false,
    };
  }

  async resolveBusinessPartner({ mappedCompany, defaultFindSAP, creationConfig, salesArea }) {
    const primaryField = toNonEmptyString(defaultFindSAP) || BUSINESS_PARTNER_KEY_FIELD;
    const primaryValue = toNonEmptyString(mappedCompany?.[primaryField]);

    if (primaryValue) {
      // La clave primaria se lee por key, que es una sola llamada y distingue 404 de "no hay
      // filas"; cualquier otro campo necesita $filter.
      const found = primaryField === BUSINESS_PARTNER_KEY_FIELD
        ? await this.findByKey(primaryValue)
        : await this.findByField(primaryField, primaryValue);

      if (found?.BusinessPartner) {
        return {
          cardCode: toNonEmptyString(found.BusinessPartner),
          created: false,
          matchedBy: primaryField,
          businessPartner: found,
          requestPayload: null,
          responsePayload: { matchedBy: primaryField, businessPartner: found },
        };
      }
    } else {
      // Sin valor no se emite NINGUNA búsqueda primaria y el flujo se va directo al fallback o
      // al alta. Con la configuración heredada (defaultFindSAP = 'EmailAddress', que en S/4 no
      // es un campo del BusinessPartner) ese es el caso por defecto, y sin este aviso la
      // creación de un cliente duplicado no deja ninguna huella de por qué no se buscó.
      this.logger?.warn?.({
        msg: 'BusinessPartner de S/4: sin búsqueda primaria porque el campo configurado llegó vacío',
        primaryField,
      });
    }

    const fallbackField = toNonEmptyString(creationConfig?.findFallbackField);
    const fallbackValue = fallbackField ? toNonEmptyString(mappedCompany?.[fallbackField]) : null;

    if (fallbackValue) {
      const found = await this.findByField(fallbackField, fallbackValue);

      if (found?.BusinessPartner) {
        return {
          cardCode: toNonEmptyString(found.BusinessPartner),
          created: false,
          matchedBy: fallbackField,
          businessPartner: found,
          requestPayload: null,
          responsePayload: { matchedBy: fallbackField, businessPartner: found },
        };
      }
    }

    const createPayload = buildS4BusinessPartnerCreatePayload({
      mappedCompany,
      creationConfig,
      salesArea,
      logger: this.logger,
    });

    const created = await this.transport.request({
      method: 'post',
      path: BUSINESS_PARTNER_PATH,
      body: createPayload,
    });

    const cardCode = toNonEmptyString(created?.BusinessPartner);

    if (!cardCode) {
      throw new Error('La creación del BusinessPartner en S/4 no devolvió BusinessPartner');
    }

    return {
      cardCode,
      created: true,
      matchedBy: null,
      businessPartner: created,
      requestPayload: createPayload,
      responsePayload: created,
    };
  }
}

export default S4DocumentBusinessPartnerResolver;
