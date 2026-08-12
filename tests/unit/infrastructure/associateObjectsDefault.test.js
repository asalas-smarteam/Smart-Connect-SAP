import { jest } from '@jest/globals';

const axiosMock = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

const { associateObjectsDefault } = await import('../../../src/infrastructure/hubspot/hubspotClient.js');

describe('associateObjectsDefault', () => {
  beforeEach(() => {
    axiosMock.mockReset();
    axiosMock.mockResolvedValue({ data: { status: 'COMPLETE' } });
  });

  it('usa la ruta /associations/default/ y no manda cuerpo', async () => {
    await associateObjectsDefault('tok', 'contact', '233059562020', 'contact', '233053375747');

    expect(axiosMock).toHaveBeenCalledTimes(1);
    const [config] = axiosMock.mock.calls[0];

    expect(config.method).toBe('put');
    expect(config.url).toContain(
      '/crm/v4/objects/contact/233059562020/associations/default/contact/233053375747'
    );
    expect(config.data).toBeUndefined();
    expect(config.headers.Authorization).toBe('Bearer tok');
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
