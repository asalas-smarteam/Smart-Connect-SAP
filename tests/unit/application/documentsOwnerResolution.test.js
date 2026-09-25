import { jest } from '@jest/globals';
import { resolveDocumentsOwnerCode } from '../../../src/application/use-cases/webhookQuotationSupport.js';

// El digitador no es el propietario del negocio: sale de OTRA propiedad de HubSpot (la que el
// tenant declare en el mapeo) y se traduce por OTRO catalogo de SAP (sapOwnerId_2 = EmployeeID,
// no sapOwnerId = SlpCode). Los dos ids del deal de abajo son distintos a proposito para que un
// resolver que se equivoque de propiedad o de campo no pueda pasar los tests por coincidencia.
const deal = {
  hs_object_id: '64935472941',
  hubspot_owner_id: '82929213',
  digitador: '82929068',
};

const documentsOwnerMapping = {
  sourceField: 'DocumentsOwner',
  targetField: 'digitador',
  objectType: 'deal',
  sourceContext: 'orders-quotations',
  userField: true,
};

// printer: `ownercode` es una lista de HubSpot cuyo valor interno ya es el EmployeeID de SAP.
const directDocumentsOwnerMapping = {
  sourceField: 'DocumentsOwner',
  targetField: 'ownercode',
  objectType: 'deal',
  sourceContext: 'orders-quotations',
};

function buildDeps({ ownerMapping = null } = {}) {
  return {
    runtimeRepository: {
      findOwnerMappingByHubspotOwner: jest.fn().mockResolvedValue(ownerMapping),
    },
    tenantModels: {},
    hubspotCredentials: { _id: 'cred-1' },
    logger: { warn: jest.fn(), info: jest.fn() },
  };
}

describe('resolveDocumentsOwnerCode', () => {
  it('traduce la propiedad del mapeo contra sapOwnerId_2', async () => {
    const deps = buildDeps({ ownerMapping: { sapOwnerId: '64', sapOwnerId_2: '23' } });

    const result = await resolveDocumentsOwnerCode({
      ...deps,
      deal,
      dealMappings: [documentsOwnerMapping],
    });

    expect(result).toBe(23);
    // Entra por el digitador, NO por hubspot_owner_id: si entrara por el owner del negocio
    // el documento quedaria a nombre del asesor.
    expect(deps.runtimeRepository.findOwnerMappingByHubspotOwner).toHaveBeenCalledWith({
      tenantModels: deps.tenantModels,
      hubspotCredentialId: 'cred-1',
      hubspotOwnerId: '82929068',
    });
  });

  // El interruptor por tenant. Sin esta fila nadie consulta OwnerMappings y el payload sale
  // exactamente como salia antes del cambio.
  it('devuelve null y no consulta OwnerMappings cuando el tenant no mapeo DocumentsOwner', async () => {
    const deps = buildDeps({ ownerMapping: { sapOwnerId_2: '23' } });

    const result = await resolveDocumentsOwnerCode({
      ...deps,
      deal,
      dealMappings: [{ sourceField: 'Comments', targetField: 'comments' }],
    });

    expect(result).toBeNull();
    expect(deps.runtimeRepository.findOwnerMappingByHubspotOwner).not.toHaveBeenCalled();
  });

  it('ignora el mapeo desactivado', async () => {
    const deps = buildDeps({ ownerMapping: { sapOwnerId_2: '23' } });

    const result = await resolveDocumentsOwnerCode({
      ...deps,
      deal,
      dealMappings: [{ ...documentsOwnerMapping, isActive: false }],
    });

    expect(result).toBeNull();
    expect(deps.runtimeRepository.findOwnerMappingByHubspotOwner).not.toHaveBeenCalled();
  });

  // sapOwnerId (SlpCode) y sapOwnerId_2 (EmployeeID) son catalogos distintos: caer al primero
  // cuando falta el segundo asignaria OTRA persona y SAP lo aceptaria sin error.
  it('no cae a sapOwnerId cuando la fila no tiene sapOwnerId_2', async () => {
    const deps = buildDeps({ ownerMapping: { sapOwnerId: '64', sapOwnerId_2: null } });

    const result = await resolveDocumentsOwnerCode({
      ...deps,
      deal,
      dealMappings: [documentsOwnerMapping],
    });

    expect(result).toBeNull();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  // Un CSV es valido en sapOwnerId (N SlpCodes por persona) pero no sirve para escribir un
  // campo entero de SAP.
  it('descarta un sapOwnerId_2 no entero', async () => {
    const deps = buildDeps({ ownerMapping: { sapOwnerId_2: '23,24' } });

    const result = await resolveDocumentsOwnerCode({
      ...deps,
      deal,
      dealMappings: [documentsOwnerMapping],
    });

    expect(result).toBeNull();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('devuelve null cuando la propiedad del digitador llega vacia', async () => {
    const deps = buildDeps({ ownerMapping: { sapOwnerId_2: '23' } });

    const result = await resolveDocumentsOwnerCode({
      ...deps,
      deal: { ...deal, digitador: null },
      dealMappings: [documentsOwnerMapping],
    });

    expect(result).toBeNull();
    expect(deps.runtimeRepository.findOwnerMappingByHubspotOwner).not.toHaveBeenCalled();
  });

  it('devuelve null cuando el digitador no tiene OwnerMapping', async () => {
    const deps = buildDeps({ ownerMapping: null });

    const result = await resolveDocumentsOwnerCode({
      ...deps,
      deal,
      dealMappings: [documentsOwnerMapping],
    });

    expect(result).toBeNull();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  describe('mapeo sin userField (valor directo)', () => {
    it('manda el valor de la propiedad tal cual, sin consultar OwnerMappings', async () => {
      const deps = buildDeps({ ownerMapping: { sapOwnerId_2: '23' } });

      const result = await resolveDocumentsOwnerCode({
        ...deps,
        deal: { ...deal, ownercode: '210' },
        dealMappings: [directDocumentsOwnerMapping],
      });

      expect(result).toBe(210);
      expect(deps.runtimeRepository.findOwnerMappingByHubspotOwner).not.toHaveBeenCalled();
    });

    it('descarta un valor no entero', async () => {
      const deps = buildDeps();

      const result = await resolveDocumentsOwnerCode({
        ...deps,
        deal: { ...deal, ownercode: 'Juan Perez' },
        dealMappings: [directDocumentsOwnerMapping],
      });

      expect(result).toBeNull();
      expect(deps.logger.warn).toHaveBeenCalled();
    });

    it('devuelve null cuando la propiedad llega vacia', async () => {
      const deps = buildDeps();

      const result = await resolveDocumentsOwnerCode({
        ...deps,
        deal: { ...deal, ownercode: null },
        dealMappings: [directDocumentsOwnerMapping],
      });

      expect(result).toBeNull();
    });
  });
});
