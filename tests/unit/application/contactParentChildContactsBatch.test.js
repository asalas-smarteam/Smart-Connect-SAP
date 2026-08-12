import { jest } from '@jest/globals';
import SyncCompanyContactsInBatches from '../../../src/application/use-cases/SyncCompanyContactsInBatches.js';

describe('associateContactBatches — tipo de padre parametrizable', () => {
  function buildUseCase() {
    const batchAssociateDefault = jest.fn().mockResolvedValue({ status: 'COMPLETE', results: [] });
    const useCase = new SyncCompanyContactsInBatches({
      crmBatchClient: {
        batchAssociateDefault,
        associateObjectsDefault: jest.fn().mockResolvedValue({}),
        listAllObjects: jest.fn().mockResolvedValue([]),
        batchCreateObjects: jest.fn().mockResolvedValue({ results: [] }),
        batchUpdateObjects: jest.fn().mockResolvedValue({ results: [] }),
        listWritablePropertyNames: jest.fn().mockResolvedValue(null),
      },
      fieldMappingService: { getMappingsByObjectType: jest.fn(), mapRecords: jest.fn() },
      associationRegistry: { registerBaseObjectMappings: jest.fn() },
      bypassEmailConfigRepository: { getBypassEmail: jest.fn().mockResolvedValue(false) },
      identityProperty: 'internalcode',
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    return { useCase, batchAssociateDefault };
  }

  const entries = [{
    key: 'k1',
    company: { hubspotId: '100', sapCompanyId: 'C1' },
    sapInternalCode: 11,
    contactPayload: { properties: {} },
  }];

  it('con parentObjectType contact asocia contact -> contact', async () => {
    const { useCase, batchAssociateDefault } = buildUseCase();

    await useCase.associateContactBatches({
      entries,
      hubspotIdByKey: new Map([['k1', '900']]),
      clientConfig: { hubspotBatchSize: 10 },
      getToken: async () => 'tok',
      contactErrors: [],
      parentObjectType: 'contact',
    });

    expect(batchAssociateDefault).toHaveBeenCalledWith('tok', 'contact', 'contact', [{ fromId: '100', toId: '900' }]);
  });

  // GUARDIA DE REGRESION
  it('sin parentObjectType asocia company -> contact, como hoy', async () => {
    const { useCase, batchAssociateDefault } = buildUseCase();

    await useCase.associateContactBatches({
      entries,
      hubspotIdByKey: new Map([['k1', '900']]),
      clientConfig: { hubspotBatchSize: 10 },
      getToken: async () => 'tok',
      contactErrors: [],
    });

    expect(batchAssociateDefault).toHaveBeenCalledWith('tok', 'company', 'contact', [{ fromId: '100', toId: '900' }]);
  });

  it('descarta el par cuando el hijo es el mismo objeto que el padre (padre contact)', async () => {
    const { useCase, batchAssociateDefault } = buildUseCase();

    await useCase.associateContactBatches({
      entries,
      hubspotIdByKey: new Map([['k1', '100']]), // igual al padre
      clientConfig: { hubspotBatchSize: 10 },
      getToken: async () => 'tok',
      contactErrors: [],
      parentObjectType: 'contact',
    });

    expect(batchAssociateDefault).not.toHaveBeenCalled();
    expect(useCase.logger.warn).toHaveBeenCalled();
  });

  // REGRESION: con un padre company, un id de contact que coincida
  // numericamente con el id de la company es pura coincidencia (son espacios
  // de ids de HubSpot distintos: company vs contact). La guarda NO debe
  // dispararse aqui, o se perderia una asociacion legitima que existia antes
  // de esta tarea.
  it('NO descarta el par cuando el padre es company aunque el id del hijo coincida numericamente', async () => {
    const { useCase, batchAssociateDefault } = buildUseCase();

    await useCase.associateContactBatches({
      entries,
      hubspotIdByKey: new Map([['k1', '100']]), // coincide con el id de la company, pero son tipos distintos
      clientConfig: { hubspotBatchSize: 10 },
      getToken: async () => 'tok',
      contactErrors: [],
      // sin parentObjectType -> default 'company'
    });

    expect(batchAssociateDefault).toHaveBeenCalledWith('tok', 'company', 'contact', [{ fromId: '100', toId: '100' }]);
    expect(useCase.logger.warn).not.toHaveBeenCalled();
  });
});
