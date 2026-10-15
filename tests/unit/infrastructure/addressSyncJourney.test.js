import { jest } from '@jest/globals';
import MappingSyncRepository from '../../../src/infrastructure/repositories/MappingSyncRepository.js';
import AddressSyncConfigRepository from '../../../src/infrastructure/config/AddressSyncConfigRepository.js';
import AddressSyncEnrichmentAdapter from '../../../src/infrastructure/sap/customers/AddressSyncEnrichmentAdapter.js';
import { withBpAddressesSelectField } from '../../../src/domain/business-partners/bp-addresses-select.service.js';
import { buildServiceLayerUrl } from '../../../src/infrastructure/sap/serviceLayerUrlBuilder.js';
import { sanitizeProperties } from '../../../src/application/services/hubspotPropertyPayload.service.js';
import { buildBatchUpdateEntry as buildCompanyEntry } from '../../../src/infrastructure/hubspot/handlers/company.handler.js';
import { buildBatchUpdateEntry as buildContactEntry } from '../../../src/infrastructure/hubspot/handlers/contact.handler.js';

// The whole AMC address journey for a company and a contact, with the real pieces wired together and
// only Mongo and SAP faked: requireAddress in Configurations -> repository -> $select -> SAP
// BusinessPartner -> mapRecords -> enricher -> sanitizeProperties, and then the two ways a record
// reaches HubSpot: created new, or updated when it already exists.
//
// AMC loads only the street (AMC_STREET_VALUE below). The six-property value keeps the journey
// proving that several rules can share one address row (street, city and state of the same ship-to).
const AMC_VALUE = {
  required: true,
  addresses: [
    { AddressType: 'bo_ShipTo', sourceField: 'Street', targetField: 'direccion_entrega' },
    { AddressType: 'bo_ShipTo', sourceField: 'City', targetField: 'ciudad_entrega' },
    { AddressType: 'bo_ShipTo', sourceField: 'State', targetField: 'departamento_entrega' },
    { AddressType: 'bo_BillTo', sourceField: 'Street', targetField: 'direccion_fiscal' },
    { AddressType: 'bo_BillTo', sourceField: 'City', targetField: 'ciudad_fiscal' },
    { AddressType: 'bo_BillTo', sourceField: 'State', targetField: 'departamento_fiscal' },
  ],
};

const AMC_STREET_VALUE = {
  required: true,
  addresses: [
    { AddressType: 'bo_ShipTo', sourceField: 'Street', targetField: 'direccion_entrega' },
    { AddressType: 'bo_BillTo', sourceField: 'Street', targetField: 'direccion_fiscal' },
  ],
};

const SIX_PROPERTIES = [
  'direccion_entrega', 'ciudad_entrega', 'departamento_entrega',
  'direccion_fiscal', 'ciudad_fiscal', 'departamento_fiscal',
];

const NAME_PROPERTY = { company: 'name', contact: 'firstname' };
const BUILD_ENTRY = { company: buildCompanyEntry, contact: buildContactEntry };

// No FieldMapping row for the six properties: the config is the only thing that knows them.
function rowsFor(objectType) {
  return [
    { sourceField: 'CardCode', targetField: 'idsap' },
    { sourceField: 'CardName', targetField: NAME_PROPERTY[objectType] },
    { sourceField: 'Country', targetField: 'pais' },
  ].map((row) => ({
    ...row,
    objectType,
    sourceContext: 'businessPartner',
    includeInServiceLayerSelect: true,
    isActive: true,
  }));
}

const ROWS = { company: rowsFor('company'), contact: rowsFor('contact') };

// Synthetic BusinessPartners, with the shape a B1 Service Layer returns.
const SHIP_TO = { AddressName: 'ENTREGA', AddressType: 'bo_ShipTo', Street: 'Calle de entrega 2', City: 'ESCUINTLA', State: '6' };
const BILL_TO = { AddressName: 'FISCAL', AddressType: 'bo_BillTo', Street: 'Calle fiscal 1', City: 'GUATEMALA', State: '7' };

const bp = (rows, overrides = {}) => ({
  CardCode: 'C90001',
  CardName: 'CLIENTE DE PRUEBA UNO',
  Country: 'GT',
  BPAddresses: rows,
  ...overrides,
});

const BASE_PROPERTIES = (objectType) => ({
  idsap: 'C90001',
  [NAME_PROPERTY[objectType]]: 'CLIENTE DE PRUEBA UNO',
  pais: 'GT',
});

const FULL_ADDRESS = {
  direccion_entrega: 'Calle de entrega 2',
  ciudad_entrega: 'ESCUINTLA',
  departamento_entrega: '6',
  direccion_fiscal: 'Calle fiscal 1',
  ciudad_fiscal: 'GUATEMALA',
  departamento_fiscal: '7',
};

