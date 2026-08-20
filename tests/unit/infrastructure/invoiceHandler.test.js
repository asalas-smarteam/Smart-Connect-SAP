import { jest } from '@jest/globals';

const mockUpdateDeal = jest.fn();
const mockFindByOrderDocEntry = jest.fn();
const mockGetUpdateDealStageConfig = jest.fn();

jest.unstable_mockModule('../../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  updateDeal: mockUpdateDeal,
}));

jest.unstable_mockModule(
  '../../../src/infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js',
  () => ({
    default: class {
      findByOrderDocEntry(...args) {
        return mockFindByOrderDocEntry(...args);
      }
    },
  })
);

jest.unstable_mockModule('../../../src/infrastructure/config/updateDealStage.config.js', () => ({
  getUpdateDealStageConfig: mockGetUpdateDealStageConfig,
}));

const { process: processInvoice, extractOrderBaseEntries, SKIP_REASONS } = await import(
  '../../../src/infrastructure/hubspot/handlers/invoice.handler.js'
);

const tenantModels = { SapDocumentLink: {} };
const clientConfig = { hubspotCredentialId: 'cred-1' };

function buildLogger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('invoice.handler reconciliacion por linaje SAP', () => {
  // Una factura copiada de la orden 28987, como las de SBO_DISTELSA_PROD.
  function buildInvoice({ baseEntries = [28987], numAtCard = 'OC #P06485' } = {}) {
    return {
      rawSapData: {
        DocNum: 1024453,
        NumAtCard: numAtCard,
        DocumentLines: baseEntries.map((baseEntry) => ({ BaseType: 17, BaseEntry: baseEntry })),
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindByOrderDocEntry.mockResolvedValue({ dealId: '64175519381', sapDocNum: 25313 });
    mockGetUpdateDealStageConfig.mockResolvedValue({ isRequired: true, dealstage: 'closedwon' });
  });

  it('mueve el negocio del link de la orden que originó la factura', async () => {
    const logger = buildLogger();

    const result = await processInvoice({
      token: 'token-1', item: buildInvoice(), clientConfig, tenantModels, logger,
    });

    expect(mockFindByOrderDocEntry).toHaveBeenCalledWith({
      SapDocumentLink: tenantModels.SapDocumentLink,
      hubspotCredentialId: 'cred-1',
      sapDocEntry: 28987,
    });
    expect(mockUpdateDeal).toHaveBeenCalledWith('token-1', '64175519381', {
      properties: { dealstage: 'closedwon' },
    });
    expect(result).toEqual({
      status: 'updated', dealId: '64175519381', dealIds: ['64175519381'],
    });
  });

  // El NumAtCard del cliente ya no decide nada: es su OC y solo viaja al log.
  it('mueve el negocio aunque el NumAtCard sea la OC del cliente o venga vacio', async () => {
    for (const numAtCard of ['OC-4504297314', 'OC #P06485', '', null]) {
      jest.clearAllMocks();
      mockFindByOrderDocEntry.mockResolvedValue({ dealId: '64175519381' });
      mockGetUpdateDealStageConfig.mockResolvedValue({ isRequired: true, dealstage: 'closedwon' });

      const result = await processInvoice({
        token: 't', item: buildInvoice({ numAtCard }), clientConfig, tenantModels,
        logger: buildLogger(),
      });

      expect(result.status).toBe('updated');
    }
  });

  it('mueve todos los negocios cuando la factura consolida varias ordenes', async () => {
    mockFindByOrderDocEntry
      .mockResolvedValueOnce({ dealId: '111' })
      .mockResolvedValueOnce({ dealId: '222' });

    const result = await processInvoice({
      token: 't', item: buildInvoice({ baseEntries: [28987, 28991] }),
      clientConfig, tenantModels, logger: buildLogger(),
    });

    expect(mockUpdateDeal).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: 'updated', dealId: '111', dealIds: ['111', '222'] });
  });

  // Debug y no warn: en un tenant que factura sus propios pedidos esto es el caso normal.
  it('descarta en debug la factura que no viene de ninguna orden', async () => {
    const logger = buildLogger();

    const result = await processInvoice({
      token: 't',
      item: { rawSapData: { DocNum: 900, NumAtCard: 'OC-1', DocumentLines: [{ BaseType: 23, BaseEntry: 5 }] } },
      clientConfig, tenantModels, logger,
    });

    expect(result).toEqual({ status: 'skipped', reason: SKIP_REASONS.NO_ORDER_BASE_ENTRY });
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({
      reason: SKIP_REASONS.NO_ORDER_BASE_ENTRY, sapDocNum: 900,
    }));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  // 15 de 18 facturas de una corrida real caen aca: es el pedido propio del cliente, no una
  // anomalia. En warn inundaria el log en cada corrida.
  it('descarta en debug la factura de una orden que la integracion no creo', async () => {
    mockFindByOrderDocEntry.mockResolvedValue(null);
    const logger = buildLogger();

    const result = await processInvoice({
      token: 't', item: buildInvoice(), clientConfig, tenantModels, logger,
    });

    expect(result).toEqual({ status: 'skipped', reason: SKIP_REASONS.ORDER_LINK_NOT_FOUND });
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({
      reason: SKIP_REASONS.ORDER_LINK_NOT_FOUND, baseEntries: [28987],
    }));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  it('avisa en warn cuando updateDealStage esta apagado o sin etapa destino', async () => {
    mockGetUpdateDealStageConfig.mockResolvedValue({ isRequired: false, dealstage: null });
    const logger = buildLogger();

    const result = await processInvoice({
      token: 't', item: buildInvoice(), clientConfig, tenantModels, logger,
    });

    expect(result).toEqual({ status: 'skipped', reason: SKIP_REASONS.UPDATE_DEAL_STAGE_DISABLED });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      reason: SKIP_REASONS.UPDATE_DEAL_STAGE_DISABLED,
    }));
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  it('reporta el fallo y lo loguea cuando HubSpot rechaza el update', async () => {
    mockUpdateDeal.mockRejectedValue(new Error('400 invalid dealstage'));
    const logger = buildLogger();

    const result = await processInvoice({
      token: 't', item: buildInvoice(), clientConfig, tenantModels, logger,
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'failed', error: '400 invalid dealstage',
    }));
    expect(logger.error).toHaveBeenCalled();
  });

  // Con dos BaseEntry, el primer updateDeal resuelve y el segundo revienta (un 429 es el caso
  // mas probable en este repo): el negocio 1 ya se movio en HubSpot y no hay reintento por
  // item, asi que el log y el retorno tienen que dejar constancia de cual quedo movido.
  it('reporta los negocios ya movidos cuando una factura consolidada falla a mitad de camino', async () => {
    mockFindByOrderDocEntry
      .mockResolvedValueOnce({ dealId: '111' })
      .mockResolvedValueOnce({ dealId: '222' });
    mockUpdateDeal
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('429 rate limited'));
    const logger = buildLogger();

    const result = await processInvoice({
      token: 't', item: buildInvoice({ baseEntries: [28987, 28991] }),
      clientConfig, tenantModels, logger,
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'failed', error: '429 rate limited', movedDealIds: ['111'],
    }));
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      movedDealIds: ['111'],
      baseEntries: [28987, 28991],
      numAtCard: 'OC #P06485',
      sapDocNum: 1024453,
    }));
  });
});

