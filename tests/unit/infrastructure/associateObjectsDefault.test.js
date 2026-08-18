import { jest } from '@jest/globals';

const axiosMock = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

const { associateObjectsDefault } = await import('../../../src/infrastructure/hubspot/hubspotClient.js');

describe('associateObjectsDefault', () => {
  beforeEach(() => {
    axiosMock.mockReset();
    axiosMock.mockResolvedValue({ data: { status: 'COMPLETE' } });
  });

  it('usa la ruta /associations/default/', async () => {
    await associateObjectsDefault('tok', 'contact', '233059562020', 'contact', '233053375747');

    expect(axiosMock).toHaveBeenCalledTimes(1);
    const [config] = axiosMock.mock.calls[0];

    expect(config.method).toBe('put');
    expect(config.url).toContain(
      '/crm/v4/objects/contact/233059562020/associations/default/contact/233053375747'
    );
    expect(config.headers.Authorization).toBe('Bearer tok');
  });

  // HubSpot ignora el cuerpo de esta ruta, pero exige `Content-Type:
  // application/json` y responde 415 sin él. Sin `data`, axios no manda cuerpo y
  // por tanto tampoco la cabecera: eso dejó 3 notas de error huérfanas el
  // 2026-08-17 (`Failed to notify webhook failure to HubSpot`, 415). El `{}` está
  // aquí SOLO para que axios derive la cabecera -- no lo quites por "no hace falta
  // cuerpo": eso reintroduce el 415.
  it('manda un cuerpo JSON vacio para que la peticion lleve Content-Type', async () => {
    await associateObjectsDefault('tok', 'note', '115027105138', 'deal', '59086426948');

    const [config] = axiosMock.mock.calls[0];

    expect(config.data).toEqual({});
  });

  it('sirve igual para company -> contact', async () => {
    await associateObjectsDefault('tok', 'company', '1', 'contact', '2');

    const [config] = axiosMock.mock.calls[0];
    expect(config.url).toContain('/crm/v4/objects/company/1/associations/default/contact/2');
  });

  it('devuelve el cuerpo de la respuesta', async () => {
    const result = await associateObjectsDefault('tok', 'contact', '1', 'contact', '2');

    expect(result).toEqual({ status: 'COMPLETE' });
  });
});
