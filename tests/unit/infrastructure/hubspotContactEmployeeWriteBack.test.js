import { jest } from '@jest/globals';

const updateContact = jest.fn();
jest.unstable_mockModule('../../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  updateContact,
  updateCompany: jest.fn(),
  updateDeal: jest.fn(),
}));

const { HubspotWebhookAdapter } = await import('../../../src/infrastructure/hubspot/HubspotWebhookAdapter.js');

describe('updateContactEmployeeCodes', () => {
  beforeEach(() => { updateContact.mockReset(); updateContact.mockResolvedValue({ id: 'ok' }); });

  it('escribe internalcode en minusculas a cada contacto que fue ContactEmployee', async () => {
    const adapter = new HubspotWebhookAdapter();

    await adapter.updateContactEmployeeCodes({
      token: 'tok',
      internalCodes: [
        { contact: { hs_object_id: '10' }, internalCode: 11 },
        { contact: { hs_object_id: '20' }, internalCode: 12 },
      ],
    });

    expect(updateContact).toHaveBeenCalledTimes(2);
    expect(updateContact).toHaveBeenNthCalledWith(1, 'tok', '10', { properties: { internalcode: '11' } });
    expect(updateContact).toHaveBeenNthCalledWith(2, 'tok', '20', { properties: { internalcode: '12' } });
  });

  it('salta los contactos sin hs_object_id', async () => {
    const adapter = new HubspotWebhookAdapter();

    await adapter.updateContactEmployeeCodes({
      token: 'tok',
      internalCodes: [{ contact: {}, internalCode: 11 }],
    });

    expect(updateContact).not.toHaveBeenCalled();
  });

  it('no llama a HubSpot con una lista vacia', async () => {
    const adapter = new HubspotWebhookAdapter();

    expect(await adapter.updateContactEmployeeCodes({ token: 'tok', internalCodes: [] })).toEqual([]);
    expect(updateContact).not.toHaveBeenCalled();
  });
});