function buildConfigurationModel(documentsByKey) {
  return {
    findOne({ key }) {
      return { lean: async () => (key in documentsByKey ? { key, value: documentsByKey[key] } : null) };
    },
  };
}

function tenantModelsFor(documentsByKey) {
  return { Configuration: buildConfigurationModel(documentsByKey), FieldMapping: {} };
}

// What one sync run does for one BusinessPartner, up to the properties that go to HubSpot.
async function syncOne(objectType, sapRecord, documentsByKey = { requireAddress: AMC_VALUE }) {
  const tenantModels = tenantModelsFor(documentsByKey);
  const mappingRepository = new MappingSyncRepository({
    fieldMappingRepository: { findByCredentialObjectAndContext: jest.fn(async () => ROWS[objectType]) },
  });

  const mapped = await mappingRepository.mapRecords({
    sapRecords: [sapRecord],
    hubspotCredentialId: 'cred-1',
    objectType,
    tenantContext: { tenantModels },
  });
  const records = mapped.map((record) => ({ ...record, rawSapData: sapRecord }));

  await new AddressSyncEnrichmentAdapter({
    configRepository: new AddressSyncConfigRepository(),
    logger: { warn: jest.fn(), error: jest.fn() },
  }).enrich({ mappedRecords: records, objectType, tenantModels });

  return { record: records[0], sent: sanitizeProperties(records[0].properties) };
}

