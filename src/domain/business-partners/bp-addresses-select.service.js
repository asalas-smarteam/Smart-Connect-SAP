import { isAddressSyncEnabled } from './address-sync.service.js';

// SAP B1 returns the nested BPAddresses collection of a BusinessPartner only when it is in the
// $select, and no FieldMapping carries it: the addresses are configured in requireAddress.addresses,
// not mapped one field at a time. So when the address sync is on, the request has to ask for it.
//
// Same mould as withPropertiesFlagsSelectFields and withContactEmployeesSelectField: a synthetic
// mapping with targetField null that only builds the request to SAP. It never writes a HubSpot
// property, because mapRecords reads the mappings from Mongo on its own and never sees it.
const BP_ADDRESSES_FIELD = 'BPAddresses';

// A BusinessPartner is a company or a person (contact) in HubSpot; both carry BPAddresses.
const ENRICHED_OBJECT_TYPES = new Set(['company', 'contact']);

// Load-bearing: sanitizeSelectFields (serviceLayerUrlBuilder.js) excludes every mapping whose
// sourceContext is one of these. A synthetic with one of them would filter itself out and the
// symptom would be invisible: no BPAddresses in the $select, an empty collection in SAP's answer and
// no error. The list is repeated here because the domain cannot import from the infrastructure.
// bpAddressesSelectContextDrift.test.js keeps the two in step: it tries every sourceContext of the
// FieldMapping schema and checks the final URL, so it fails when either list gains, loses or
// changes a context.
const SELECT_EXCLUDED_SOURCE_CONTEXTS = new Set(['contactEmployee', 'bpAddress']);

// So the synthetic always carries this context.
const SYNTHETIC_SOURCE_CONTEXT = 'businessPartner';

function cleanString(value) {
  return String(value ?? '').trim();
}

// A mapping only puts its field in the $select when it is active, asks for it and has a context
// that sanitizeSelectFields keeps. A BPAddresses row that fails any of these is not "already
// selected": trusting it would skip the injection and the address properties would stay empty with
// no error.
function survivesTheSelect(mapping) {
  return (mapping?.isActive ?? true) !== false
    && mapping?.includeInServiceLayerSelect !== false
    && !SELECT_EXCLUDED_SOURCE_CONTEXTS.has(cleanString(mapping?.sourceContext));
}

export function withBpAddressesSelectField(mappings, addressConfig, { objectType } = {}) {
  const baseMappings = Array.isArray(mappings) ? mappings : [];

  if (!ENRICHED_OBJECT_TYPES.has(objectType)) {
    return Array.isArray(mappings) ? mappings : baseMappings;
  }

  // The config is the switch: a tenant that did not ask for the address sync keeps its request
  // exactly as it was.
  if (!isAddressSyncEnabled(addressConfig)) {
    return Array.isArray(mappings) ? mappings : baseMappings;
  }

  const alreadySelected = baseMappings
    .filter(survivesTheSelect)
    .some((mapping) => cleanString(mapping?.sourceField) === BP_ADDRESSES_FIELD);

  if (alreadySelected) {
    return mappings;
  }

  return [
    ...baseMappings,
    {
      sourceField: BP_ADDRESSES_FIELD,
      targetField: null,
      objectType,
      sourceContext: SYNTHETIC_SOURCE_CONTEXT,
      includeInServiceLayerSelect: true,
      isActive: true,
    },
  ];
}

export default { withBpAddressesSelectField };
