import { jest } from '@jest/globals';

// El handler importa hubspotClient y las utils de búsqueda estáticamente:
// se mockean ANTES del import dinámico del handler (patrón ESM del repo).
jest.unstable_mockModule('../../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  findContactByProperty: jest.fn(async () => null),
  findContactByEmail: jest.fn(async () => null),
  createContact: jest.fn(),
  updateContact: jest.fn(),
}));

jest.unstable_mockModule(
  '../../../src/infrastructure/hubspot/handlers/utils/searchProperties.utils.js',
  () => ({ buildMappedSearchProperties: jest.fn(async () => ['email', 'internalcode']) })
);

const hubspotClient = await import('../../../src/infrastructure/hubspot/hubspotClient.js');
const { findContactEmployee } = await import(
  '../../../src/infrastructure/hubspot/handlers/contact.handler.js'
);

beforeEach(() => jest.clearAllMocks());

describe('findContactEmployee', () => {
  it('busca por internalcode PRIMERO y no toca el email si lo encuentra', async () => {
    hubspotClient.findContactByProperty.mockResolvedValueOnce({ id: 'hs-1' });

    const result = await findContactEmployee({
      token: 't', internalcode: 91643, email: 'recepcion@tecnopack.net', clientConfig: {}, tenantModels: {},
    });

    expect(result).toEqual({ id: 'hs-1' });
    expect(hubspotClient.findContactByProperty).toHaveBeenCalledWith(
      't', 'internalcode', '91643', { properties: ['email', 'internalcode'] }
    );
    expect(hubspotClient.findContactByEmail).not.toHaveBeenCalled();
  });

  it('cae al email al FINAL cuando el internalcode no matchea', async () => {
    hubspotClient.findContactByEmail.mockResolvedValueOnce({ id: 'hs-2' });

    const result = await findContactEmployee({
      token: 't', internalcode: 91643, email: 'recepcion@tecnopack.net', clientConfig: {}, tenantModels: {},
    });

    expect(result).toEqual({ id: 'hs-2' });
    expect(hubspotClient.findContactByEmail).toHaveBeenCalledWith(
      't', 'recepcion@tecnopack.net', { properties: ['email', 'internalcode'] }
    );
  });

  it('sin internalcode va directo al email; sin nada devuelve null', async () => {
    await findContactEmployee({ token: 't', internalcode: null, email: 'a@b.com', clientConfig: {}, tenantModels: {} });
    expect(hubspotClient.findContactByProperty).not.toHaveBeenCalled();
    expect(hubspotClient.findContactByEmail).toHaveBeenCalledTimes(1);

    const empty = await findContactEmployee({ token: 't', internalcode: '', email: '', clientConfig: {}, tenantModels: {} });
    expect(empty).toBeNull();
  });
});
