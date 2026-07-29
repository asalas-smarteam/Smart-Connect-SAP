import {
  DEFAULT_SAP_FLAVOR,
  SAP_FLAVORS,
} from '#domain/sap/sap-flavor.constants.js';

const DEFAULT_CONTACT_EMPLOYEE_MAPPINGS = [
  { sourceField: 'Name', targetField: 'firstname', sourceContext: 'contactEmployee' },
  { sourceField: 'InternalCode', targetField: 'internalcode', sourceContext: 'contactEmployee' },
  { sourceField: 'E_Mail', targetField: 'email', sourceContext: 'contactEmployee' },
  { sourceField: 'Address', targetField: 'address', sourceContext: 'contactEmployee' },
  { sourceField: 'EmailAddress', targetField: 'email', sourceContext: 'contactEmployee' },
  { sourceField: 'CardName', targetField: 'firstname', sourceContext: 'businessPartner' },
  { sourceField: 'CardCode', targetField: 'idsap', sourceContext: 'businessPartner' },
  { sourceField: 'EmailAddress', targetField: 'email', sourceContext: 'businessPartner' },
  { sourceField: 'Phone1', targetField: 'phone', sourceContext: 'businessPartner' },
  { sourceField: 'PriceListNum', targetField: 'pricelist', sourceContext: 'businessPartner' },
];

const DEFAULT_COMPANY_EMPLOYEE_MAPPINGS = [
  { sourceField: 'CardName', targetField: 'name', sourceContext: 'businessPartner' },
  { sourceField: 'CardCode', targetField: 'idsap', sourceContext: 'businessPartner' },
  { sourceField: 'EmailAddress', targetField: 'email', sourceContext: 'businessPartner' },
  { sourceField: 'Phone1', targetField: 'phone', sourceContext: 'businessPartner' },
  { sourceField: 'PriceListNum', targetField: 'pricelist', sourceContext: 'businessPartner' },
];

// NOTE: sourceField must be unique per (objectType, sourceContext) here.
// The FieldMapping unique index is { hubspotCredentialId, objectType,
// sourceContext, sourceField } and ignores targetField, so mapping one SAP
// field to two HubSpot properties raises E11000 during tenant seeding.
const DEFAULT_DEAL_MAPPINGS = [
  { sourceField: 'DocEntry', targetField: 'sap_docentry', sourceContext: 'businessPartner' },
  { sourceField: 'DocNum', targetField: 'sap_docnum', sourceContext: 'businessPartner' },
  { sourceField: 'DocTotal', targetField: 'amount', sourceContext: 'businessPartner' },
  { sourceField: 'DocumentStatus', targetField: 'dealstage', sourceContext: 'businessPartner' },
];

const DEFAULT_PRODUCT_MAPPINGS = [
  { sourceField: 'ItemCode', targetField: 'hs_sku', sourceContext: 'product' },
  { sourceField: 'ItemName', targetField: 'name', sourceContext: 'product' },
  { sourceField: 'QuantityOnStock', targetField: 'quantity', sourceContext: 'product', includeInServiceLayerSelect: false },
  { sourceField: 'Price', targetField: 'price', sourceContext: 'product', includeInServiceLayerSelect: false },
];

// Invoices are not pushed to a HubSpot object; the mappings only drive the SAP $select so
// the reconciler can read NumAtCard (HS-DEAL-<dealId>) and identify the deal to update.
export const DEFAULT_INVOICE_MAPPINGS = [
  { sourceField: 'NumAtCard', targetField: 'num_at_card', sourceContext: 'businessPartner' },
  { sourceField: 'DocEntry', targetField: 'sap_docentry', sourceContext: 'businessPartner' },
  { sourceField: 'DocNum', targetField: 'sap_docnum', sourceContext: 'businessPartner' },
  { sourceField: 'CardCode', targetField: 'cardcode', sourceContext: 'businessPartner' },
  { sourceField: 'CardName', targetField: 'cardname', sourceContext: 'businessPartner' },
  { sourceField: 'DocTotal', targetField: 'doctotal', sourceContext: 'businessPartner' },
  { sourceField: 'UpdateDate', targetField: 'update_date', sourceContext: 'businessPartner' },
  { sourceField: 'UpdateTime', targetField: 'update_time', sourceContext: 'businessPartner' },
];

