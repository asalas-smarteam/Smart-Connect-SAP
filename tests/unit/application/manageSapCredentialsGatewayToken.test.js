import { jest } from '@jest/globals';
import ManageSapCredentials from '../../../src/application/use-cases/ManageSapCredentials.js';
import { SECRET_MASK } from '../../../src/application/services/secret-fields.service.js';

function buildUseCase(overrides = {}) {
  const sapCredentialsRepository = {
    create: jest.fn(async ({ payload }) => ({ _id: 'cred-1', ...payload })),
    updateById: jest.fn(async ({ payload }) => ({ _id: 'cred-1', ...payload })),
    findClientConfigById: jest.fn().mockResolvedValue({ _id: 'cfg-1' }),
    ...overrides,
  };
  const useCase = new ManageSapCredentials({
    sapCredentialsRepository,
    objectIdValidator: { isValid: () => true },
  });
  return { useCase, sapCredentialsRepository };
}

const basePayload = {
  clientConfigId: 'cfg-1',
  serviceLayerBaseUrl: 'https://sl.test',
  serviceLayerUsername: 'user',
  serviceLayerPassword: 'pass',
};

const create = (useCase, extra) => useCase.create({ tenantModels: {}, payload: { ...basePayload, ...extra } });
const patch = (useCase, payload) => useCase.patch({ tenantModels: {}, id: 'cred-1', payload });

describe('ManageSapCredentials serviceLayerGatewayToken', () => {
  it('stores a trimmed token on create and masks it in the response', async () => {
    const { useCase, sapCredentialsRepository } = buildUseCase();

    const result = await create(useCase, { serviceLayerGatewayToken: '  test-gateway-token ' });

    expect(result.ok).toBe(true);
    expect(sapCredentialsRepository.create.mock.calls[0][0].payload.serviceLayerGatewayToken)
      .toBe('test-gateway-token');
    expect(result.data.serviceLayerGatewayToken).toBe(SECRET_MASK);
    expect(JSON.stringify(result.data)).not.toContain('test-gateway-token');
  });

  it('creates without a token (optional) and reports it as null', async () => {
    const { useCase, sapCredentialsRepository } = buildUseCase();

    const result = await create(useCase, {});

    expect(result.ok).toBe(true);
    expect(sapCredentialsRepository.create.mock.calls[0][0].payload.serviceLayerGatewayToken).toBe('');
    expect(result.data.serviceLayerGatewayToken).toBeNull();
  });

  it('updates the token on patch and masks the response', async () => {
    const { useCase, sapCredentialsRepository } = buildUseCase();

    const result = await patch(useCase, { serviceLayerGatewayToken: 'test-gateway-token' });

    expect(sapCredentialsRepository.updateById.mock.calls[0][0].payload.serviceLayerGatewayToken)
      .toBe('test-gateway-token');
    expect(result.data.serviceLayerGatewayToken).toBe(SECRET_MASK);
  });

  it('clears the token when patch sends an empty string', async () => {
    const { useCase, sapCredentialsRepository } = buildUseCase();

    const result = await patch(useCase, { serviceLayerGatewayToken: '' });

    expect(sapCredentialsRepository.updateById.mock.calls[0][0].payload.serviceLayerGatewayToken).toBe('');
    expect(result.data.serviceLayerGatewayToken).toBeNull();
  });

  it('keeps the stored token when patch sends the mask back', async () => {
    const { useCase, sapCredentialsRepository } = buildUseCase();

    await patch(useCase, { serviceLayerUsername: 'other', serviceLayerGatewayToken: SECRET_MASK });

    expect(sapCredentialsRepository.updateById.mock.calls[0][0].payload)
      .not.toHaveProperty('serviceLayerGatewayToken');
  });

  it('leaves the token untouched on a partial patch that omits it', async () => {
    const { useCase, sapCredentialsRepository } = buildUseCase();

    await patch(useCase, { serviceLayerUsername: 'other' });

    expect(sapCredentialsRepository.updateById.mock.calls[0][0].payload)
      .not.toHaveProperty('serviceLayerGatewayToken');
  });
});