describe.each(['company', 'contact'])('AMC addresses for a %s', (objectType) => {
  const nameProperty = NAME_PROPERTY[objectType];

  describe('the request to SAP', () => {
    // The deployment env var COMPANY_ADD_FIELDS_URL_SAP (ContactEmployees,BPAddresses in .env.example)
    // already adds BPAddresses to every company request, and there is no such variable for contact.
    // So the test does not pin the whole list, which depends on the environment: what matters is
    // that the base fields are there and BPAddresses comes once, never twice.
    it('asks for BPAddresses exactly once, next to the base fields', async () => {
      const config = await new AddressSyncConfigRepository()
        .getAddressSyncConfig({ tenantModels: tenantModelsFor({ requireAddress: AMC_VALUE }) });

      const mappings = withBpAddressesSelectField(ROWS[objectType], config, { objectType });
      const url = decodeURIComponent(buildServiceLayerUrl(
        { serviceLayerBaseUrl: 'https://sap.example.com', serviceLayerPath: '/BusinessPartners', objectType, integrationModeName: 'SERVICE_LAYER' },
        mappings
      ));
      const select = url.match(/\$select=([^&]*)/)?.[1].split(',') ?? [];

      expect(select).toEqual(expect.arrayContaining(['CardCode', 'CardName', 'Country', 'BPAddresses']));
      expect(select.filter((field) => field === 'BPAddresses')).toHaveLength(1);
    });
  });

  describe('a record that is created new', () => {
    it('gets the six address properties from the row of the right type, whatever the row order', async () => {
      const { sent } = await syncOne(objectType, bp([BILL_TO, SHIP_TO]));

      expect(sent).toEqual({ ...BASE_PROPERTIES(objectType), ...FULL_ADDRESS });
    });

    it('sends only the two streets with the AMC shape, whatever the row order', async () => {
      const { sent } = await syncOne(objectType, bp([BILL_TO, SHIP_TO]), { requireAddress: AMC_STREET_VALUE });

      expect(sent).toEqual({
        ...BASE_PROPERTIES(objectType),
        direccion_entrega: 'Calle de entrega 2',
        direccion_fiscal: 'Calle fiscal 1',
      });
    });

    it('keeps State as the SAP code, which is what the /States dropdown holds as its value', async () => {
      const { sent } = await syncOne(objectType, bp([SHIP_TO, BILL_TO]));

      expect(sent.departamento_entrega).toBe('6');
      expect(sent.departamento_fiscal).toBe('7');
    });

    it('does not send the city when SAP has it null, the shape seen on AMC, and keeps the rest', async () => {
      const { sent } = await syncOne(objectType, bp([
        { ...SHIP_TO, City: null, Street: 'COTZUMALGUAPA, ESCUINTLA' },
        { ...BILL_TO, City: null, Street: 'CIUDAD', State: '6' },
      ]));

      expect(sent).toEqual({
        ...BASE_PROPERTIES(objectType),
        direccion_entrega: 'COTZUMALGUAPA, ESCUINTLA',
        departamento_entrega: '6',
        direccion_fiscal: 'CIUDAD',
        departamento_fiscal: '6',
      });
    });

    it('does not send the properties of an address the BusinessPartner does not have', async () => {
      const { sent } = await syncOne(objectType, bp([SHIP_TO]));

      expect(Object.keys(sent).filter((key) => key.endsWith('_fiscal'))).toEqual([]);
      expect(sent.direccion_entrega).toBe('Calle de entrega 2');
    });

    it('sends nothing but the base properties for a BusinessPartner without addresses', async () => {
      const { sent } = await syncOne(objectType, bp([]));

      expect(sent).toEqual(BASE_PROPERTIES(objectType));
    });
  });

  describe('a tenant that did not ask for it keeps sending only the base properties', () => {
    it.each([
      ['has no requireAddress', {}],
      ['has the Printer value, required false', { requireAddress: { required: false } }],
      ['asked for it with nothing to write', { requireAddress: { required: true } }],
      ['is not on B1', { requireAddress: AMC_VALUE, sapFlavor: 'S4' }],
      ['still has the legacy byName document', { requireAddress: { required: true, byName: { entrega: { AddressType: 'bo_ShipTo', fields: { Street: 'direccion_entrega' } } } } }],
    ])('when it %s', async (_label, documentsByKey) => {
      const { sent } = await syncOne(objectType, bp([SHIP_TO, BILL_TO]), documentsByKey);

      expect(sent).toEqual(BASE_PROPERTIES(objectType));
    });
  });

  // A record that already exists in HubSpot is not rewritten: the update sends only the identifiers
  // plus what the tenant listed in hubspotUpdateFields (hubspot-update-fields.constants.js). So the
  // address reaches existing records only when the six properties are in that list.
  describe('a record that already exists in HubSpot', () => {
    const buildEntry = BUILD_ENTRY[objectType];

    const existing = (overrides = {}) => ({
      id: '501',
      properties: { idsap: 'C90001', [nameProperty]: 'CLIENTE DE PRUEBA UNO', ...overrides },
    });

    it('does not get the address when hubspotUpdateFields does not list it, even if something else changed', async () => {
      const { record } = await syncOne(objectType, bp([SHIP_TO, BILL_TO]));

      const entry = buildEntry({
        existing: existing({ [nameProperty]: 'NOMBRE VIEJO' }),
        item: record,
        updateFields: [],
      });

      expect(Object.keys(entry.properties)).toEqual(['idsap']);
    });

    it('does not even trigger an update for an address change alone when it is not listed', async () => {
      const { record } = await syncOne(objectType, bp([SHIP_TO, BILL_TO]));

      expect(buildEntry({ existing: existing({ direccion_entrega: 'CALLE VIEJA' }), item: record, updateFields: [] }))
        .toBeNull();
    });

    it('gets the six properties when hubspotUpdateFields lists them', async () => {
      const { record } = await syncOne(objectType, bp([SHIP_TO, BILL_TO]));

      const entry = buildEntry({
        existing: existing({ direccion_entrega: 'CALLE VIEJA' }),
        item: record,
        updateFields: SIX_PROPERTIES,
      });

      expect(entry.id).toBe('501');
      expect(entry.properties).toEqual({ idsap: 'C90001', ...FULL_ADDRESS });
    });

    it('is updated for an address change alone once the properties are listed', async () => {
      const { record } = await syncOne(objectType, bp([SHIP_TO, BILL_TO]));

      expect(buildEntry({ existing: existing({ direccion_fiscal: 'OTRA' }), item: record, updateFields: SIX_PROPERTIES }))
        .not.toBeNull();
    });

    it('is left alone when the address HubSpot already has equals the one in SAP', async () => {
      const { record } = await syncOne(objectType, bp([SHIP_TO, BILL_TO]));

      expect(buildEntry({ existing: existing(FULL_ADDRESS), item: record, updateFields: SIX_PROPERTIES })).toBeNull();
    });

    it('overwrites only the properties that were listed', async () => {
      const { record } = await syncOne(objectType, bp([SHIP_TO, BILL_TO]));

      const entry = buildEntry({
        existing: existing({ direccion_entrega: 'CALLE VIEJA' }),
        item: record,
        updateFields: ['direccion_entrega'],
      });

      expect(entry.properties).toEqual({ idsap: 'C90001', direccion_entrega: 'Calle de entrega 2' });
    });

    // The reason a value that SAP leaves empty never reaches HubSpot blank: it would erase what an
    // advisor typed by hand.
    it('keeps what was typed by hand when SAP has that value empty, even when it is listed', async () => {
      const { record } = await syncOne(objectType, bp([{ ...SHIP_TO, City: null }, BILL_TO]));

      const entry = buildEntry({
        existing: existing({ ciudad_entrega: 'ESCRITA A MANO', direccion_entrega: 'CALLE VIEJA' }),
        item: record,
        updateFields: SIX_PROPERTIES,
      });

      expect(entry.properties).not.toHaveProperty('ciudad_entrega');
      expect(entry.properties.direccion_entrega).toBe('Calle de entrega 2');
    });
  });
});