// --- SAP S/4HANA -----------------------------------------------------------
// Field names and navigation paths validated against a live Gateway. The
// mapping layer resolves dotted paths and steps into arrays automatically
// (see resolveValueByPath), so nested contact data works without flattening.
const DEFAULT_S4_COMPANY_MAPPINGS = [
  { sourceField: 'BusinessPartner', targetField: 'idsap', sourceContext: 'businessPartner' },
  { sourceField: 'BusinessPartnerFullName', targetField: 'name', sourceContext: 'businessPartner' },
  { sourceField: 'BusinessPartnerGrouping', targetField: 'tipo_cliente', sourceContext: 'businessPartner' },
  { sourceField: 'to_Customer.TaxNumber1', targetField: 'cedula', sourceContext: 'businessPartner' },
  { sourceField: 'to_BusinessPartnerAddress.to_EmailAddress.EmailAddress', targetField: 'email', sourceContext: 'businessPartner' },
  { sourceField: 'to_BusinessPartnerAddress.to_PhoneNumber.PhoneNumber', targetField: 'phone', sourceContext: 'businessPartner' },
  { sourceField: 'to_BusinessPartnerAddress.CityName', targetField: 'city', sourceContext: 'businessPartner' },
  { sourceField: 'to_BusinessPartnerAddress.Country', targetField: 'country', sourceContext: 'businessPartner' },
];

const DEFAULT_S4_PRODUCT_MAPPINGS = [
  { sourceField: 'Product', targetField: 'hs_sku', sourceContext: 'product' },
  { sourceField: 'to_Description.ProductDescription', targetField: 'name', sourceContext: 'product' },
  { sourceField: 'BaseUnit', targetField: 'unidad_medida', sourceContext: 'product', includeInServiceLayerSelect: true },
];

// S/4 contacts are the person-BP (BusinessPartnerCategory '1') reached from a
// company through to_BusinessPartnerContact. Unlike B1 (ContactEmployees
// embedded in the BusinessPartner), the person's name/email/phone live in its
// own A_BusinessPartner record. These mappings target that person-BP shape and
// are seeded under the tenant's own 'contact' ClientConfig. NOTE: the runtime
// extraction (relationship -> person join -> HubSpot association) is not yet
// implemented; this only seeds the structure so S/4 tenants are complete.
const DEFAULT_S4_CONTACT_MAPPINGS = [
  { sourceField: 'BusinessPartner', targetField: 'idsap', sourceContext: 'contactEmployee' },
  { sourceField: 'FirstName', targetField: 'firstname', sourceContext: 'contactEmployee' },
  { sourceField: 'LastName', targetField: 'lastname', sourceContext: 'contactEmployee' },
  { sourceField: 'to_BusinessPartnerAddress.to_EmailAddress.EmailAddress', targetField: 'email', sourceContext: 'contactEmployee' },
  { sourceField: 'to_BusinessPartnerAddress.to_PhoneNumber.PhoneNumber', targetField: 'phone', sourceContext: 'contactEmployee' },
];

async function ensureDefaultMappings({
  FieldMapping,
  clientConfig,
  mappings,
  objectType,
  editable = true,
}) {
  if (!FieldMapping || !clientConfig?._id || !clientConfig?.hubspotCredentialId) {
    return;
  }

  if (!Array.isArray(mappings) || mappings.length === 0) {
    return;
  }

  await Promise.all(
    mappings.map(async (mapping) => {
      const existing = await FieldMapping.findOne({
        clientConfigId: clientConfig._id,
        hubspotCredentialId: clientConfig.hubspotCredentialId,
        objectType,
        sourceContext: mapping.sourceContext,
        sourceField: mapping.sourceField,
        targetField: mapping.targetField,
      });

      if (!existing) {
        await FieldMapping.create({
          ...mapping,
          objectType,
          sourceContext: mapping.sourceContext,
          clientConfigId: clientConfig._id,
          hubspotCredentialId: clientConfig.hubspotCredentialId,
          editable,
        });
        return;
      }

      if (Object.prototype.hasOwnProperty.call(mapping, 'includeInServiceLayerSelect')) {
        const nextIncludeInSelect = Boolean(mapping.includeInServiceLayerSelect);
        if (Boolean(existing.includeInServiceLayerSelect) !== nextIncludeInSelect) {
          await FieldMapping.updateOne(
            { _id: existing._id },
            { $set: { includeInServiceLayerSelect: nextIncludeInSelect } }
          );
        }
      }
    })
  );
}


