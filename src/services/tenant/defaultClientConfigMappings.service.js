const DEFAULT_CONTACT_EMPLOYEE_MAPPINGS = [
  { sourceField: 'Name', targetField: 'firstname', sourceContext: 'contactEmployee' },
  { sourceField: 'InternalCode', targetField: 'internalcode', sourceContext: 'contactEmployee' },
  { sourceField: 'Address', targetField: 'address', sourceContext: 'contactEmployee' },
  { sourceField: 'EmailAddress', targetField: 'email', sourceContext: 'contactEmployee' },
  { sourceField: 'CardName', targetField: 'firstname', sourceContext: 'businessPartner' },
  { sourceField: 'CardCode', targetField: 'idsap', sourceContext: 'businessPartner' },
  { sourceField: 'EmailAddress', targetField: 'email', sourceContext: 'businessPartner' },
];

const DEFAULT_COMPANY_EMPLOYEE_MAPPINGS = [
  { sourceField: 'CardName', targetField: 'name', sourceContext: 'businessPartner' },
  { sourceField: 'CardCode', targetField: 'idsap', sourceContext: 'businessPartner' },
  { sourceField: 'EmailAddress', targetField: 'email', sourceContext: 'businessPartner' },
];


const DEFAULT_PRODUCT_MAPPINGS = [
  { sourceField: 'OnHand', targetField: 'OnHand', sourceContext: 'ItemWarehouseInfoCollection' },
  { sourceField: 'OnHold', targetField: 'OnHold', sourceContext: 'ItemWarehouseInfoCollection' },
  { sourceField: 'Committed', targetField: 'Committed', sourceContext: 'ItemWarehouseInfoCollection' },
  { sourceField: 'ItemCode', targetField: 'hs_sku', sourceContext: 'product' },
  { sourceField: 'ItemName', targetField: 'name', sourceContext: 'product' },
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
      }
    })
  );
}


export async function ensureDefaultCompanyEmployeeMappings({ FieldMapping, clientConfig }) {
  if (clientConfig?.objectType === 'company') {
    return;
  }

  await ensureDefaultMappings({
    FieldMapping,
    clientConfig,
    mappings: DEFAULT_COMPANY_EMPLOYEE_MAPPINGS,
    objectType: 'company',
    sourceContext: 'businessPartner',
  });
}

export async function ensureDefaultContactEmployeeMappings({ FieldMapping, clientConfig }) {
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

export async function ensureDefaultProductMappings({ FieldMapping, clientConfig }) {
  if (clientConfig?.objectType !== 'product') {
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

