import { jest } from '@jest/globals';
import ManageClientConfigs from '../../../src/application/use-cases/ManageClientConfigs.js';
import ManageSapCredentials from '../../../src/application/use-cases/ManageSapCredentials.js';
import { SECRET_MASK } from '../../../src/application/services/secret-fields.service.js';

// La API de administración devuelve los secretos enmascarados, pero la sync, el scheduler y
// los mappings por defecto necesitan el valor real: el enmascarado es solo de la respuesta.

function buildConfigDoc(fields) {
  const doc = {
    ...fields,
    save: jest.fn(async () => doc),
    toObject() {
      const { save, toObject, toJSON, ...rest } = this;
      return { ...rest };
    },
    toJSON() {
      return this.toObject();
    },
  };
  return doc;
}

function buildManageClientConfigs(repositoryOverrides = {}) {
  const scheduler = { syncScheduledJob: jest.fn() };
  const defaultMappingInitializer = { ensureAll: jest.fn() };
  const clientConfigRepository = {
    listClientConfigs: jest.fn(),
    findClientConfigById: jest.fn(),
    integrationModeExists: jest.fn().mockResolvedValue(true),
    findDefaultSapFilters: jest.fn().mockResolvedValue([]),
    createClientConfig: jest.fn(),
    ...repositoryOverrides,
  };
  const useCase = new ManageClientConfigs({
    clientConfigRepository,
    filterPolicy: {
      sanitizeIncomingCustomFilters: (filters) => filters || [],
      buildMergedFilters: () => ({ filters: [], defaultCount: 0, customCount: 0 }),
    },
    defaultMappingInitializer,
    scheduler,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return { useCase, scheduler, defaultMappingInitializer, clientConfigRepository };
}

describe('ManageClientConfigs secrets', () => {
  it('lists configs with apiToken and externalDbPassword masked', async () => {
    const { useCase } = buildManageClientConfigs({
      listClientConfigs: jest.fn().mockResolvedValue([
        buildConfigDoc({ _id: 'cfg-1', apiToken: 'real-token', externalDbPassword: 'db-pass' }),
        { _id: 'cfg-2', apiToken: '', externalDbPassword: null },
      ]),
    });

    const result = await useCase.listClientConfigs({ tenantModels: {} });

    expect(result.data).toEqual([
      { _id: 'cfg-1', apiToken: SECRET_MASK, externalDbPassword: SECRET_MASK },
      { _id: 'cfg-2', apiToken: null, externalDbPassword: null },
    ]);
  });

  it('keeps the stored secrets when a PATCH sends the mask back', async () => {
    const config = buildConfigDoc({ _id: 'cfg-1', clientName: 'old', apiToken: 'real-token', externalDbPassword: 'db-pass' });
    const { useCase } = buildManageClientConfigs({ findClientConfigById: jest.fn().mockResolvedValue(config) });

    const result = await useCase.patchClientConfig({
      tenantModels: {},
      tenantKey: 'printer',
      id: 'cfg-1',
      payload: { clientName: 'new', apiToken: SECRET_MASK, externalDbPassword: SECRET_MASK },
    });

    expect(config.apiToken).toBe('real-token');
    expect(config.externalDbPassword).toBe('db-pass');
    expect(config.clientName).toBe('new');
    expect(result.data).toMatchObject({ clientName: 'new', apiToken: SECRET_MASK, externalDbPassword: SECRET_MASK });
  });

  it('replaces a secret when a PATCH sends a new value, and schedules with the real one', async () => {
    const config = buildConfigDoc({ _id: 'cfg-1', apiToken: 'real-token' });
    const { useCase, scheduler } = buildManageClientConfigs({ findClientConfigById: jest.fn().mockResolvedValue(config) });

    const result = await useCase.patchClientConfig({
      tenantModels: {},
      tenantKey: 'printer',
      id: 'cfg-1',
      payload: { apiToken: 'rotated-token' },
    });

    expect(config.apiToken).toBe('rotated-token');
    expect(scheduler.syncScheduledJob.mock.calls[0][0].config.apiToken).toBe('rotated-token');
    expect(result.data.apiToken).toBe(SECRET_MASK);
  });

  it('masks the created config while mappings and scheduler get the real document', async () => {
    const created = buildConfigDoc({ _id: 'cfg-1', apiToken: 'real-token', externalDbPassword: 'db-pass' });
    const { useCase, scheduler, defaultMappingInitializer } = buildManageClientConfigs({
      createClientConfig: jest.fn().mockResolvedValue(created),
    });

    const result = await useCase.createClientConfig({
      tenantModels: { FieldMapping: {} },
      tenantKey: 'printer',
      payload: { integrationModeId: 'mode-1', apiToken: 'real-token', externalDbPassword: 'db-pass' },
    });

    expect(result.data).toMatchObject({ apiToken: SECRET_MASK, externalDbPassword: SECRET_MASK });
    expect(defaultMappingInitializer.ensureAll.mock.calls[0][0].clientConfig).toBe(created);
    expect(scheduler.syncScheduledJob.mock.calls[0][0].config).toBe(created);
  });
});

function buildManageSapCredentials(repositoryOverrides = {}) {
  const sapCredentialsRepository = {
    list: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    updateById: jest.fn(),
    deleteById: jest.fn(),
    findClientConfigById: jest.fn().mockResolvedValue({ _id: 'cfg-1' }),
    ...repositoryOverrides,
  };
  const useCase = new ManageSapCredentials({
    sapCredentialsRepository,
    objectIdValidator: { isValid: () => true },
  });
  return { useCase, sapCredentialsRepository };
}

const STORED = {
  _id: 'cred-1',
  clientConfigId: 'cfg-1',
  serviceLayerUsername: 'manager',
  serviceLayerPassword: 'sl-pass',
};

describe('ManageSapCredentials secrets', () => {
  it.each([
    ['list', { list: jest.fn().mockResolvedValue([STORED]) }, (uc) => uc.list({ tenantModels: {}, query: {} }), (data) => data[0]],
    ['get', { findById: jest.fn().mockResolvedValue(STORED) }, (uc) => uc.get({ tenantModels: {}, id: 'cred-1' }), (data) => data],
    ['delete', { deleteById: jest.fn().mockResolvedValue(STORED) }, (uc) => uc.delete({ tenantModels: {}, id: 'cred-1' }), (data) => data],
  ])('masks serviceLayerPassword on %s', async (_label, overrides, run, pick) => {
    const { useCase } = buildManageSapCredentials(overrides);

    const result = await run(useCase);

    expect(pick(result.data)).toMatchObject({ serviceLayerUsername: 'manager', serviceLayerPassword: SECRET_MASK });
  });

  it('stores the real password on create and answers it masked', async () => {
    const { useCase, sapCredentialsRepository } = buildManageSapCredentials({
      create: jest.fn().mockResolvedValue(STORED),
    });

    const result = await useCase.create({
      tenantModels: {},
      payload: {
        clientConfigId: 'cfg-1',
        serviceLayerBaseUrl: 'https://sl.test:50000',
        serviceLayerUsername: 'manager',
        serviceLayerPassword: 'sl-pass',
      },
    });

    expect(sapCredentialsRepository.create.mock.calls[0][0].payload.serviceLayerPassword).toBe('sl-pass');
    expect(result.data.serviceLayerPassword).toBe(SECRET_MASK);
  });

  it('does not overwrite the password when a PATCH sends the mask back', async () => {
    const { useCase, sapCredentialsRepository } = buildManageSapCredentials({
      updateById: jest.fn().mockResolvedValue(STORED),
    });

    const result = await useCase.patch({
      tenantModels: {},
      id: 'cred-1',
      payload: { serviceLayerUsername: 'manager2', serviceLayerPassword: SECRET_MASK },
    });

    const { payload } = sapCredentialsRepository.updateById.mock.calls[0][0];
    expect(payload).not.toHaveProperty('serviceLayerPassword');
    expect(payload.serviceLayerUsername).toBe('manager2');
    expect(result.data.serviceLayerPassword).toBe(SECRET_MASK);
  });

  it('updates the password when a PATCH sends a new one', async () => {
    const { useCase, sapCredentialsRepository } = buildManageSapCredentials({
      updateById: jest.fn().mockResolvedValue(STORED),
    });

    await useCase.patch({ tenantModels: {}, id: 'cred-1', payload: { serviceLayerPassword: 'rotated' } });

    expect(sapCredentialsRepository.updateById.mock.calls[0][0].payload.serviceLayerPassword).toBe('rotated');
  });
});
