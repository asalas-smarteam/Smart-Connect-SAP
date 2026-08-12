import { jest } from '@jest/globals';
import PropertiesFlagsEnrichmentAdapter
  from '../../../src/infrastructure/sap/customers/PropertiesFlagsEnrichmentAdapter.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';
import { SapRecordEnricherPort } from '../../../src/application/ports/sap/sap-record-enricher.port.js';

const ON = { strategy: 'numberedMultiSelect', hubspotProperty: 'groupname', min: 1, max: 64, trueValue: 'tYES' };
const OFF = { strategy: 'none', hubspotProperty: null, min: 1, max: 64, trueValue: 'tYES' };

function buildAdapter({ config = ON, flavor = 'B1' } = {}) {
  return new PropertiesFlagsEnrichmentAdapter({
    configRepository: { getPropertiesFlagsConfig: jest.fn().mockResolvedValue(config) },
    flavorResolver: jest.fn().mockResolvedValue(flavor),
    logger: { warn: jest.fn(), error: jest.fn() },
  });
}

function buildRecords() {
  return [
    { properties: { idsap: 'C1' }, rawSapData: { Properties1: 'tYES', Properties2: 'tNO', Properties55: 'tYES' } },
    { properties: { idsap: 'C2' }, rawSapData: { Properties1: 'tNO' } },
  ];
}

describe('PropertiesFlagsEnrichmentAdapter', () => {
  it('cumple el puerto', () => {
    expect(() => assertPort(buildAdapter(), SapRecordEnricherPort)).not.toThrow();
  });

  it('escribe el string unido en la propiedad configurada', async () => {
    const records = buildRecords();
    await buildAdapter().enrich({ mappedRecords: records, objectType: 'company', tenantModels: {} });

    expect(records[0].properties.groupname).toBe('1;55');
  });

  // EL CASO DE DESELECCION: SAP es la fuente de la verdad.
  it('escribe string vacio cuando ninguna bandera esta en tYES', async () => {
    const records = buildRecords();
    await buildAdapter().enrich({ mappedRecords: records, objectType: 'company', tenantModels: {} });

    expect(records[1].properties.groupname).toBe('');
    expect(records[1].properties).toHaveProperty('groupname');
  });

  it('sirve igual para objectType contact', async () => {
    const records = buildRecords();
    await buildAdapter().enrich({ mappedRecords: records, objectType: 'contact', tenantModels: {} });

    expect(records[0].properties.groupname).toBe('1;55');
  });

  it('no escribe nada cuando la strategy esta apagada', async () => {
    const records = buildRecords();
    await buildAdapter({ config: OFF }).enrich({ mappedRecords: records, objectType: 'company', tenantModels: {} });

    expect(records[0].properties).not.toHaveProperty('groupname');
  });

  it('no escribe nada cuando falta hubspotProperty', async () => {
    const records = buildRecords();
    await buildAdapter({ config: { ...ON, hubspotProperty: null } })
      .enrich({ mappedRecords: records, objectType: 'company', tenantModels: {} });

    expect(records[0].properties).not.toHaveProperty('groupname');
  });

  it('es no-op en S/4', async () => {
    const records = buildRecords();
    await buildAdapter({ flavor: 'S4' }).enrich({ mappedRecords: records, objectType: 'company', tenantModels: {} });

    expect(records[0].properties).not.toHaveProperty('groupname');
  });

  it.each(['product', 'deal', 'invoice'])('es no-op para objectType %s', async (objectType) => {
    const records = buildRecords();
    const adapter = buildAdapter();
    await adapter.enrich({ mappedRecords: records, objectType, tenantModels: {} });

    expect(records[0].properties).not.toHaveProperty('groupname');
    expect(adapter.configRepository.getPropertiesFlagsConfig).not.toHaveBeenCalled();
  });

  it('sin tenantModels no hace nada', async () => {
    const records = buildRecords();
    await buildAdapter().enrich({ mappedRecords: records, objectType: 'company', tenantModels: null });

    expect(records[0].properties).not.toHaveProperty('groupname');
  });

  it('salta los registros sin rawSapData sin romper los demas', async () => {
    const records = [{ properties: {} }, ...buildRecords()];
    await buildAdapter().enrich({ mappedRecords: records, objectType: 'company', tenantModels: {} });

    expect(records[0].properties).not.toHaveProperty('groupname');
    expect(records[1].properties.groupname).toBe('1;55');
  });

  it('NUNCA lanza: un fallo al leer la config se loguea y sigue', async () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const adapter = new PropertiesFlagsEnrichmentAdapter({
      configRepository: { getPropertiesFlagsConfig: jest.fn().mockRejectedValue(new Error('mongo caido')) },
      flavorResolver: jest.fn().mockResolvedValue('B1'),
      logger,
    });

    const records = buildRecords();
    await expect(adapter.enrich({ mappedRecords: records, objectType: 'company', tenantModels: {} }))
      .resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    expect(records[0].properties).not.toHaveProperty('groupname');
  });

  it('lee la config UNA sola vez por corrida, no por registro', async () => {
    const adapter = buildAdapter();
    await adapter.enrich({ mappedRecords: buildRecords(), objectType: 'company', tenantModels: {} });

    expect(adapter.configRepository.getPropertiesFlagsConfig).toHaveBeenCalledTimes(1);
  });
});
