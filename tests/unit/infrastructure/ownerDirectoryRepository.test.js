import OwnerDirectoryRepository from '../../../src/infrastructure/database/repositories/OwnerDirectoryRepository.js';

const ROWS = [
  { sapOwnerId: '600,601', hubspotOwnerId: '123123123', active: true },
];

function buildTenantModels({ sapFlavor = undefined, rows = ROWS } = {}) {
  return {
    Configuration: {
      findOne: () => ({
        lean: async () => (sapFlavor ? { key: 'sapFlavor', value: sapFlavor } : null),
      }),
    },
    OwnerMapping: {
      find: (filter) => ({
        lean: async () => rows.filter(
          (row) => filter.active !== true || row.active !== false
        ),
      }),
    },
  };
}

describe('OwnerDirectoryRepository', () => {
  const repository = new OwnerDirectoryRepository();

  it('carga el directorio en un tenant B1 (sin la clave sapFlavor, que es el default)', async () => {
    const directory = await repository.loadOwnerDirectory({
      tenantModels: buildTenantModels(),
      hubspotCredentialId: 'cred-1',
    });

    expect(directory?.sapToHubspot.get('600')).toBe('123123123');
    expect(directory?.sapToHubspot.get('601')).toBe('123123123');
  });

  // La homologación se acordó SOLO para B1: en S/4 el propietario no se resuelve
  // por SalesPersonCode, así que traducir ahí cambiaría datos sin pedirlo.
  it('devuelve null en un tenant S/4', async () => {
    const directory = await repository.loadOwnerDirectory({
      tenantModels: buildTenantModels({ sapFlavor: 'S4' }),
      hubspotCredentialId: 'cred-1',
    });

    expect(directory).toBeNull();
  });

  it('devuelve null sin credencial de HubSpot', async () => {
    const directory = await repository.loadOwnerDirectory({
      tenantModels: buildTenantModels(),
      hubspotCredentialId: null,
    });

    expect(directory).toBeNull();
  });

  // Es el estado actual del tenant printer: 91 filas sembradas desde HubSpot y
  // ni una con sapOwnerId. Sin filas útiles NO se devuelve un directorio vacío,
  // porque eso omitiría en silencio todos los campos de usuario.
  it('devuelve null cuando ninguna fila tiene sapOwnerId', async () => {
    const directory = await repository.loadOwnerDirectory({
      tenantModels: buildTenantModels({
        rows: [{ hubspotOwnerId: '9072589', sapOwnerId: null, active: true }],
      }),
      hubspotCredentialId: 'cred-1',
    });

    expect(directory).toBeNull();
  });

  it('no propaga un fallo de lectura', async () => {
    const directory = await repository.loadOwnerDirectory({
      tenantModels: {
        ...buildTenantModels(),
        OwnerMapping: { find: () => { throw new Error('mongo down'); } },
      },
      hubspotCredentialId: 'cred-1',
    });

    expect(directory).toBeNull();
  });
});