export async function ensureDefaultCompanyEmployeeMappings({
  FieldMapping,
  clientConfig,
  sapFlavor = DEFAULT_SAP_FLAVOR,
}) {
  if (clientConfig?.objectType !== 'company') {
    return;
  }

  await ensureDefaultMappings({
    FieldMapping,
    clientConfig,
    mappings: sapFlavor === SAP_FLAVORS.S4
      ? DEFAULT_S4_COMPANY_MAPPINGS
      : DEFAULT_COMPANY_EMPLOYEE_MAPPINGS,
    objectType: 'company',
    sourceContext: 'businessPartner',
  });
}

export async function ensureDefaultContactEmployeeMappings({
  FieldMapping,
  clientConfig,
  sapFlavor = DEFAULT_SAP_FLAVOR,
}) {
  // Contact defaults live under different ClientConfigs per flavor:
  //  - B1: seeded under the 'company' config, because the company sync is what
  //    iterates the embedded ContactEmployees at association time.
  //  - S/4: seeded under the tenant's own 'contact' config, because contacts
  //    are separate person-BPs reached via to_BusinessPartnerContact.
  if (sapFlavor === SAP_FLAVORS.S4) {
    if (clientConfig?.objectType !== 'contact') {
      return;
    }

    await ensureDefaultMappings({
      FieldMapping,
      clientConfig,
      mappings: DEFAULT_S4_CONTACT_MAPPINGS,
      objectType: 'contact',
      sourceContext: 'contactEmployee',
    });
    return;
  }

  if (clientConfig?.objectType !== 'company') {
    return;
  }

  await ensureDefaultMappings({
    FieldMapping,
    clientConfig,
    mappings: DEFAULT_CONTACT_EMPLOYEE_MAPPINGS,
    objectType: 'contact',
    sourceContext: 'contactEmployee',
  });
}

export async function ensureDefaultDealMappings({
  FieldMapping,
  clientConfig,
  sapFlavor = DEFAULT_SAP_FLAVOR,
}) {
  if (clientConfig?.objectType !== 'deal') {
    return;
  }

  // A_SalesOrder has not been profiled against a live Gateway yet, so no
  // S/4 deal defaults are seeded: wrong field names would produce silent
  // nulls in HubSpot. The tenant maps them from the UI meanwhile.
  if (sapFlavor === SAP_FLAVORS.S4) {
    return;
  }

  await ensureDefaultMappings({
    FieldMapping,
    clientConfig,
    mappings: DEFAULT_DEAL_MAPPINGS,
    objectType: 'deal',
    sourceContext: 'businessPartner',
  });
}

export async function ensureDefaultProductMappings({
  FieldMapping,
  clientConfig,
  sapFlavor = DEFAULT_SAP_FLAVOR,
}) {
  if (clientConfig?.objectType !== 'product') {
    return;
  }

  await ensureDefaultMappings({
    FieldMapping,
    clientConfig,
    mappings: sapFlavor === SAP_FLAVORS.S4
      ? DEFAULT_S4_PRODUCT_MAPPINGS
      : DEFAULT_PRODUCT_MAPPINGS,
    objectType: 'product',
    editable: false,
  });
}

export async function ensureDefaultInvoiceMappings({ FieldMapping, clientConfig }) {
  if (clientConfig?.objectType !== 'invoice') {
    return;
  }

  await ensureDefaultMappings({
    FieldMapping,
    clientConfig,
    mappings: DEFAULT_INVOICE_MAPPINGS,
    objectType: 'invoice',
    editable: false,
  });
}
