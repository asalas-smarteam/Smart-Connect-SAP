import { sapServiceLayerWebhookRequest } from './sapServiceLayerWebhookRequest.js';
import {
  buildDefaultBusinessPartnerCardCode,
  mapHubspotToSapFields,
  resolveContactDisplayName,
} from '#domain/orders/order-builder.service.js';
import {
  buildBusinessPartnerUpdatePayload,
  buildContactEmployeeUpdatePayload,
} from '#domain/business-partners/upsert-sap-fields.service.js';
import LegacyWhitelistBusinessPartnerPayloadStrategy from '#domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js';
import { PermanentWebhookError } from '#shared/errors/index.js';
import {
  escapeODataString,
  normalizeInteger,
  normalizeNumber,
  toNonEmptyString,
} from '#shared/utils/string.utils.js';

const NO_OP_UPDATE_RESULT = { updated: false, requestPayload: null, responsePayload: null };
const DEFAULT_BP_PAYLOAD_STRATEGY_INSTANCE = new LegacyWhitelistBusinessPartnerPayloadStrategy();

function resolveContactEmployeePayload(contact, contactEmployeeMappings) {
  const mapped = mapHubspotToSapFields(contact || {}, contactEmployeeMappings);
  const name = toNonEmptyString(mapped?.Name || resolveContactDisplayName(contact));
  const email = toNonEmptyString(mapped?.E_Mail || mapped?.EmailAddress || contact?.email);
  const internalCode = toNonEmptyString(mapped?.InternalCode);

  if (!name && !email) {
    return null;
  }

  const payload = {
    ...mapped,
  };

  if (name) {
    payload.Name = name;
  }

  if (email) {
    payload.E_Mail = email;
  }

  // ContactEmployee has no EmailAddress property in SAP B1 (only BusinessPartner does);
  // sending it makes the Service Layer reject the whole PATCH.
  delete payload.EmailAddress;
  // InternalCode lo asigna SAP; solo sirve para matching (ver más abajo), nunca
  // se manda de vuelta en el payload de alta/actualización.
  delete payload.InternalCode;

  return { payload, internalCode };
}

function matchContactEmployeeByEmailOrName(currentEmployees, { email, name }) {
  return currentEmployees.find((employee) => {
    const sameEmail = email
      && toNonEmptyString(employee?.E_Mail || employee?.EmailAddress)?.toLowerCase() === email.toLowerCase();
    const sameName = name
      && toNonEmptyString(employee?.Name)?.toLowerCase() === name.toLowerCase();
    return sameEmail || sameName;
  });
}

// InternalCode es el ID único que SAP le asigna a cada ContactEmployee. Si el
// contacto ya lo trae (porque se sincronizó antes y HubSpot lo tiene guardado
// en la propiedad "internalcode"), se intenta primero por ser la fuente de
// verdad. Pero ese valor puede quedar desactualizado (datos de prueba
// recreados en SAP, un InternalCode reasignado, etc.): si no matchea a nadie
// NUNCA se asume "no existe" solo por eso — se cae al fallback por
// email/nombre antes de decidir que hay que crear uno nuevo. Sin este
// fallback, un internalcode viejo hace que se intente crear un
// ContactEmployee que en realidad ya existe, y SAP lo rechaza con
// "This entry already exists" (ODBC -2035), bloqueando todo el negocio.
function findExistingContactEmployee(currentEmployees, { internalCode, email, name }) {
  if (internalCode) {
    const matchByInternalCode = currentEmployees.find(
      (employee) => toNonEmptyString(employee?.InternalCode) === internalCode
    );

    if (matchByInternalCode) {
      return matchByInternalCode;
    }
  }

  return matchContactEmployeeByEmailOrName(currentEmployees, { email, name });
}

export class SapWebhookOrderAdapter {
  async request(sapConfig, options) {
    return sapServiceLayerWebhookRequest(sapConfig, options);
  }

