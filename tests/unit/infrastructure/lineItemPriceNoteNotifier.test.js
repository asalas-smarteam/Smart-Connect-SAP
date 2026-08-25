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

  // El área de ventas ya no puede salir de la config: la declara el negocio. Ese texto no puede
  // sobrevivir en el archivo o la nota mentiría sobre de dónde salió el precio.
  it('ya no existe el aviso del fallback al área configurada', () => {
    const body = buildLineItemPriceNoteBody({
      customer: '100061',
      salesArea: { salesOrganization: 'DPDO', distributionChannel: '01', division: 'SC' },
      priceListType: 'ZC',
      updatedCount: 0,
      skippedLineItems: [{ itemCode: '80000017', reason: 'sin condición' }],
    });

    expect(body).not.toContain('no tiene área de ventas registrada en SAP');
    expect(body).not.toContain('configuradas por defecto');
  });

  it('con salesAreaMissing pide los campos y dice que los precios quedaron como estaban', () => {
    const body = buildLineItemPriceNoteBody({
      customer: '100061',
      reasonCode: 'salesAreaMissing',
      fatalErrorMessage: 'Deal has no sales organization or distribution channel',
    });

    expect(body).toContain('falta la organización de ventas');
    expect(body).toContain('Completá los dos campos');
    expect(body).toContain('quedaron como estaban');
    // NO puede decir que puso nada en 0: en este camino no se tocó ninguna línea.
    expect(body).not.toContain('se pusieron en 0');
  });

  it('con salesAreaNotFound dice que los precios se pusieron en 0 y lista las áreas reales', () => {
    const body = buildLineItemPriceNoteBody({
      customer: '100061',
      salesArea: { salesOrganization: 'MQGT', distributionChannel: '01', division: null },
      reasonCode: 'salesAreaNotFound',
      fatalErrorMessage: 'Customer 100061 is not registered in sales area MQGT/01 in SAP',
      customerSalesAreas: [
        { salesOrganization: 'CPDO', distributionChannel: '01', priceListType: 'ZD' },
        { salesOrganization: 'DPDO', distributionChannel: '01', priceListType: 'ZC' },
      ],
    });

    expect(body).toContain('no está registrado en esta área de ventas');
    expect(body).toContain('MQGT/01');
    expect(body).toContain('CPDO/01 (lista ZD), DPDO/01 (lista ZC)');
    expect(body).toContain('se pusieron en 0');
  });

  it('con salesAreaNotFound y sin áreas legibles omite la frase entera', () => {
    const body = buildLineItemPriceNoteBody({
      customer: '100061',
      reasonCode: 'salesAreaNotFound',
      fatalErrorMessage: 'Customer 100061 is not registered in sales area MQGT/01 in SAP',
      customerSalesAreas: [],
    });

    expect(body).toContain('no está registrado en esta área de ventas');
    expect(body).not.toContain('Las áreas de ventas que este cliente tiene');
  });

  it('descarta las áreas incompletas de la lista en vez de imprimir nulls', () => {
    const body = buildLineItemPriceNoteBody({
      customer: '100061',
      reasonCode: 'salesAreaNotFound',
      fatalErrorMessage: 'no registrado',
      customerSalesAreas: [
        { salesOrganization: 'CPDO', distributionChannel: null, priceListType: 'ZD' },
        { salesOrganization: 'DPDO', distributionChannel: '01', priceListType: null },
      ],
    });

    expect(body).toContain('DPDO/01');
    expect(body).not.toContain('CPDO');
    expect(body).not.toContain('null');
  });

  it('escapa el HTML de un código de área malicioso', () => {
    const body = buildLineItemPriceNoteBody({
      customer: '100061',
      reasonCode: 'salesAreaNotFound',
      fatalErrorMessage: 'no registrado',
      customerSalesAreas: [
        { salesOrganization: '<img src=x>', distributionChannel: '01', priceListType: 'ZD' },
      ],
    });

    expect(body).not.toContain('<img');
    expect(body).toContain('&lt;img src=x&gt;');
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
