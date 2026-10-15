import { jest } from '@jest/globals';
import AddressSyncEnrichmentAdapter
  from '../../../src/infrastructure/sap/customers/AddressSyncEnrichmentAdapter.js';
import AddressSyncConfigRepository
  from '../../../src/infrastructure/config/AddressSyncConfigRepository.js';
import { normalizeAddressSyncConfig } from '../../../src/domain/business-partners/address-sync.service.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';
import { SapRecordEnricherPort } from '../../../src/application/ports/sap/sap-record-enricher.port.js';

const AMC = normalizeAddressSyncConfig({
  required: true,
  addresses: [
    { AddressType: 'bo_ShipTo', sourceField: 'Street', targetField: 'direccion_entrega' },
    { AddressType: 'bo_ShipTo', sourceField: 'City', targetField: 'ciudad_entrega' },
    { AddressType: 'bo_ShipTo', sourceField: 'State', targetField: 'departamento_entrega' },
    { AddressType: 'bo_BillTo', sourceField: 'Street', targetField: 'direccion_fiscal' },
    { AddressType: 'bo_BillTo', sourceField: 'City', targetField: 'ciudad_fiscal' },
    { AddressType: 'bo_BillTo', sourceField: 'State', targetField: 'departamento_fiscal' },
  ],
});

const SHIP_TO = { AddressName: 'ENTREGA', AddressType: 'bo_ShipTo', Street: 'Calle de entrega 2', City: 'ESCUINTLA', State: '6' };
const BILL_TO = { AddressName: 'FISCAL', AddressType: 'bo_BillTo', Street: 'Calle fiscal 1', City: 'GUATEMALA', State: '7' };

const SIX = {
  direccion_entrega: 'Calle de entrega 2',
  ciudad_entrega: 'ESCUINTLA',
  departamento_entrega: '6',
  direccion_fiscal: 'Calle fiscal 1',
  ciudad_fiscal: 'GUATEMALA',
  departamento_fiscal: '7',
};

const tenantModels = { Configuration: {} };

function record(rows, properties = { idsap: 'C90001', name: 'CLIENTE DE PRUEBA' }) {
  return { properties: { ...properties }, rawSapData: { CardCode: 'C90001', BPAddresses: rows } };
}

function buildAdapter(config) {
  const configRepository = { getAddressSyncConfig: jest.fn().mockResolvedValue(config) };
  const logger = { warn: jest.fn(), error: jest.fn() };

  return { adapter: new AddressSyncEnrichmentAdapter({ configRepository, logger }), configRepository, logger };
}

