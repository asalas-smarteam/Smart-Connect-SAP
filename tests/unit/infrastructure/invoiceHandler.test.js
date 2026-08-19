import { jest } from '@jest/globals';

const mockUpdateDeal = jest.fn();
const mockFindByDeal = jest.fn();
const mockGetUpdateDealStageConfig = jest.fn();

jest.unstable_mockModule('../../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  updateDeal: mockUpdateDeal,
}));

jest.unstable_mockModule(
  '../../../src/infrastructure/database/repositories/MongooseSapDocumentLinkRepository.js',
  () => ({
    default: class {
      findByDeal(...args) {
        return mockFindByDeal(...args);
      }
    },
  })
);

jest.unstable_mockModule('../../../src/infrastructure/config/updateDealStage.config.js', () => ({
  getUpdateDealStageConfig: mockGetUpdateDealStageConfig,
}));

const { process: processInvoice, SKIP_REASONS } = await import(
  '../../../src/infrastructure/hubspot/handlers/invoice.handler.js'
);

const tenantModels = { SapDocumentLink: {} };
const clientConfig = { hubspotCredentialId: 'cred-1' };

function buildLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('invoice.handler skip reasons', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindByDeal.mockResolvedValue({ sapDocNum: 25306 });
    mockGetUpdateDealStageConfig.mockResolvedValue({ isRequired: true, dealstage: 'closedwon' });
  });

  // Una factura ajena a HubSpot es el caso normal, no una anomalía: se
  // registra en debug para no inundar el log de una corrida de 500 facturas.
  it('reports the reason when NumAtCard does not carry a deal id', async () => {
    const logger = buildLogger();

    const result = await processInvoice({
      token: 't',
      item: { rawSapData: { NumAtCard: 'OC-4471', DocNum: 900 } },
      clientConfig,
      tenantModels,
      logger,
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: SKIP_REASONS.NO_DEAL_IN_NUM_AT_CARD,
    });
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  // Este sí es anómalo: la factura dice venir de un negocio de HubSpot pero no
  // hay pedido registrado. Es el caso que estuvo fallando en silencio.
  it('warns with the deal id when no order link exists', async () => {
    mockFindByDeal.mockResolvedValue(null);
    const logger = buildLogger();

    const result = await processInvoice({
      token: 't',
      item: { rawSapData: { NumAtCard: 'HS-DEAL-64175260456', DocNum: 900 } },
      clientConfig,
      tenantModels,
      logger,
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: SKIP_REASONS.ORDER_LINK_NOT_FOUND,
      dealId: '64175260456',
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      reason: SKIP_REASONS.ORDER_LINK_NOT_FOUND,
      dealId: '64175260456',
      sapDocNum: 900,
    }));
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  it('warns when updateDealStage is disabled or has no target stage', async () => {
    mockGetUpdateDealStageConfig.mockResolvedValue({ isRequired: false, dealstage: null });
    const logger = buildLogger();

    const result = await processInvoice({
      token: 't',
      item: { rawSapData: { NumAtCard: 'HS-DEAL-64175260456', DocNum: 900 } },
      clientConfig,
      tenantModels,
      logger,
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: SKIP_REASONS.UPDATE_DEAL_STAGE_DISABLED,
      dealId: '64175260456',
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      reason: SKIP_REASONS.UPDATE_DEAL_STAGE_DISABLED,
    }));
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  it('moves the deal and reports the target stage when every gate passes', async () => {
    const logger = buildLogger();

    const result = await processInvoice({
      token: 'token-1',
      item: { rawSapData: { NumAtCard: 'HS-DEAL-64175260456', DocNum: 900 } },
      clientConfig,
      tenantModels,
      logger,
    });

    expect(result).toEqual({ status: 'updated', dealId: '64175260456' });
    expect(mockUpdateDeal).toHaveBeenCalledWith('token-1', '64175260456', {
      properties: { dealstage: 'closedwon' },
    });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      dealId: '64175260456',
      dealstage: 'closedwon',
    }));
  });

  it('reports the failure reason and logs the error when HubSpot rejects the update', async () => {
    mockUpdateDeal.mockRejectedValue(new Error('400 invalid dealstage'));
    const logger = buildLogger();

    const result = await processInvoice({
      token: 't',
      item: { rawSapData: { NumAtCard: 'HS-DEAL-64175260456', DocNum: 900 } },
      clientConfig,
      tenantModels,
      logger,
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'failed',
      dealId: '64175260456',
      error: '400 invalid dealstage',
    }));
    expect(logger.error).toHaveBeenCalled();
  });
});
