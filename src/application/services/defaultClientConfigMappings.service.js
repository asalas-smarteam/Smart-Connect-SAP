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

// Inventory Transfer Request (OWTQ). Unlike every other default set above, these are NOT
// seeded automatically: `filler`/`towhscode` are tenant-specific HubSpot property names, not
// universal ones like `hs_sku`, so seeding them for every tenant would create dead mappings
// in the admin UI. ensureDefaultInventoryTransferRequestMappings below exists to be invoked
// explicitly during a tenant's onboarding, once its actual warehouse property names are known.
// Per the design rule for this document (see inventory-transfer-request-builder.service.js),
// every SAP field the document needs must be mapped -- FromWarehouse/ToWarehouse and
// ItemCode/Quantity are not optional, the rest is.
export const DEFAULT_INVENTORY_TRANSFER_REQUEST_DEAL_MAPPINGS = [
  { sourceField: 'FromWarehouse', targetField: 'filler', sourceContext: 'inventory-transfer-request', includeInServiceLayerSelect: false },
  { sourceField: 'ToWarehouse', targetField: 'towhscode', sourceContext: 'inventory-transfer-request', includeInServiceLayerSelect: false },
];

export const DEFAULT_INVENTORY_TRANSFER_REQUEST_PRODUCT_MAPPINGS = [
  { sourceField: 'ItemCode', targetField: 'hs_sku', sourceContext: 'inventory-transfer-request', includeInServiceLayerSelect: false },
  { sourceField: 'Quantity', targetField: 'quantity', sourceContext: 'inventory-transfer-request', includeInServiceLayerSelect: false },
  { sourceField: 'FromWarehouseCode', targetField: 'filler', sourceContext: 'inventory-transfer-request', includeInServiceLayerSelect: false },
  { sourceField: 'WarehouseCode', targetField: 'towhscode', sourceContext: 'inventory-transfer-request', includeInServiceLayerSelect: false },
];

// Invoices are not pushed to a HubSpot object; the mappings only drive the SAP $select. El
// negocio se resuelve por el linaje SAP (DocumentLines[].BaseEntry), no por NumAtCard: ese campo
// es la orden de compra del cliente y sólo viaja al log. DocumentLines NO va aquí a propósito,
// va como campo estructural en serviceLayerUrlBuilder.js para que borrar una fila del admin no
// rompa la reconciliación en silencio.
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

// Unlike company/contact, product has no S/4 code defaults: the field names
// (Product, to_Description.ProductDescription, BaseUnit...) are validated per
// tenant against that tenant's own Gateway and inserted directly as
// FieldMapping documents in the tenant DB. See ensureDefaultProductMappings
// below, which returns without seeding anything when sapFlavor is S4.

// S/4 contacts are the person-BP (BusinessPartnerCategory '1') reached from a
// company through to_BusinessPartnerContact. Unlike B1 (ContactEmployees
// embedded in the BusinessPartner), the person's name/email/phone live in its
// own A_BusinessPartner record. These mappings target that person-BP shape and
// are seeded under the tenant's own 'contact' ClientConfig. NOTE: the runtime
// extraction (relationship -> person join -> HubSpot association) is not yet
// implemented; this only seeds the structure so S/4 tenants are complete.
const DEFAULT_S4_CONTACT_MAPPINGS = [
  // The contact person is its own BusinessPartner in S/4. It is the contact's
  // internal code, not the customer's idsap: idsap identifies the company a
  // contact belongs to, and reusing it here would collide with company ids.
  { sourceField: 'BusinessPartner', targetField: 'internalcode', sourceContext: 'contactEmployee' },
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

  // No code defaults for S/4: product FieldMapping rows are DB-only for this
  // flavor (see the comment above DEFAULT_S4_PRODUCT_MAPPINGS's removal).
  if (sapFlavor === SAP_FLAVORS.S4) {
    return;
  }

  await ensureDefaultMappings({
    FieldMapping,
    clientConfig,
    mappings: DEFAULT_PRODUCT_MAPPINGS,
    objectType: 'product',
    editable: false,
  });
}

// Opt-in seeding for the Inventory Transfer Request context: call this from a tenant's
// onboarding flow (or the admin UI), not from ensureAll/DefaultClientConfigMappingInitializer.
// See the note above DEFAULT_INVENTORY_TRANSFER_REQUEST_DEAL_MAPPINGS for why.
export async function ensureDefaultInventoryTransferRequestMappings({ FieldMapping, clientConfig }) {
  if (clientConfig?.objectType === 'deal') {
    await ensureDefaultMappings({
      FieldMapping,
      clientConfig,
      mappings: DEFAULT_INVENTORY_TRANSFER_REQUEST_DEAL_MAPPINGS,
      objectType: 'deal',
    });
    return;
  }

  if (clientConfig?.objectType === 'product') {
    await ensureDefaultMappings({
      FieldMapping,
      clientConfig,
      mappings: DEFAULT_INVENTORY_TRANSFER_REQUEST_PRODUCT_MAPPINGS,
      objectType: 'product',
    });
  }
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
