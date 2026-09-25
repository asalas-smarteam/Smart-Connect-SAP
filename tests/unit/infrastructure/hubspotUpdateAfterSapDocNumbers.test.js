import { jest } from '@jest/globals';

const updateDeal = jest.fn();
jest.unstable_mockModule('../../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  updateDeal,
  updateCompany: jest.fn(),
  updateContact: jest.fn(),
}));

const { HubspotWebhookAdapter } = await import('../../../src/infrastructure/hubspot/HubspotWebhookAdapter.js');

const DEAL_MAPPINGS = [
  { sourceField: 'DocEntry', targetField: 'sap_docentry', isActive: true },
  { sourceField: 'DocNum', targetField: 'sap_docnum', isActive: true },
];

function buildArgs(orderResponse) {
  return {
    token: 'tok',
    payload: { deal: { hs_object_id: '77' } },
    dealMappings: DEAL_MAPPINGS,
    orderResponse,
    cardCode: 'CL001',
    syncCompany: false,
    syncContact: false,
  };
}

describe('updateAfterSap: número de documento de SAP en el negocio', () => {
  beforeEach(() => {
    updateDeal.mockReset();
    updateDeal.mockResolvedValue({ id: 'ok' });
  });

  // Business One manda siempre enteros. Este es el camino que corre hoy en producción para los
  // cuatro tenants, y tiene que quedar idéntico.
  it('B1: escribe DocEntry y DocNum como texto, igual que hoy', async () => {
    await new HubspotWebhookAdapter().updateAfterSap(buildArgs({ DocEntry: 12345, DocNum: 8001 }));

    expect(updateDeal).toHaveBeenCalledWith('tok', '77', {
      properties: { sap_docentry: '12345', sap_docnum: '8001' },
    });
  });

  // 0 es un DocEntry posible y no puede confundirse con "no vino": sigue viajando.
  it('B1: un 0 se escribe como "0", no se descarta', async () => {
    await new HubspotWebhookAdapter().updateAfterSap(buildArgs({ DocEntry: 0, DocNum: 0 }));

    expect(updateDeal).toHaveBeenCalledWith('tok', '77', {
      properties: { sap_docentry: '0', sap_docnum: '0' },
    });
  });

  it('B1: sin la clave en la respuesta no se escribe la propiedad', async () => {
    await new HubspotWebhookAdapter().updateAfterSap(buildArgs({ DocNum: 8001 }));

    expect(updateDeal).toHaveBeenCalledWith('tok', '77', {
      properties: { sap_docnum: '8001' },
    });
  });

  // El adapter de S/4 devuelve null cuando la respuesta no trae número de oferta. La guarda
  // anterior (`!== undefined`) lo dejaba pasar y HubSpot terminaba con el texto "null".
  it('S/4: un número nulo no escribe el texto "null" en la propiedad', async () => {
    await new HubspotWebhookAdapter().updateAfterSap(buildArgs({ DocEntry: null, DocNum: null }));

    expect(updateDeal).not.toHaveBeenCalled();
  });

  it('S/4: con un solo número nulo se escribe únicamente el que sí vino', async () => {
    await new HubspotWebhookAdapter().updateAfterSap(buildArgs({ DocEntry: 20000123, DocNum: null }));

    expect(updateDeal).toHaveBeenCalledWith('tok', '77', {
      properties: { sap_docentry: '20000123' },
    });
  });
});
