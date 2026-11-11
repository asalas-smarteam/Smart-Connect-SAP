import { jest } from '@jest/globals';

const mockUpdateDeal = jest.fn();

jest.unstable_mockModule('../../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  updateDeal: mockUpdateDeal,
  updateCompany: jest.fn(),
  updateContact: jest.fn(),
}));

const { HubspotWebhookAdapter } = await import(
  '../../../src/infrastructure/hubspot/HubspotWebhookAdapter.js'
);

const dealMappings = [
  { sourceField: 'DocEntry', targetField: 'doc_entry_prop' },
  { sourceField: 'DocNum', targetField: 'doc_num_prop' },
];

async function run(orderResponse) {
  const adapter = new HubspotWebhookAdapter();
  await adapter.updateAfterSap({
    token: 'token',
    payload: { deal: { hs_object_id: '99' } },
    dealMappings,
    orderResponse,
    cardCode: 'C1',
    syncCompany: false,
    syncContact: false,
  });
}

describe('HubspotWebhookAdapter.updateAfterSap document number', () => {
  beforeEach(() => mockUpdateDeal.mockReset());

  it('writes the alphanumeric document number when DocEntry/DocNum are null', async () => {
    await run({ DocEntry: null, DocNum: null, DocumentNumber: 'TD10007275' });

    expect(mockUpdateDeal).toHaveBeenCalledWith('token', '99', {
      properties: { doc_entry_prop: 'TD10007275', doc_num_prop: 'TD10007275' },
    });
  });

  it('prefers the numeric values when present', async () => {
    await run({ DocEntry: 20000123, DocNum: 20000123, DocumentNumber: '20000123' });

    expect(mockUpdateDeal).toHaveBeenCalledWith('token', '99', {
      properties: { doc_entry_prop: '20000123', doc_num_prop: '20000123' },
    });
  });

  it('keeps B1 behavior (no DocumentNumber, distinct DocEntry/DocNum)', async () => {
    await run({ DocEntry: 5, DocNum: 7 });

    expect(mockUpdateDeal).toHaveBeenCalledWith('token', '99', {
      properties: { doc_entry_prop: '5', doc_num_prop: '7' },
    });
  });

  it('writes nothing when no number is present', async () => {
    await run({ DocEntry: null, DocNum: null, DocumentNumber: null });

    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });
});
