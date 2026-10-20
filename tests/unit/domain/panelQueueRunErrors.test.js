import {
  deriveQueueErrorItem,
  isQueueErrorList,
  queueEntryMessage,
  queueEntryRecord,
  queueRunSummary,
} from '../../../src/domain/panel/queueRunErrors.js';
import { clientSyncErrorMessage } from '../../../src/domain/panel/operationViews.js';

// Formas reales de buildWebhookSyncErrorEntry según el camino que falló.
const generic = {
  payload_Hubspot: { deal: { hs_object_id: '18374652901', dealname: 'Renovación' } },
  payload_SAP: null,
  response_hubspot: null,
  response_SAP: { name: 'Error', message: 'El Correo Electrónico del Socio no puede ser omitido.', status: 400 },
};
const useCase = {
  payload_Hubspot: { deal: { hs_object_id: 555 } },
  payload_SAP: { CardCode: 'C1' },
  response_hubspot: null,
  response_SAP: { DocEntry: null, error: { name: 'AxiosError', message: 'connect ETIMEDOUT 18.213.238.80:443' } },
};
const priceList = { payload_Hubspot: { dealId: '777' }, payload_SAP: null, response_hubspot: { message: 'Lista de precios sin mapear' }, response_SAP: [] };
const runnerDown = {
  payload_Hubspot: { tenantId: 't', tenantKey: 'sap_integration_acme', portalId: null, triggerType: 'worker' },
  payload_SAP: null,
  response_hubspot: null,
  response_SAP: { name: 'Error', message: 'Tenant not found or inactive for webhook processing' },
};

describe('queue run errors (plan 5b)', () => {
  it('recognizes only lists of webhook error entries', () => {
    expect(isQueueErrorList([generic, useCase])).toBe(true);
    expect(isQueueErrorList([])).toBe(false);
    expect(isQueueErrorList('texto')).toBe(false);
    expect(isQueueErrorList([{ record: 'x', message: 'y' }])).toBe(false);
    expect(isQueueErrorList([generic, 'texto'])).toBe(false);
  });

  it('reads the record and the message from every real shape', () => {
    expect([generic, useCase, priceList, runnerDown].map(queueEntryRecord)).toEqual(['18374652901', '555', '777', null]);
    expect([generic, useCase, priceList, runnerDown].map(queueEntryMessage)).toEqual([
      'El Correo Electrónico del Socio no puede ser omitido.',
      'connect ETIMEDOUT 18.213.238.80:443',
      'Lista de precios sin mapear',
      'Tenant not found or inactive for webhook processing',
    ]);
    expect(queueEntryMessage({ payload_SAP: null })).toBeNull();
  });

  it('sanitizes the message for clients and keeps it raw for Smarteam', () => {
    expect(deriveQueueErrorItem(useCase, { eventId: 'e1' })).toEqual({ record: '555', message: 'Tiempo de espera agotado.', eventId: 'e1' });
    expect(deriveQueueErrorItem(useCase, { side: 'smarteam' })).toEqual({ record: '555', message: 'connect ETIMEDOUT 18.213.238.80:443', eventId: null });
    expect(deriveQueueErrorItem({ payload_SAP: {} })).toEqual({ record: null, message: 'Error sin detalle', eventId: null });
  });

  it('builds the summary with the first message, singular and plural', () => {
    expect(queueRunSummary([generic])).toBe('1 error en la corrida: El Correo Electrónico del Socio no puede ser omitido.');
    expect(queueRunSummary([useCase, generic, generic])).toBe('3 errores en la corrida: Tiempo de espera agotado.');
    expect(queueRunSummary([{ payload_SAP: {} }])).toBe('1 error(es) en la corrida');
    expect(clientSyncErrorMessage([generic])).toEqual({ summary: '1 error en la corrida: El Correo Electrónico del Socio no puede ser omitido.' });
    expect(clientSyncErrorMessage([{ other: 1 }, { other: 2 }])).toEqual({ summary: '2 error(es) en la corrida' });
  });
});
