import { jest } from '@jest/globals';
import ManageSapCredentials, {
  sapCredentialsReasons,
} from '../../../src/application/use-cases/ManageSapCredentials.js';

function buildUseCase() {
  const sapCredentialsRepository = {
    create: jest.fn(async ({ payload }) => ({ _id: 'cred-1', ...payload })),
    updateById: jest.fn(async ({ payload }) => ({ _id: 'cred-1', ...payload })),
    findClientConfigById: jest.fn().mockResolvedValue({ _id: 'cfg-1' }),
  };
  const useCase = new ManageSapCredentials({
    sapCredentialsRepository,
    objectIdValidator: { isValid: () => true },
  });
  return { useCase, sapCredentialsRepository };
}

const basePayload = {
  clientConfigId: 'cfg-1',
  serviceLayerBaseUrl: 'https://s4.test:44300',
  serviceLayerUsername: 'user',
  serviceLayerPassword: 'pass',
};

const create = (useCase, extra) => useCase.create({ tenantModels: {}, payload: { ...basePayload, ...extra } });
const patch = (useCase, payload) => useCase.patch({ tenantModels: {}, id: 'cred-1', payload });

describe('ManageSapCredentials params', () => {
  it('accepts a params object on create and stores values as trimmed strings', async () => {
    const { useCase, sapCredentialsRepository } = buildUseCase();

    const result = await create(useCase, { params: { 'sap-client': ' 600 ', 'sap-language': 7 } });

    expect(result.ok).toBe(true);
    expect(sapCredentialsRepository.create.mock.calls[0][0].payload.params).toEqual({
      'sap-client': '600',
      'sap-language': '7',
    });
  });

  it('defaults params to {} on create when absent or null', async () => {
    const { useCase, sapCredentialsRepository } = buildUseCase();

    await create(useCase, {});
    await create(useCase, { params: null });

    expect(sapCredentialsRepository.create.mock.calls[0][0].payload.params).toEqual({});
    expect(sapCredentialsRepository.create.mock.calls[1][0].payload.params).toEqual({});
  });

  it('accepts params on patch', async () => {
    const { useCase, sapCredentialsRepository } = buildUseCase();

    const result = await patch(useCase, { params: { 'sap-client': '600' } });

    expect(result.ok).toBe(true);
    expect(sapCredentialsRepository.updateById.mock.calls[0][0].payload.params).toEqual({
      'sap-client': '600',
    });
  });

  it('leaves params untouched on a partial patch that omits them', async () => {
    const { useCase, sapCredentialsRepository } = buildUseCase();

    await patch(useCase, { serviceLayerUsername: 'other' });

    expect(sapCredentialsRepository.updateById.mock.calls[0][0].payload).not.toHaveProperty('params');
  });

  it.each([
    ['a $-prefixed key', { $top: '1' }],
    ['a key with invalid characters', { 'a b': '1' }],
    ['an array', ['a']],
    ['a string', 'sap-client=600'],
    ['an object value', { 'sap-client': { a: 1 } }],
    ['a non-finite number', { 'sap-client': Infinity }],
    ['a boolean value', { 'sap-client': true }],
    ['an empty string value', { 'sap-client': '' }],
    ['a blank string value', { 'sap-client': '   ' }],
  ])('rejects params containing %s', async (_label, params) => {
    const { useCase, sapCredentialsRepository } = buildUseCase();

    const result = await create(useCase, { params });

    expect(result).toMatchObject({ ok: false, reason: sapCredentialsReasons.BAD_REQUEST });
    expect(result.message).toMatch(/invalid/);
    expect(sapCredentialsRepository.create).not.toHaveBeenCalled();
  });

  it('rejects invalid params on patch', async () => {
    const { useCase } = buildUseCase();

    const result = await patch(useCase, { params: { $filter: 'x' } });

    expect(result).toMatchObject({ ok: false, reason: sapCredentialsReasons.BAD_REQUEST });
  });

  it.each(['https://s4.test:44300?sap-client=600', 'https://s4.test:44300#frag'])(
    'rejects serviceLayerBaseUrl %s on create and patch, pointing to params',
    async (url) => {
      const { useCase } = buildUseCase();

      const created = await create(useCase, { serviceLayerBaseUrl: url });
      const patched = await patch(useCase, { serviceLayerBaseUrl: url });

      [created, patched].forEach((result) => {
        expect(result).toMatchObject({ ok: false, reason: sapCredentialsReasons.BAD_REQUEST });
        expect(result.message).toMatch(/invalid/);
        expect(result.message).toMatch(/params/);
      });
    }
  );
});
