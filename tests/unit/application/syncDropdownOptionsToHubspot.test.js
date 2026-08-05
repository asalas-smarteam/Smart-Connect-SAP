import { jest } from '@jest/globals';
import SyncDropdownOptionsToHubspot from '../../../src/application/use-cases/SyncDropdownOptionsToHubspot.js';
import { normalizeDropdownOptionsConfig } from '../../../src/domain/sync/dropdown-options.service.js';
import { DROPDOWN_WARNING_CODES } from '../../../src/domain/sync/dropdown-options.constants.js';

const CREDENTIAL_ID = 'cred-1';
const CONFIG_ID = 'config-1';

function buildHarness({
  dropdownConfigValue,
  rows = {},
  properties = {},
  targets = [],
  sapFlavor = 'B1',
  fetchRows,
  updatePropertyOptions,
} = {}) {
  const warnings = [];
  const finishedLogs = [];
  const updates = [];

  const dropdownConfigRepository = {
    getDropdownOptionsConfig: jest.fn(async () =>
      normalizeDropdownOptionsConfig(dropdownConfigValue)),
  };

  const dropdownCatalog = {
    fetchRows: fetchRows ?? jest.fn(async ({ serviceLayerPath }) => rows[serviceLayerPath] ?? []),
  };

  const dropdownTargetRepository = {
    findTargetsBySourceFields: jest.fn(async ({ sourceFields }) =>
      targets.filter((target) => sourceFields.includes(target.sourceField))),
  };

  const hubspotPropertyGateway = {
    findProperty: jest.fn(async ({ objectType, propertyName }) =>
      properties[`${objectType}.${propertyName}`] ?? null),
    updatePropertyOptions: updatePropertyOptions ?? jest.fn(async (payload) => {
      updates.push(payload);
      return payload;
    }),
  };

  const useCase = new SyncDropdownOptionsToHubspot({
    dropdownConfigRepository,
    dropdownCatalog,
    dropdownTargetRepository,
    hubspotPropertyGateway,
    hubspotCredentialRepository: {
      findByClientConfig: jest.fn(async () => ({ accessToken: 'token-123' })),
    },
    clientConfigRepository: {
      findById: jest.fn(async () => null),
      markSyncSucceeded: jest.fn(async () => ({})),
      markSyncFailed: jest.fn(async () => ({})),
    },
    syncLogRepository: {
      start: jest.fn(async () => ({ id: 'log-1', _id: 'log-1' })),
      finish: jest.fn(async (_log, payload) => {
        finishedLogs.push(payload);
        return payload;
      }),
    },
    syncWarningRepository: {
      record: jest.fn(async (warning) => {
        warnings.push(warning);
        return warning;
      }),
    },
    sapFlavorRepository: { resolveSapFlavor: jest.fn(async () => sapFlavor) },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    dateProvider: () => new Date('2026-08-04T03:00:00.000Z'),
  });

  const config = {
    _id: CONFIG_ID,
    id: CONFIG_ID,
    taskType: 'DROPDOWN_OPTIONS',
    hubspotCredentialId: CREDENTIAL_ID,
    active: true,
  };
  const tenantContext = { tenantKey: 'tenant-1', tenantModels: {} };

  return {
    useCase,
    config,
    tenantContext,
    warnings,
    finishedLogs,
    updates,
    dropdownCatalog,
    dropdownTargetRepository,
    hubspotPropertyGateway,
    run: () => useCase.execute({ config, tenantContext }),
  };
}

function warningCodes(warnings) {
  return warnings.map((warning) => warning.code);
}

