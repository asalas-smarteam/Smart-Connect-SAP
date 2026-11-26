import { jest } from '@jest/globals';

const getValue = jest.fn();
jest.unstable_mockModule('../../../src/infrastructure/config/tenantConfiguration.service.js', () => ({
  default: { getValue },
}));

const { default: TenantWebhookRuntimeRepository } = await import(
  '../../../src/infrastructure/database/repositories/TenantWebhookRuntimeRepository.js'
);

describe('TenantWebhookRuntimeRepository.resolveConsumerFinalNitConfig', () => {
  const repository = new TenantWebhookRuntimeRepository();

  it('reads the consumerFinalNit key and normalizes it', async () => {
    getValue.mockResolvedValue({ enabled: true, identityProperty: 'cui' });
    await expect(repository.resolveConsumerFinalNitConfig({})).resolves.toEqual({
      enabled: true,
      identityProperty: 'cui',
    });
    expect(getValue).toHaveBeenCalledWith({}, 'consumerFinalNit', null);
  });

  it('is disabled when the key is absent', async () => {
    getValue.mockResolvedValue(null);
    await expect(repository.resolveConsumerFinalNitConfig({})).resolves.toEqual({
      enabled: false,
      identityProperty: null,
    });
  });
});
