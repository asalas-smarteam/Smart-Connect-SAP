import { jest } from '@jest/globals';
import { SyncSapConfigToHubspot } from '../../../src/application/use-cases/SyncSapConfigToHubspot.js';

const CONFIG = (objectType) => ({
  _id: 'cfg1', id: 'cfg1', active: true, objectType,
  hubspotCredentialId: 'cred1', mode: 'FULL',
});

function buildDeps({ objectType, propertiesFlagsConfig }) {
  const fetchData = jest.fn().mockResolvedValue([]);

  return {
    fetchData,
    config: CONFIG(objectType),
    useCase: new SyncSapConfigToHubspot({
      sapDataSource: { fetchData },
      mappingRepository: {
        ensureDefaultMappings: async () => {},
        findMappings: async () => ([
          { sourceField: 'CardCode', targetField: 'idsap', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true },
        ]),
        getDynamicDescriptionConfig: async () => null,
        mapRecords: async () => [],
      },
      hubspotSyncTarget: { send: jest.fn() },
      syncLogRepository: {
        start: async () => ({ _id: 'log1' }),
        finish: async () => {},
        markSyncSucceeded: async () => {},
      },
      clientConfigRepository: { findById: async () => CONFIG(objectType) },
      // Devuelve null a propósito: el use-case corta ahí con 'No HubSpot
      // credentials', DESPUES de haber llamado a fetchData, que es lo que este
      // test observa.
      hubspotCredentialRepository: { findByClientConfig: async () => null },
      businessPartnerCreationConfigRepository: {
        getPropertiesFlagsConfig: async () => propertiesFlagsConfig,
      },
      dateProvider: () => new Date('2026-08-11T00:00:00Z'),
    }),
  };
}

const FLAGS_ON = { strategy: 'numberedMultiSelect', hubspotProperty: 'groupname', min: 1, max: 3, trueValue: 'tYES' };
const FLAGS_OFF = { strategy: 'none', hubspotProperty: null, min: 1, max: 64, trueValue: 'tYES' };

function selectedFields(fetchData) {
  return fetchData.mock.calls[0][0].fetchOptions.mappings.map((mapping) => mapping.sourceField);
}

describe('SyncSapConfigToHubspot — inyeccion al $select', () => {
  it('para contact inyecta ContactEmployees y las PropertiesN', async () => {
    const { fetchData, useCase, config } = buildDeps({ objectType: 'contact', propertiesFlagsConfig: FLAGS_ON });

    await useCase.execute({ config, tenantContext: { tenantModels: {} } });

    const fields = selectedFields(fetchData);
    expect(fields).toContain('ContactEmployees');
    expect(fields).toContain('Properties1');
    expect(fields).toContain('Properties3');
  });

  it('para company inyecta las PropertiesN pero NO ContactEmployees', async () => {
    const { fetchData, useCase, config } = buildDeps({ objectType: 'company', propertiesFlagsConfig: FLAGS_ON });

    await useCase.execute({ config, tenantContext: { tenantModels: {} } });

    const fields = selectedFields(fetchData);
    expect(fields).not.toContain('ContactEmployees');
    expect(fields).toContain('Properties1');
  });

  // GUARDIA DE REGRESION
  it('con la config apagada el $select queda exactamente como hoy', async () => {
    const { fetchData, useCase, config } = buildDeps({ objectType: 'company', propertiesFlagsConfig: FLAGS_OFF });

    await useCase.execute({ config, tenantContext: { tenantModels: {} } });

    expect(selectedFields(fetchData)).toEqual(['CardCode']);
  });

  it('sin el repositorio inyectado el $select no cambia', async () => {
    const fetchData = jest.fn().mockResolvedValue([]);
    const useCase = new SyncSapConfigToHubspot({
      sapDataSource: { fetchData },
      mappingRepository: {
        ensureDefaultMappings: async () => {},
        findMappings: async () => ([{ sourceField: 'CardCode', targetField: 'idsap', sourceContext: 'businessPartner', includeInServiceLayerSelect: true, isActive: true }]),
        getDynamicDescriptionConfig: async () => null,
        mapRecords: async () => [],
      },
      hubspotSyncTarget: { send: jest.fn() },
      syncLogRepository: { start: async () => ({ _id: 'log1' }), finish: async () => {}, markSyncSucceeded: async () => {} },
      clientConfigRepository: { findById: async () => CONFIG('contact') },
      hubspotCredentialRepository: { findByClientConfig: async () => null },
      dateProvider: () => new Date('2026-08-11T00:00:00Z'),
    });

    await useCase.execute({ config: CONFIG('contact'), tenantContext: { tenantModels: {} } });

    // ContactEmployees SI se inyecta (no depende de la config); las PropertiesN no.
    const fields = selectedFields(fetchData);
    expect(fields).toContain('ContactEmployees');
    expect(fields.filter((field) => field.startsWith('Properties'))).toHaveLength(0);
  });
});
