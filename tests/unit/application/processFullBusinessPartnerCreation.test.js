import { jest } from '@jest/globals';
import { resolveBusinessPartnerAndContactEmployees }
  from '../../../src/domain/business-partners/contact-employee-source.service.js';
import { buildBpAddresses } from '../../../src/domain/business-partners/bp-addresses.service.js';
import { buildSapPropertiesFlags }
  from '../../../src/domain/business-partners/sap-properties-flags.service.js';
import { mapHubspotToSapFields } from '../../../src/domain/orders/order-builder.service.js';

// Reproduce el bloque de cableado que las tareas insertan en los tres
// use-cases, para poder probarlo de forma aislada.
function wireBusinessPartnerInputs({ company, contact, contactEmployees, bpAddress, mappings, creationConfig, propertiesConfig }) {
  const shape = resolveBusinessPartnerAndContactEmployees({
    company, contact, contactEmployees, source: creationConfig.contactEmployeeSource,
  });

  const mappedAddresses = bpAddress.map((entry) => mapHubspotToSapFields(entry, mappings.addressMappings));
  const { addresses } = buildBpAddresses({
    mappedAddresses,
    addressesConfig: creationConfig.addresses,
    addressDefaults: creationConfig.defaults.BPAddress,
  });

  const mappedContactEmployees = shape.contactEmployeeSources.map((source) => ({
    ...creationConfig.defaults.ContactEmployee,
    ...mapHubspotToSapFields(source, mappings.contactEmployeeMappings),
  }));

  const { flags } = buildSapPropertiesFlags({
    hubspotValue: shape.businessPartner?.[propertiesConfig.hubspotProperty],
    config: propertiesConfig,
  });

  return { shape, addresses, mappedContactEmployees, propertiesFlags: flags };
}

describe('cableado de la creacion completa del BusinessPartner', () => {
  const mappings = {
    addressMappings: [
      { sourceField: 'AddressName', targetField: 'nombre_direccion', isActive: true },
      { sourceField: 'Street', targetField: 'calle', isActive: true },
    ],
    contactEmployeeMappings: [
      { sourceField: 'Name', targetField: 'firstname', isActive: true },
    ],
  };

  const creationConfig = {
    payloadStrategy: 'fullMapped',
    contactEmployeeSource: 'payloadArray',
    defaults: { BusinessPartner: {}, ContactEmployee: { Active: 'tYES' }, BPAddress: { TaxCode: 'IVA' } },
    addresses: {
      strategy: 'payloadArray',
      byName: { factura: { AddressType: 'bo_BillTo' }, entrega: { AddressType: 'bo_ShipTo' } },
      required: ['factura', 'entrega'],
    },
  };

  const propertiesConfig = {
    strategy: 'numberedMultiSelect', hubspotProperty: 'groupname', min: 1, max: 64, trueValue: 'tYES',
  };

  it('arma direcciones, contactos y banderas desde el payload', () => {
    const result = wireBusinessPartnerInputs({
      company: { hs_object_id: '1', name: 'ACME', groupname: '1;2;55' },
      contact: { hs_object_id: '2', firstname: 'Ignorado' },
      contactEmployees: [{ firstname: 'Ana' }, { firstname: 'Luis' }],
      bpAddress: [
        { nombre_direccion: 'factura', calle: 'Calle 1' },
        { nombre_direccion: 'entrega', calle: 'Calle 2' },
      ],
      mappings, creationConfig, propertiesConfig,
    });

    expect(result.shape.businessPartnerSource).toBe('company');
    expect(result.addresses).toEqual([
      { TaxCode: 'IVA', AddressType: 'bo_BillTo', AddressName: 'factura', Street: 'Calle 1' },
      { TaxCode: 'IVA', AddressType: 'bo_ShipTo', AddressName: 'entrega', Street: 'Calle 2' },
    ]);
    expect(result.mappedContactEmployees).toEqual([
      { Active: 'tYES', Name: 'Ana' },
      { Active: 'tYES', Name: 'Luis' },
    ]);
    expect(result.propertiesFlags).toEqual({
      Properties1: 'tYES', Properties2: 'tYES', Properties55: 'tYES',
    });
  });

  it('con la config por defecto no arma nada nuevo', () => {
    const legacyConfig = {
      payloadStrategy: 'legacyWhitelist',
      contactEmployeeSource: 'dealContact',
      defaults: { BusinessPartner: {}, ContactEmployee: {}, BPAddress: {} },
      addresses: { strategy: 'none', byName: {}, required: [] },
    };

    const result = wireBusinessPartnerInputs({
      company: { hs_object_id: '1', name: 'ACME' },
      contact: { hs_object_id: '2', firstname: 'Juan' },
      contactEmployees: [],
      bpAddress: [],
      mappings,
      creationConfig: legacyConfig,
      propertiesConfig: { strategy: 'none', hubspotProperty: null, min: 1, max: 64, trueValue: 'tYES' },
    });

    expect(result.addresses).toEqual([]);
    expect(result.propertiesFlags).toEqual({});
    expect(result.shape.contactEmployeeSources).toHaveLength(1);
  });

  it('lanza cuando falta una direccion obligatoria', () => {
    expect(() => wireBusinessPartnerInputs({
      company: { hs_object_id: '1' },
      contact: null,
      contactEmployees: [{ firstname: 'Ana' }],
      bpAddress: [{ nombre_direccion: 'factura', calle: 'Calle 1' }],
      mappings, creationConfig, propertiesConfig,
    })).toThrow(/entrega/);
  });
});
