import { jest } from '@jest/globals';

const mockFindDealByProperty = jest.fn();
const mockFindDealByName = jest.fn();
const mockResolvePipeline = jest.fn();
const mockResolveStage = jest.fn();
const mockGetMappedOwnerId = jest.fn();
const mockGetUpdateDealStageConfig = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/hubspot/hubspotClient.js', () => ({
  findDealByProperty: mockFindDealByProperty,
  findDealByName: mockFindDealByName,
  createDeal: jest.fn(),
  updateDeal: jest.fn(),
}));

jest.unstable_mockModule('../../src/infrastructure/database/repositories/dealMappingResolver.js', () => ({
  default: {
    resolvePipeline: mockResolvePipeline,
    resolveStage: mockResolveStage,
  },
}));

jest.unstable_mockModule('../../src/infrastructure/database/repositories/ownerMapping.service.js', () => ({
  getMappedOwnerId: mockGetMappedOwnerId,
}));

jest.unstable_mockModule('../../src/infrastructure/config/updateDealStage.config.js', () => ({
  getUpdateDealStageConfig: mockGetUpdateDealStageConfig,
}));

const { find, preprocess } = await import('../../src/infrastructure/hubspot/handlers/deal.handler.js');

const clientConfig = { hubspotCredentialId: 'cred-1' };
const tenantModels = {};

describe('deal.handler find (idempotency)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('finds an existing deal by sap_docentry when present', async () => {
    mockFindDealByProperty.mockResolvedValue({ id: 'deal-99' });
    const item = { properties: { sap_docentry: '1024', dealname: 'SO-1024' } };

    const result = await find({ token: 't', item });

    expect(mockFindDealByProperty).toHaveBeenCalledWith('t', 'sap_docentry', '1024');
    expect(mockFindDealByName).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'deal-99' });
  });

  it('falls back to dealname when sap_docentry yields no match', async () => {
    mockFindDealByProperty.mockResolvedValue(null);
    mockFindDealByName.mockResolvedValue({ id: 'deal-by-name' });
    const item = { properties: { sap_docentry: '1024', dealname: 'SO-1024' } };

    const result = await find({ token: 't', item });

    expect(mockFindDealByName).toHaveBeenCalledWith('t', 'SO-1024');
    expect(result).toEqual({ id: 'deal-by-name' });
  });

  it('searches only by dealname when no sap_docentry is provided', async () => {
    mockFindDealByName.mockResolvedValue(null);
    const item = { properties: { dealname: 'SO-1024' } };

    await find({ token: 't', item });

    expect(mockFindDealByProperty).not.toHaveBeenCalled();
    expect(mockFindDealByName).toHaveBeenCalledWith('t', 'SO-1024');
  });
});

describe('deal.handler preprocess (stage-only, no pipeline)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMappedOwnerId.mockResolvedValue(null);
  });

  it('forces the configured dealstage when updateDealStage.isRequired is true', async () => {
    mockGetUpdateDealStageConfig.mockResolvedValue({ isRequired: true, dealstage: 'closedwon' });
    const item = { properties: { dealname: 'SO-1', dealstage: 'O' } };

    await preprocess({ item, clientConfig, tenantModels });

    expect(item.properties.dealstage).toBe('closedwon');
    expect(item.properties.pipeline).toBeUndefined();
    expect(mockResolvePipeline).not.toHaveBeenCalled();
  });

  it('keeps the mapped dealstage when updateDealStage is not required', async () => {
    mockGetUpdateDealStageConfig.mockResolvedValue({ isRequired: false, dealstage: 'closedwon' });
    const item = { properties: { dealname: 'SO-1', dealstage: 'mapped-stage' } };

    await preprocess({ item, clientConfig, tenantModels });

    expect(item.properties.dealstage).toBe('mapped-stage');
    expect(item.properties.pipeline).toBeUndefined();
  });

  it('resolves pipeline + stage via mappings when an explicit pipeline is present', async () => {
    mockResolvePipeline.mockResolvedValue({ hubspotPipelineId: 'hs-pipe' });
    mockResolveStage.mockResolvedValue({ hubspotStageId: 'hs-stage' });
    const item = { properties: { dealname: 'SO-1', pipeline: 'SAP-PIPE', dealstage: 'SAP-STAGE' } };

    await preprocess({ item, clientConfig, tenantModels });

    expect(item.properties.pipeline).toBe('hs-pipe');
    expect(item.properties.dealstage).toBe('hs-stage');
    expect(mockGetUpdateDealStageConfig).not.toHaveBeenCalled();
  });
});