describe('SyncDropdownOptionsToHubspot', () => {
  it('does nothing when the tenant has not enabled the feature', async () => {
    const harness = buildHarness({ dropdownConfigValue: null });
    const result = await harness.run();

    expect(result).toMatchObject({ ok: true, status: 'completed' });
    expect(result.metrics.recordsProcessed).toBe(0);
    expect(harness.dropdownCatalog.fetchRows).not.toHaveBeenCalled();
    expect(harness.updates).toEqual([]);
  });

  it('refuses to run on a non-B1 tenant and says so in lastError', async () => {
    const harness = buildHarness({
      sapFlavor: 'S4',
      dropdownConfigValue: {
        sources: [{ serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] }],
      },
    });
    const result = await harness.run();

    expect(result).toMatchObject({ ok: false, status: 'errored' });
    expect(result.error).toContain('only supported on SAP B1');
    expect(warningCodes(harness.warnings)).toContain(
      DROPDOWN_WARNING_CODES.UNSUPPORTED_SAP_FLAVOR
    );
    expect(harness.dropdownCatalog.fetchRows).not.toHaveBeenCalled();
  });

  it('writes the same option list to every object that maps the field', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{
          serviceLayerPath: '/BusinessPartnerGroups',
          valueField: 'Code',
          labelField: 'Name',
          fields: ['PayTermsGrpCode'],
        }],
      },
      rows: {
        '/BusinessPartnerGroups': [
          { Code: 100, Name: 'Nacional' },
          { Code: 101, Name: 'Extranjero' },
        ],
      },
      targets: [
        { sourceField: 'PayTermsGrpCode', objectType: 'company', targetField: 'PayTermsGrpCode' },
        { sourceField: 'PayTermsGrpCode', objectType: 'contact', targetField: 'pay_terms' },
      ],
      properties: {
        'company.PayTermsGrpCode': { name: 'PayTermsGrpCode', type: 'enumeration', options: [] },
        'contact.pay_terms': { name: 'pay_terms', type: 'enumeration', options: [] },
      },
    });
    const result = await harness.run();

    expect(result.status).toBe('completed');
    expect(harness.updates).toHaveLength(2);
    expect(harness.updates[0]).toMatchObject({
      objectType: 'company',
      propertyName: 'PayTermsGrpCode',
    });
    expect(harness.updates[1]).toMatchObject({
      objectType: 'contact',
      propertyName: 'pay_terms',
    });
    expect(harness.updates[0].options).toEqual([
      { label: 'Nacional', value: '100', displayOrder: 0, hidden: false },
      { label: 'Extranjero', value: '101', displayOrder: 1, hidden: false },
    ]);
    expect(result.metrics).toMatchObject({
      recordsProcessed: 2,
      hubspotSent: 2,
      hubspotFailed: 0,
      hubspotCreated: 0,
      hubspotUpdated: 2,
    });
    expect(result.metrics.dropdown).toMatchObject({
      sourcesProcessed: 1,
      propertiesUpdated: 2,
      propertiesSkipped: 0,
    });
  });

  it('routes each object type through the property API name it needs', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{ serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] }],
      },
      rows: { '/Currencies': [{ Code: 'CRC' }] },
      targets: [
        { sourceField: 'Currency', objectType: '2-9876543', targetField: 'moneda' },
      ],
      properties: {
        '2-9876543.moneda': { type: 'enumeration', options: [] },
      },
    });
    const result = await harness.run();

    expect(harness.updates[0]).toMatchObject({ objectType: '2-9876543', propertyName: 'moneda' });
    expect(result.metrics.dropdown.propertiesUpdated).toBe(1);
  });

  it('hides options SAP stopped returning', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{
          serviceLayerPath: '/BusinessPartnerGroups',
          valueField: 'Code',
          labelField: 'Name',
          fields: ['GroupCode'],
        }],
      },
      rows: { '/BusinessPartnerGroups': [{ Code: 100, Name: 'Nacional' }] },
      targets: [{ sourceField: 'GroupCode', objectType: 'company', targetField: 'GroupCode' }],
      properties: {
        'company.GroupCode': {
          type: 'enumeration',
          options: [
            { value: '100', label: 'Nacional' },
            { value: '102', label: 'Descontinuado' },
          ],
        },
      },
    });
    await harness.run();

    expect(harness.updates[0].options).toEqual([
      { label: 'Nacional', value: '100', displayOrder: 0, hidden: false },
      { label: 'Descontinuado', value: '102', displayOrder: 1, hidden: true },
    ]);
  });

  it('does not call HubSpot when the option list is already correct', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{
          serviceLayerPath: '/Currencies',
          valueField: 'Code',
          labelField: 'Name',
          fields: ['Currency'],
        }],
      },
      rows: { '/Currencies': [{ Code: 'CRC', Name: 'Colones' }] },
      targets: [{ sourceField: 'Currency', objectType: 'company', targetField: 'currency' }],
      properties: {
        'company.currency': {
          type: 'enumeration',
          options: [{ value: 'CRC', label: 'Colones', displayOrder: 0, hidden: false }],
        },
      },
    });
    const result = await harness.run();

    expect(harness.updates).toEqual([]);
    expect(result.metrics.dropdown).toMatchObject({
      propertiesUnchanged: 1,
      propertiesUpdated: 0,
    });
    expect(result.metrics.hubspotSent).toBe(0);
  });

  it('skips and reports a property that does not exist', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{ serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] }],
      },
      rows: { '/Currencies': [{ Code: 'CRC' }] },
      targets: [{ sourceField: 'Currency', objectType: 'company', targetField: 'currency' }],
      properties: {},
    });
    const result = await harness.run();

    expect(harness.updates).toEqual([]);
    expect(warningCodes(harness.warnings)).toContain(DROPDOWN_WARNING_CODES.PROPERTY_NOT_FOUND);
    expect(result.metrics.dropdown.propertiesSkipped).toBe(1);
    expect(result.status).toBe('completed');
  });

  it('skips and reports a property that is not a dropdown', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{ serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] }],
      },
      rows: { '/Currencies': [{ Code: 'CRC' }] },
      targets: [{ sourceField: 'Currency', objectType: 'company', targetField: 'currency' }],
      properties: { 'company.currency': { type: 'string' } },
    });
    await harness.run();

    expect(harness.updates).toEqual([]);
    expect(warningCodes(harness.warnings)).toContain(
      DROPDOWN_WARNING_CODES.PROPERTY_NOT_ENUMERATION
    );
  });

  it('reports a field that has no fieldMapping', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{ serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] }],
      },
      rows: { '/Currencies': [{ Code: 'CRC' }] },
      targets: [],
    });
    const result = await harness.run();

    expect(warningCodes(harness.warnings)).toContain(
      DROPDOWN_WARNING_CODES.FIELD_WITHOUT_MAPPING
    );
    expect(result.metrics.recordsProcessed).toBe(0);
  });

  it('keeps going when one source fails to read from SAP', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [
          { serviceLayerPath: '/Broken', valueField: 'Code', fields: ['GroupCode'] },
          { serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] },
        ],
      },
      fetchRows: jest.fn(async ({ serviceLayerPath }) => {
        if (serviceLayerPath === '/Broken') {
          throw new Error('connect ETIMEDOUT 172.203.124.38:50000');
        }

        return [{ Code: 'CRC' }];
      }),
      targets: [{ sourceField: 'Currency', objectType: 'company', targetField: 'currency' }],
      properties: { 'company.currency': { type: 'enumeration', options: [] } },
    });
    const result = await harness.run();

    expect(warningCodes(harness.warnings)).toContain(
      DROPDOWN_WARNING_CODES.SOURCE_FETCH_FAILED
    );
    expect(harness.updates).toHaveLength(1);
    expect(result.status).toBe('completed');
    expect(result.metrics.dropdown).toMatchObject({ sourcesProcessed: 1, sourcesFailed: 1 });
  });

  it('counts a failed PATCH without aborting the run', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{ serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] }],
      },
      rows: { '/Currencies': [{ Code: 'CRC' }] },
      targets: [
        { sourceField: 'Currency', objectType: 'company', targetField: 'currency' },
        { sourceField: 'Currency', objectType: 'contact', targetField: 'currency' },
      ],
      properties: {
        'company.currency': { type: 'enumeration', options: [] },
        'contact.currency': { type: 'enumeration', options: [] },
      },
      updatePropertyOptions: jest.fn(async ({ objectType }) => {
        if (objectType === 'company') {
          throw new Error('HubSpot API request failed: 403 Forbidden');
        }

        return {};
      }),
    });
    const result = await harness.run();

    expect(warningCodes(harness.warnings)).toContain(
      DROPDOWN_WARNING_CODES.PROPERTY_UPDATE_FAILED
    );
    expect(result.metrics).toMatchObject({ hubspotFailed: 1, hubspotSent: 1 });
    expect(result.status).toBe('completed');
  });

  it('reports invalid source entries instead of ignoring them', async () => {
    const harness = buildHarness({
      dropdownConfigValue: { sources: [{ serviceLayerPath: '/Currencies' }] },
    });
    await harness.run();

    expect(warningCodes(harness.warnings)).toContain(DROPDOWN_WARNING_CODES.INVALID_SOURCE);
  });

  it('keeps the first source when two feed the same field', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [
          { serviceLayerPath: '/Primero', valueField: 'Code', fields: ['U_FormCob'] },
          { serviceLayerPath: '/Segundo', valueField: 'Code', fields: ['U_FormCob'] },
        ],
      },
      rows: {
        '/Primero': [{ Code: 'A' }],
        '/Segundo': [{ Code: 'B' }],
      },
      targets: [{ sourceField: 'U_FormCob', objectType: 'company', targetField: 'u_formcob' }],
      properties: { 'company.u_formcob': { type: 'enumeration', options: [] } },
    });
    await harness.run();

    expect(harness.updates[0].options).toEqual([
      { label: 'A', value: 'A', displayOrder: 0, hidden: false },
    ]);
    expect(warningCodes(harness.warnings)).toContain(DROPDOWN_WARNING_CODES.TARGET_CONFLICT);
  });

  it('fails cleanly when the clientConfig has no HubSpot credential', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{ serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] }],
      },
    });
    harness.useCase.hubspotCredentialRepository.findByClientConfig = jest.fn(async () => null);

    const result = await harness.run();

    expect(result).toMatchObject({ ok: false, status: 'errored' });
    expect(result.error).toContain('No HubSpot credentials');
  });

  it('records the run in the sync log with dropdown metrics', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{ serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] }],
      },
      rows: { '/Currencies': [{ Code: 'CRC' }] },
      targets: [{ sourceField: 'Currency', objectType: 'company', targetField: 'currency' }],
      properties: { 'company.currency': { type: 'enumeration', options: [] } },
    });
    await harness.run();

    expect(harness.finishedLogs[0]).toMatchObject({
      status: 'completed',
      recordsProcessed: 1,
      sent: 1,
      failed: 0,
    });
  });

  it('resolves a udf source end to end', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{ sourceType: 'udf', tableName: 'OCRD', fields: ['U_SA'] }],
      },
      rows: {
        '/UserFieldsMD': [
          {
            Name: 'SA',
            TableName: 'OCRD',
            ValidValuesMD: [
              { Value: 'S', Description: 'Si' },
              { Value: 'N', Description: 'No' },
            ],
          },
        ],
      },
      targets: [{ sourceField: 'U_SA', objectType: 'company', targetField: 'u_sa' }],
      properties: { 'company.u_sa': { type: 'enumeration', options: [] } },
    });
    await harness.run();

    expect(harness.dropdownCatalog.fetchRows).toHaveBeenCalledWith({
      tenantContext: harness.tenantContext,
      serviceLayerPath: '/UserFieldsMD',
      query: { $filter: "TableName eq 'OCRD'" },
    });
    expect(harness.updates[0].options).toEqual([
      { label: 'Si', value: 'S', displayOrder: 0, hidden: false },
      { label: 'No', value: 'N', displayOrder: 1, hidden: false },
    ]);
  });
});