describe('invoice.handler extractOrderBaseEntries', () => {
  // Verificado en SBO_DISTELSA_PROD: la factura 1024440 trae el mismo BaseEntry en sus tres
  // lineas. Sin deduplicar, el reconciliador movería el mismo negocio tres veces.
  it('deduplica el mismo BaseEntry repetido en varias lineas', () => {
    expect(extractOrderBaseEntries([
      { BaseType: 17, BaseEntry: 28967 },
      { BaseType: 17, BaseEntry: 28967 },
      { BaseType: 17, BaseEntry: 28967 },
    ])).toEqual([28967]);
  });

  // Los DocEntry de SAP son secuencias por objeto: la cotizacion 500 y la orden 500 coexisten.
  // Sin este filtro, una factura copiada de una cotizacion moveria el negocio de otra orden.
  it('descarta las lineas que no vienen de una orden', () => {
    expect(extractOrderBaseEntries([
      { BaseType: 23, BaseEntry: 55410 },
      { BaseType: 17, BaseEntry: 28987 },
      { BaseType: 13, BaseEntry: 999 },
    ])).toEqual([28987]);
  });

  it('devuelve varios BaseEntry cuando la factura consolida ordenes distintas', () => {
    expect(extractOrderBaseEntries([
      { BaseType: 17, BaseEntry: 28987 },
      { BaseType: 17, BaseEntry: 28991 },
    ])).toEqual([28987, 28991]);
  });

  it('devuelve un array vacio para entradas sin lineas de orden', () => {
    expect(extractOrderBaseEntries(null)).toEqual([]);
    expect(extractOrderBaseEntries(undefined)).toEqual([]);
    expect(extractOrderBaseEntries('no es un array')).toEqual([]);
    expect(extractOrderBaseEntries([])).toEqual([]);
    expect(extractOrderBaseEntries([{ BaseType: 17, BaseEntry: null }])).toEqual([]);
    expect(extractOrderBaseEntries([{ BaseType: 17 }])).toEqual([]);
    expect(extractOrderBaseEntries([{ BaseType: 17, BaseEntry: 'abc' }])).toEqual([]);
  });
});
