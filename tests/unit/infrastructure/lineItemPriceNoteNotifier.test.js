import { jest } from '@jest/globals';
import { buildNotifyLineItemPriceOutcome } from '../../../src/infrastructure/hubspot/lineItemPriceNoteNotifier.service.js';
import { buildLineItemPriceNoteBody } from '../../../src/domain/prices/lineItemPriceNote.service.js';

function build({ requireMessageHS = true, createNote, associateObjectsDefault } = {}) {
  const hubspotClient = {
    createNote: createNote ?? jest.fn(async () => ({ id: 'note-1' })),
    associateObjectsDefault: associateObjectsDefault ?? jest.fn(async () => ({})),
  };
  const logger = { error: jest.fn(), warn: jest.fn() };

  return {
    hubspotClient,
    logger,
    notify: buildNotifyLineItemPriceOutcome({
      hubspotClient,
      getWebhookFailureNotificationConfig: jest.fn(async () => ({ requireMessageHS })),
      logger,
    }),
  };
}

const ARGS = { tenantModels: {}, tenantKey: 't', token: 'tok', dealId: '77', body: '<p>hola</p>' };

describe('buildNotifyLineItemPriceOutcome', () => {
  it('crea la nota y la asocia al deal', async () => {
    const { notify, hubspotClient } = build();

    await notify(ARGS);

    expect(hubspotClient.createNote).toHaveBeenCalledWith('tok', { body: '<p>hola</p>' });
    expect(hubspotClient.associateObjectsDefault)
      .toHaveBeenCalledWith('tok', 'note', 'note-1', 'deal', '77');
  });

  it('no escribe nada si el tenant no tiene requireMessageHS', async () => {
    const { notify, hubspotClient } = build({ requireMessageHS: false });

    await notify(ARGS);

    expect(hubspotClient.createNote).not.toHaveBeenCalled();
  });

  it.each([
    ['sin cuerpo', { body: null }],
    ['sin token', { token: null }],
    ['sin dealId', { dealId: null }],
  ])('no escribe nada %s', async (_label, override) => {
    const { notify, hubspotClient } = build();

    await notify({ ...ARGS, ...override });

    expect(hubspotClient.createNote).not.toHaveBeenCalled();
  });

  // La garantía que el caso de uso da por sentada: corre después de que el resultado ya se
  // decidió, así que un fallo de HubSpot acá no puede convertir una corrida exitosa en error.
  it('nunca lanza: un fallo de HubSpot se registra y se traga', async () => {
    const { notify, logger } = build({
      createNote: jest.fn(async () => { throw new Error('HubSpot 500'); }),
    });

    await expect(notify(ARGS)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: 'HubSpot 500' }));
  });

  it('tampoco lanza si falla la asociación, cuando la nota ya se creó', async () => {
    const { notify, logger } = build({
      associateObjectsDefault: jest.fn(async () => { throw new Error('409'); }),
    });

    await expect(notify(ARGS)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('buildLineItemPriceNoteBody', () => {
  it('devuelve null cuando todo se valorizó y no hubo error', () => {
    expect(buildLineItemPriceNoteBody({ updatedCount: 2, skippedLineItems: [] })).toBeNull();
  });

  it('lista las líneas sin precio con su motivo y el contexto de SAP', () => {
    const body = buildLineItemPriceNoteBody({
      customer: '111667',
      salesArea: { salesOrganization: 'MQGT', distributionChannel: '01', division: 'SC' },
      priceListType: 'ZA',
      updatedCount: 1,
      skippedLineItems: [{ id: '2', itemCode: '90001190', reason: 'no ZPR0 condition record' }],
    });

    expect(body).toContain('actualización parcial');
    expect(body).toContain('111667');
    expect(body).toContain('MQGT/01/SC');
    expect(body).toContain('ZA');
    expect(body).toContain('1 de 2 líneas');
    expect(body).toContain('90001190');
    expect(body).toContain('no ZPR0 condition record');
  });

  it('con error fatal dice el motivo y que las líneas quedaron como estaban', () => {
    const body = buildLineItemPriceNoteBody({
      customer: '111667',
      fatalErrorMessage: 'No line item prices could be resolved from S4 condition records',
      skippedLineItems: [{ itemCode: '90001190', reason: 'sin condición' }],
    });

    expect(body).toContain('no se pudieron actualizar');
    expect(body).toContain('No line item prices could be resolved');
    expect(body).toContain('90001190');
    expect(body).toContain('quedaron con el precio que ya tenían');
  });

  it('avisa cuando el área de ventas salió de la config y no del cliente', () => {
    const body = buildLineItemPriceNoteBody({
      customer: 'C00036',
      salesArea: { salesOrganization: 'DPDO', distributionChannel: '01', division: 'SC' },
      salesAreaSource: 'configuredDefault',
      priceListType: 'ZC',
      updatedCount: 0,
      skippedLineItems: [{ itemCode: '80000017', reason: 'sin condición' }],
    });

    expect(body).toContain('no tiene área de ventas registrada en SAP');
    expect(body).toContain('Verificá el código SAP del cliente');
  });

  it('escapa el HTML de los datos que vienen de SAP y de HubSpot', () => {
    const body = buildLineItemPriceNoteBody({
      customer: '<script>x</script>',
      updatedCount: 0,
      skippedLineItems: [{ itemCode: 'A&B', reason: '<b>malo</b>' }],
    });

    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;');
    expect(body).toContain('A&amp;B');
    expect(body).toContain('&lt;b&gt;malo&lt;/b&gt;');
  });
});