  async findBusinessPartnerByCardCode(sapConfig, cardCode) {
    if (!toNonEmptyString(cardCode)) {
      return null;
    }

    try {
      return await this.request(sapConfig, {
        method: 'get',
        path: `/BusinessPartners('${encodeURIComponent(String(cardCode))}')`,
        params: {
          $select: 'CardCode,CardName,EmailAddress,PriceListNum,ContactEmployees',
        },
      });
    } catch (error) {
      if (error?.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async findBusinessPartnerByField(sapConfig, fieldName, fieldValue) {
    const resolvedFieldName = toNonEmptyString(fieldName);
    const resolvedFieldValue = toNonEmptyString(fieldValue);

    if (!resolvedFieldName || !resolvedFieldValue) {
      return null;
    }

    const selectFields = [
      'CardCode',
      'CardName',
      'EmailAddress',
      'Phone1',
      'PriceListNum',
      'ContactEmployees',
      resolvedFieldName,
    ];

    const response = await this.request(sapConfig, {
      method: 'get',
      path: '/BusinessPartners',
      params: {
        $top: 1,
        $select: [...new Set(selectFields)].join(','),
        $filter: `${resolvedFieldName} eq '${escapeODataString(resolvedFieldValue)}'`,
      },
    });

    return Array.isArray(response?.value) && response.value.length > 0
      ? response.value[0]
      : null;
  }

  async findBusinessPartnerByEmail(sapConfig, email) {
    return this.findBusinessPartnerByField(sapConfig, 'EmailAddress', email);
  }

  // upsertDataSAP: when a BusinessPartner already exists, PATCH only the SAP
  // fields the tenant configured and only when the HubSpot value actually
  // differs from what SAP has. Never throws - a bad field name or a SAP
  // error must not block order/quotation creation, which is the primary
  // purpose of this flow. See
  // docs/superpowers/specs/2026-08-10-upsert-data-sap-design.md.
  async updateBusinessPartnerFields({ sapConfig, cardCode, fields, mappedCompany, mappedContact }) {
    if (!toNonEmptyString(cardCode) || !Array.isArray(fields) || fields.length === 0) {
      return { ...NO_OP_UPDATE_RESULT };
    }

    try {
      const selectFields = [...new Set(['CardCode', ...fields])].join(',');
      const sapBusinessPartner = await this.request(sapConfig, {
        method: 'get',
        path: `/BusinessPartners('${encodeURIComponent(String(cardCode))}')`,
        params: { $select: selectFields },
      });

      const requestPayload = buildBusinessPartnerUpdatePayload({
        fields,
        mappedCompany,
        mappedContact,
        sapBusinessPartner,
      });

      if (Object.keys(requestPayload).length === 0) {
        return { ...NO_OP_UPDATE_RESULT };
      }

      const responsePayload = await this.request(sapConfig, {
        method: 'patch',
        path: `/BusinessPartners('${encodeURIComponent(String(cardCode))}')`,
        data: requestPayload,
      });

      return { updated: true, requestPayload, responsePayload };
    } catch (error) {
      return { updated: false, requestPayload: null, responsePayload: null, error };
    }
  }

  async findOrCreateBusinessPartner({
    sapConfig,
    tenantModels,
    company,
    contact,
    mappedCompany,
    mappedContact,
    companyExists,
    resolveDefaultPriceListNum,
    resolveRequireRandCardCode = async () => true,
    resolveDefaultSeries = async () => null,
    resolveDefaultFindSAP = async () => 'EmailAddress',
    resolveGroupCodeDefaults = async () => null,
    upsertConfig = null,
    // Sin estos, el payload es idéntico al que armaba el código anterior.
    payloadStrategy = DEFAULT_BP_PAYLOAD_STRATEGY_INSTANCE,
    bpAddresses = [],
    mappedContactEmployees = [],
    propertiesFlags = {},
    creationDefaults = null,
  }) {
    const mappedCardCode = toNonEmptyString(mappedCompany?.CardCode || mappedContact?.CardCode);
    const mappedEmail = toNonEmptyString(mappedCompany?.EmailAddress || mappedContact?.EmailAddress);
    const mappedPriceListNum = normalizeNumber(
      mappedCompany?.PriceListNum ?? mappedContact?.PriceListNum,
      null
    );
    const shouldGenerateDefaultCardCode = mappedCardCode
      ? false
      : await resolveRequireRandCardCode(tenantModels);
    const resolvedCardCode = mappedCardCode || (
      shouldGenerateDefaultCardCode
        ? buildDefaultBusinessPartnerCardCode({
          company,
          contact,
          companyExists,
        })
        : null
    );
    const resolvedPriceListNum = Number.isFinite(mappedPriceListNum)
      ? mappedPriceListNum
      : await resolveDefaultPriceListNum(tenantModels);
    const defaultFindSAP = await resolveDefaultFindSAP(tenantModels);
    const defaultFindSAPValue = toNonEmptyString(
      mappedCompany?.[defaultFindSAP] || mappedContact?.[defaultFindSAP]
    );

    const upsertFieldsBP = Array.isArray(upsertConfig?.fieldsUpdated_BP)
      ? upsertConfig.fieldsUpdated_BP
      : [];
    const shouldUpsertBP = upsertConfig?.required === true && upsertFieldsBP.length > 0;

    const byCardCode = await this.findBusinessPartnerByCardCode(sapConfig, mappedCardCode);
    if (byCardCode?.CardCode) {
      const updateResult = shouldUpsertBP
        ? await this.updateBusinessPartnerFields({
          sapConfig,
          cardCode: byCardCode.CardCode,
          fields: upsertFieldsBP,
          mappedCompany,
          mappedContact,
        })
        : { ...NO_OP_UPDATE_RESULT };

      return {
        cardCode: byCardCode.CardCode,
        created: false,
        matchedBy: 'cardCode',
        businessPartner: byCardCode,
        requestPayload: null,
        responsePayload: {
          matchedBy: 'cardCode',
          businessPartner: byCardCode,
        },
        updateResult,
      };
    }

    const byDefaultField = await this.findBusinessPartnerByField(
      sapConfig,
      defaultFindSAP,
      defaultFindSAPValue
    );
    if (byDefaultField?.CardCode) {
      const updateResult = shouldUpsertBP
        ? await this.updateBusinessPartnerFields({
          sapConfig,
          cardCode: byDefaultField.CardCode,
          fields: upsertFieldsBP,
          mappedCompany,
          mappedContact,
        })
        : { ...NO_OP_UPDATE_RESULT };

      return {
        cardCode: byDefaultField.CardCode,
        created: false,
        matchedBy: defaultFindSAP,
        businessPartner: byDefaultField,
        requestPayload: null,
        responsePayload: {
          matchedBy: defaultFindSAP,
          businessPartner: byDefaultField,
        },
        updateResult,
      };
    }

    const fallbackName = companyExists
      ? (company?.name || company?.company || company?.hs_name)
      : resolveContactDisplayName(contact);
    const cardName = toNonEmptyString(mappedCompany?.CardName || mappedContact?.CardName || fallbackName);
    const federalTaxId = companyExists
      ? mappedCompany?.FederalTaxID
      : mappedContact?.FederalTaxID;

    if (!cardName) {
      throw new PermanentWebhookError('CardName is required to create Business Partner');
    }

    const resolvedDefaultSeries = resolvedCardCode
      ? null
      : await resolveDefaultSeries(tenantModels);

    const mappedPayTermsGrpCode = normalizeInteger(
      mappedCompany?.PayTermsGrpCode ?? mappedContact?.PayTermsGrpCode
    );
    const resolvedPayTermsGrpCode = mappedPayTermsGrpCode !== null
      ? mappedPayTermsGrpCode
      : normalizeInteger((await resolveGroupCodeDefaults(tenantModels))?.PayTermsGrpCode);

    const phone1 = toNonEmptyString(mappedCompany?.Phone1 || mappedContact?.Phone1);

    // mapHubspotToSapFields ya descarta null/undefined/'', así que una llave
    // solo existe en mappedCompany cuando tiene algún valor. OJO: el spread NO
    // es equivalente en general al `mappedCompany?.X || mappedContact?.X` que
    // usaba el código campo por campo: para un falsy-pero-presente que sí pasa
    // el filtro (0, false) el spread se queda con el de la company mientras que
    // el OR caía al del contact. Solo equivale para los valores que
    // mapHubspotToSapFields puede llegar a emitir en estos campos, donde ese
    // fallback por campo no hace falta por separado. Phone1 es justo el campo
    // donde sí importaba (un teléfono 0 debe caer al del contacto), y por eso se
    // resuelve aparte, arriba, y viaja en `resolved` en vez de leerse del merge.
    // Ver la guardia de regresión en
    // tests/unit/domain/businessPartnerPayloadStrategies.test.js.
    const mappedBusinessPartner = { ...mappedContact, ...mappedCompany };

    const payload = payloadStrategy.buildCreatePayload({
      mappedBusinessPartner,
      addresses: bpAddresses,
      contactEmployees: mappedContactEmployees,
      propertiesFlags,
      defaults: creationDefaults,
      resolved: {
        cardName,
        cardCode: resolvedCardCode,
        defaultSeries: resolvedDefaultSeries,
        priceListNum: resolvedPriceListNum,
        payTermsGrpCode: resolvedPayTermsGrpCode,
        federalTaxId,
        mappedEmail,
        phone1,
        isCompanyBusinessPartner: Boolean(companyExists),
      },
    });

    const created = await this.request(sapConfig, {
      method: 'post',
      path: '/BusinessPartners',
      data: payload,
    });

    const cardCode = toNonEmptyString(created?.CardCode || resolvedCardCode);
    if (!cardCode) {
      throw new Error('SAP BusinessPartner creation did not return CardCode');
    }

    const businessPartner = await this.findBusinessPartnerByCardCode(sapConfig, cardCode);
    return {
      cardCode,
      created: true,
      matchedBy: null,
      businessPartner,
      requestPayload: payload,
      responsePayload: created,
    };
  }

  // upsertDataSAP: mirrors updateBusinessPartnerFields for the ContactEmployee
  // collection. B1 replaces the whole ContactEmployees array on PATCH, so the
  // matched employee (found by object identity in currentEmployees) is
  // replaced in place with the diffed fields merged in; every other employee
  // (including its InternalCode) is sent back untouched. Never throws.
  async updateContactEmployeeFields({
    sapConfig,
    cardCode,
    fields,
    nextEmployee,
    existingEmployee,
    currentEmployees,
  }) {
    if (!toNonEmptyString(cardCode) || !Array.isArray(fields) || fields.length === 0) {
      return { ...NO_OP_UPDATE_RESULT };
    }

    try {
      const requestPayload = buildContactEmployeeUpdatePayload({
        fields,
        nextEmployee,
        existingEmployee,
      });

      if (Object.keys(requestPayload).length === 0) {
        return { ...NO_OP_UPDATE_RESULT };
      }

      const updatedEmployee = { ...existingEmployee, ...requestPayload };
      const nextEmployees = (Array.isArray(currentEmployees) ? currentEmployees : []).map(
        (employee) => (employee === existingEmployee ? updatedEmployee : employee)
      );

      const responsePayload = await this.request(sapConfig, {
        method: 'patch',
        path: `/BusinessPartners('${encodeURIComponent(String(cardCode))}')`,
        data: { ContactEmployees: nextEmployees },
      });

      return { updated: true, requestPayload, responsePayload };
    } catch (error) {
      return { updated: false, requestPayload: null, responsePayload: null, error };
    }
  }

  async addContactEmployeeIfNeeded({
    sapConfig,
    cardCode,
    businessPartner,
    contact,
    contactEmployeeMappings,
    upsertConfig = null,
  }) {
    if (!cardCode || !contact) {
      return { created: false, internalCode: null, requestPayload: null, responsePayload: null };
    }

    const resolved = resolveContactEmployeePayload(contact, contactEmployeeMappings);
    if (!resolved) {
      return { created: false, internalCode: null, requestPayload: null, responsePayload: null };
    }

    const { payload: nextEmployee, internalCode: incomingInternalCode } = resolved;

    const currentEmployees = Array.isArray(businessPartner?.ContactEmployees)
      ? businessPartner.ContactEmployees
      : [];

    const email = toNonEmptyString(nextEmployee.E_Mail || nextEmployee.EmailAddress);
    const name = toNonEmptyString(nextEmployee.Name);
    const existing = findExistingContactEmployee(currentEmployees, {
      internalCode: incomingInternalCode,
      email,
      name,
    });

    if (existing) {
      const upsertFieldsCE = Array.isArray(upsertConfig?.fieldsUpdated_CE)
        ? upsertConfig.fieldsUpdated_CE
        : [];
      const shouldUpsertCE = upsertConfig?.required === true && upsertFieldsCE.length > 0;
      const updateResult = shouldUpsertCE
        ? await this.updateContactEmployeeFields({
          sapConfig,
          cardCode,
          fields: upsertFieldsCE,
          nextEmployee,
          existingEmployee: existing,
          currentEmployees,
        })
        : { ...NO_OP_UPDATE_RESULT };

      return {
        created: false,
        internalCode: existing.InternalCode || null,
        requestPayload: null,
        responsePayload: {
          matchedExisting: true,
          employee: existing,
        },
        updateResult,
      };
    }

    // Nunca debe bloquear la creación del documento SAP: si el alta choca con
    // algo que el matching de arriba no detectó (p.ej. un Name duplicado en
    // SAP que ninguna de las dos búsquedas encontró), se registra el error y
    // se sigue sin ContactEmployee en vez de tumbar todo el negocio.
    try {
      await this.request(sapConfig, {
        method: 'patch',
        path: `/BusinessPartners('${encodeURIComponent(String(cardCode))}')`,
        data: {
          ContactEmployees: [...currentEmployees, nextEmployee],
        },
      });
    } catch (error) {
      return {
        created: false, internalCode: null, requestPayload: nextEmployee, responsePayload: null, error,
      };
    }

    const refreshedBusinessPartner = await this.findBusinessPartnerByCardCode(sapConfig, cardCode);
    const refreshedEmployees = Array.isArray(refreshedBusinessPartner?.ContactEmployees)
      ? refreshedBusinessPartner.ContactEmployees
      : [];
    const refreshed = matchContactEmployeeByEmailOrName(refreshedEmployees, { email, name });

    return {
      created: true,
      internalCode: refreshed?.InternalCode || null,
      requestPayload: nextEmployee,
      responsePayload: refreshed,
      businessPartner: refreshedBusinessPartner,
    };
  }

  // Envoltura de addContactEmployeeIfNeeded para varios contactos. Se usa
  // cuando contactEmployeeSource es 'payloadArray'. Deliberadamente NO cambia
  // el método de un solo contacto, para no arriesgar los flujos existentes.
  // Secuencial a propósito: B1 reemplaza el array completo de ContactEmployees
  // en cada PATCH, así que dos llamadas en paralelo se pisarían entre sí.
  async addContactEmployeesIfNeeded({
    sapConfig,
    cardCode,
    businessPartner,
    contacts,
    contactEmployeeMappings,
    upsertConfig = null,
  }) {
    const contactList = Array.isArray(contacts) ? contacts.filter(Boolean) : [];
    const results = [];
    const internalCodes = [];
    const requestPayload = [];
    const responsePayload = [];
    let created = false;
    let currentBusinessPartner = businessPartner;

    for (const contact of contactList) {
      const result = await this.addContactEmployeeIfNeeded({
        sapConfig,
        cardCode,
        businessPartner: currentBusinessPartner,
        contact,
        contactEmployeeMappings,
        upsertConfig,
      });

      results.push(result);
      created = created || Boolean(result?.created);

      if (result?.internalCode) {
        internalCodes.push({ contact, internalCode: result.internalCode });
      }

      if (result?.requestPayload) {
        requestPayload.push(result.requestPayload);
      }

      if (result?.responsePayload) {
        responsePayload.push(result.responsePayload);
      }

      // Cada append devuelve el BP recargado; usarlo en la vuelta siguiente
      // evita que el segundo contacto borre al primero.
      if (result?.businessPartner) {
        currentBusinessPartner = result.businessPartner;
      }
    }

    // Paralelo a `results`/`internalCodes`: un entry por contacto procesado
    // (o `undefined` si esa llamada no trajo updateResult), para que quien
    // arma el audit trail de upsert (ProcessHubspotWebhookEvent,
    // webhookQuotationSupport) pueda leerlo igual que hoy lee
    // singleContactResult.updateResult.
    const updateResults = results.map((result) => result?.updateResult);

    return { created, internalCodes, results, requestPayload, responsePayload, updateResults };
  }

  async createOrder({ sapConfig, orderPayload }) {
    return this.request(sapConfig, {
      method: 'post',
      path: '/Orders',
      data: orderPayload,
    });
  }
}

export default SapWebhookOrderAdapter;