describe('AddressSyncEnrichmentAdapter', () => {
  it('meets the enricher port', () => {
    const { adapter } = buildAdapter(AMC);

    expect(() => assertPort(adapter, SapRecordEnricherPort)).not.toThrow();
  });

  it('meets the enricher port wired with the real repository', () => {
    const adapter = new AddressSyncEnrichmentAdapter({
      configRepository: new AddressSyncConfigRepository(),
      logger: { warn: jest.fn(), error: jest.fn() },
    });

    expect(() => assertPort(adapter, SapRecordEnricherPort)).not.toThrow();
  });

  describe.each(['company', 'contact'])('for a %s', (objectType) => {
    it('writes the six address properties into the mapped record, next to what it already had', async () => {
      const { adapter } = buildAdapter(AMC);
      const records = [record([BILL_TO, SHIP_TO])];

      await adapter.enrich({ mappedRecords: records, objectType, tenantModels });

      expect(records[0].properties).toEqual({ idsap: 'C90001', name: 'CLIENTE DE PRUEBA', ...SIX });
    });

    it('keeps State as the code SAP stores', async () => {
      const { adapter } = buildAdapter(AMC);
      const records = [record([SHIP_TO, BILL_TO])];

      await adapter.enrich({ mappedRecords: records, objectType, tenantModels });

      expect(records[0].properties.departamento_entrega).toBe('6');
      expect(records[0].properties.departamento_fiscal).toBe('7');
    });
  });

  it('writes only the two streets with the AMC shape', async () => {
    const { adapter } = buildAdapter(normalizeAddressSyncConfig({
      required: true,
      addresses: [
        { AddressType: 'bo_ShipTo', sourceField: 'Street', targetField: 'direccion_entrega' },
        { AddressType: 'bo_BillTo', sourceField: 'Street', targetField: 'direccion_fiscal' },
      ],
    }));
    const records = [record([BILL_TO, SHIP_TO])];

    await adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels });

    expect(records[0].properties).toEqual({
      idsap: 'C90001',
      name: 'CLIENTE DE PRUEBA',
      direccion_entrega: 'Calle de entrega 2',
      direccion_fiscal: 'Calle fiscal 1',
    });
  });

  it('wins over a value a mapping put in the same property', async () => {
    const { adapter } = buildAdapter(AMC);
    const records = [record([SHIP_TO], { idsap: 'C90001', direccion_entrega: 'valor del mapeo' })];

    await adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels });

    expect(records[0].properties.direccion_entrega).toBe('Calle de entrega 2');
  });

  it('leaves out the properties of an address the BusinessPartner does not have, never writing null', async () => {
    const { adapter } = buildAdapter(AMC);
    const records = [record([SHIP_TO])];

    await adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels });

    expect(Object.keys(records[0].properties).filter((key) => key.endsWith('_fiscal'))).toEqual([]);
    expect(Object.values(records[0].properties)).not.toContain(null);
    expect(records[0].properties.direccion_entrega).toBe('Calle de entrega 2');
  });

  it('leaves a record without addresses exactly as it was', async () => {
    const { adapter } = buildAdapter(AMC);
    const records = [record([])];

    await adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels });

    expect(records[0].properties).toEqual({ idsap: 'C90001', name: 'CLIENTE DE PRUEBA' });
  });

  it('enriches each record from its own raw SAP data', async () => {
    const { adapter } = buildAdapter(AMC);
    const other = { ...SHIP_TO, Street: 'Otra calle 9', State: '3' };
    const records = [record([SHIP_TO]), record([other])];

    await adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels });

    expect(records[0].properties.direccion_entrega).toBe('Calle de entrega 2');
    expect(records[1].properties.direccion_entrega).toBe('Otra calle 9');
    expect(records[1].properties.departamento_entrega).toBe('3');
  });

  it('skips a record with no raw SAP data or no properties', async () => {
    const { adapter } = buildAdapter(AMC);
    const withoutRaw = { properties: { idsap: 'C1' } };
    const withoutProperties = { rawSapData: { BPAddresses: [SHIP_TO] } };

    await expect(adapter.enrich({
      mappedRecords: [withoutRaw, withoutProperties, null],
      objectType: 'company',
      tenantModels,
    })).resolves.toBeUndefined();

    expect(withoutRaw.properties).toEqual({ idsap: 'C1' });
    expect(withoutProperties.properties).toBeUndefined();
  });

  describe('does nothing', () => {
    it.each(['product', 'deal', 'invoice', undefined])('for the object type %p', async (objectType) => {
      const { adapter, configRepository } = buildAdapter(AMC);
      const records = [record([SHIP_TO])];

      await adapter.enrich({ mappedRecords: records, objectType, tenantModels });

      expect(records[0].properties).toEqual({ idsap: 'C90001', name: 'CLIENTE DE PRUEBA' });
      expect(configRepository.getAddressSyncConfig).not.toHaveBeenCalled();
    });

    it('without tenantModels', async () => {
      const { adapter, configRepository } = buildAdapter(AMC);
      const records = [record([SHIP_TO])];

      await adapter.enrich({ mappedRecords: records, objectType: 'company' });

      expect(records[0].properties).toEqual({ idsap: 'C90001', name: 'CLIENTE DE PRUEBA' });
      expect(configRepository.getAddressSyncConfig).not.toHaveBeenCalled();
    });

    it.each([
      ['required is false', normalizeAddressSyncConfig({ required: false, addresses: [{ AddressType: 'bo_ShipTo', sourceField: 'Street', targetField: 'x' }] })],
      ['there are no addresses', { required: true, addresses: [] }],
      ['the tenant is not B1, where the repository clears addresses', { required: true, addresses: [] }],
      ['the config is null', null],
    ])('when %s', async (_label, config) => {
      const { adapter } = buildAdapter(config);
      const records = [record([SHIP_TO])];

      await adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels });

      expect(records[0].properties).toEqual({ idsap: 'C90001', name: 'CLIENTE DE PRUEBA' });
    });
  });

  it('reads the config once for the whole run, not once per record', async () => {
    const { adapter, configRepository } = buildAdapter(AMC);
    const records = [record([SHIP_TO]), record([SHIP_TO]), record([SHIP_TO])];

    await adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels });

    expect(configRepository.getAddressSyncConfig).toHaveBeenCalledTimes(1);
    expect(configRepository.getAddressSyncConfig).toHaveBeenCalledWith({ tenantModels });
  });

  it('tolerates a mappedRecords that is not a list', async () => {
    const { adapter } = buildAdapter(AMC);

    await expect(adapter.enrich({ mappedRecords: null, objectType: 'company', tenantModels })).resolves.toBeUndefined();
    await expect(adapter.enrich({ mappedRecords: undefined, objectType: 'contact', tenantModels })).resolves.toBeUndefined();
  });

  // A broken config must never abort the sync: the company still reaches HubSpot, just without
  // its addresses for this run.
  it('never throws, logs the failure and leaves the records alone', async () => {
    const configRepository = { getAddressSyncConfig: jest.fn().mockRejectedValue(new Error('mongo caido')) };
    const logger = { warn: jest.fn(), error: jest.fn() };
    const adapter = new AddressSyncEnrichmentAdapter({ configRepository, logger });
    const records = [record([SHIP_TO])];

    await expect(adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels })).resolves.toBeUndefined();

    expect(records[0].properties).toEqual({ idsap: 'C90001', name: 'CLIENTE DE PRUEBA' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls[0])).toContain('mongo caido');
  });
});
