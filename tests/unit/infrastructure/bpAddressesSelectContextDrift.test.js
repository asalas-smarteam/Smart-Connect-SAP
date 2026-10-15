import { fieldMappingSchema } from '../../../src/infrastructure/database/models/tenant/FieldMapping.js';
import { withBpAddressesSelectField } from '../../../src/domain/business-partners/bp-addresses-select.service.js';
import { normalizeAddressSyncConfig } from '../../../src/domain/business-partners/address-sync.service.js';
import { buildServiceLayerUrl } from '../../../src/infrastructure/sap/serviceLayerUrlBuilder.js';

// Drift guard. The domain keeps its own copy of the sourceContexts that sanitizeSelectFields
// (serviceLayerUrlBuilder.js) drops from the $select, because it cannot import from the
// infrastructure. A test on the two contexts known today only notices an entry that is removed or
// changed. This one walks every sourceContext a FieldMapping can have, so it also fails when the
// builder starts excluding a new context the domain does not know: an existing BPAddresses row
// would be trusted as "already selected", the builder would drop it, and BPAddresses would never
// be requested, so every address property would stay empty with no error.
const SOURCE_CONTEXTS = fieldMappingSchema.path('sourceContext').enumValues;

const ENABLED = normalizeAddressSyncConfig({
  required: true,
  addresses: [{ AddressType: 'bo_ShipTo', sourceField: 'Street', targetField: 'direccion_entrega' }],
});

const BASE = [
  { sourceField: 'CardCode', targetField: 'idsap', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
];

function selectedFields(mappings) {
  const url = decodeURIComponent(buildServiceLayerUrl(
    { serviceLayerBaseUrl: 'https://sap.example.com', serviceLayerPath: '/BusinessPartners', objectType: 'company', integrationModeName: 'SERVICE_LAYER' },
    mappings
  ));

  return url.match(/\$select=([^&]*)/)?.[1].split(',') ?? [];
}

describe('BPAddresses select injection against every sourceContext of a FieldMapping', () => {
  it('reads the contexts from the schema, so a new one is picked up by this guard', () => {
    expect(SOURCE_CONTEXTS).toEqual(expect.arrayContaining(['businessPartner', 'contactEmployee', 'bpAddress']));
    expect(SOURCE_CONTEXTS.length).toBeGreaterThan(3);
  });

  it.each(SOURCE_CONTEXTS)(
    'puts BPAddresses in the $select exactly once when an existing BPAddresses row has the %s context',
    (sourceContext) => {
      const existingRow = {
        sourceField: 'BPAddresses',
        targetField: null,
        sourceContext,
        includeInServiceLayerSelect: true,
        isActive: true,
      };

      const mappings = withBpAddressesSelectField([...BASE, existingRow], ENABLED, { objectType: 'company' });
      const select = selectedFields(mappings);

      expect(select.filter((field) => field === 'BPAddresses')).toHaveLength(1);
    }
  );
});
