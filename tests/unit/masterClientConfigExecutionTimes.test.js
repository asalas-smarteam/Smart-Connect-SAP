import { jest } from '@jest/globals';

const mockCreate = jest.fn();

jest.unstable_mockModule('../../src/infrastructure/database/models/master/ClientConfig.js', () => ({
  createMasterClientConfigModel: () => ({ create: mockCreate }),
}));

const { createMasterClientConfig } = await import(
  '../../src/infrastructure/config/masterClientConfig.service.js'
);

const base = {
  clientName: 'Obtener Productos',
  objectType: 'product',
  serviceLayerPath: '/Items',
  mode: 'FULL',
};

describe('masterClientConfig executionTime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockImplementation(async (payload) => payload);
  });

  it('accepts an array of times and stores it sorted', async () => {
    await createMasterClientConfig({}, { ...base, executionTime: ['15:00', '07:00'] });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      executionTime: ['07:00', '15:00'],
    }));
  });

  it('accepts a bare string and wraps it', async () => {
    await createMasterClientConfig({}, { ...base, executionTime: '01:00' });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      executionTime: ['01:00'],
    }));
  });

  it('rejects a badly formatted time', async () => {
    await expect(createMasterClientConfig({}, { ...base, executionTime: ['7:00'] }))
      .rejects.toThrow(/executionTime/);
  });

  it('rejects a FULL template with an empty array of times', async () => {
    await expect(createMasterClientConfig({}, { ...base, executionTime: [] }))
      .rejects.toThrow(/Missing required fields/);
  });
});
