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
  credentials = { _id: CREDENTIAL_ID, accessToken: 'stale-token', expiresAt: new Date('2026-08-03T22:15:54.103Z') },
  getAccessToken,
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

  const hubspotTokenProvider = {
    getAccessToken: getAccessToken ?? jest.fn(async () => 'token-123'),
  };

  const useCase = new SyncDropdownOptionsToHubspot({
    dropdownConfigRepository,
    dropdownCatalog,
    dropdownTargetRepository,
    hubspotPropertyGateway,
    hubspotCredentialRepository: {
      findByClientConfig: jest.fn(async () => credentials),
    },
    hubspotTokenProvider,
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
    hubspotTokenProvider,
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
        { sourceField: 'PayTermsGrpCode', objectType: 'company', targetField: 'paytermsgrpcode' },
        { sourceField: 'PayTermsGrpCode', objectType: 'contact', targetField: 'pay_terms' },
      ],
      properties: {
        'company.paytermsgrpcode': { name: 'paytermsgrpcode', type: 'enumeration', options: [] },
        'contact.pay_terms': { name: 'pay_terms', type: 'enumeration', options: [] },
      },
    });
    const result = await harness.run();

    expect(result.status).toBe('completed');
    expect(harness.updates).toHaveLength(2);
    expect(harness.updates[0]).toMatchObject({
      objectType: 'company',
      propertyName: 'paytermsgrpcode',
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
      targets: [{ sourceField: 'GroupCode', objectType: 'company', targetField: 'groupcode' }],
      properties: {
        'company.groupcode': {
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

  // A stored accessToken is routinely expired (they last ~30 min), so the token
  // has to come from the provider that refreshes it, never from the document.
  it('asks the token provider for the token instead of using the stored one', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{ serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] }],
      },
      rows: { '/Currencies': [{ Code: 'CRC' }] },
      targets: [{ sourceField: 'Currency', objectType: 'company', targetField: 'moneda' }],
      properties: { 'company.moneda': { type: 'enumeration', options: [] } },
    });
    await harness.run();

    expect(harness.hubspotTokenProvider.getAccessToken).toHaveBeenCalledWith(
      CREDENTIAL_ID,
      expect.objectContaining({ accessToken: 'stale-token' }),
      harness.tenantContext.tenantModels
    );
    expect(harness.hubspotPropertyGateway.findProperty)
      .toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'token-123' }));
    expect(harness.updates[0].accessToken).toBe('token-123');
  });

  it('resolves the token only after reading SAP, so it is fresh for the writes', async () => {
    const calls = [];
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{ serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] }],
      },
      fetchRows: jest.fn(async () => {
        calls.push('sap');
        return [{ Code: 'CRC' }];
      }),
      getAccessToken: jest.fn(async () => {
        calls.push('token');
        return 'token-123';
      }),
      targets: [{ sourceField: 'Currency', objectType: 'company', targetField: 'moneda' }],
      properties: { 'company.moneda': { type: 'enumeration', options: [] } },
    });
    await harness.run();

    expect(calls).toEqual(['sap', 'token']);
  });

  it('errors clearly when the refresh token can no longer be exchanged', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{ serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] }],
      },
      rows: { '/Currencies': [{ Code: 'CRC' }] },
      getAccessToken: jest.fn(async () => {
        throw new Error('Refresh token not found for client configuration');
      }),
    });
    const result = await harness.run();

    expect(result).toMatchObject({ ok: false, status: 'errored' });
    expect(result.error).toContain('Could not obtain a valid HubSpot access token');
    expect(harness.updates).toEqual([]);
  });

  // HubSpot property names are lowercase, so a PascalCase targetField can never
  // match. Caught before the API call and reported with the fix.
  it('skips a targetField that has uppercase letters and suggests the fix', async () => {
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
      targets: [
        { sourceField: 'GroupCode', objectType: 'contact', targetField: 'GroupCode' },
        { sourceField: 'GroupCode', objectType: 'company', targetField: 'groupcode' },
      ],
      properties: { 'company.groupcode': { type: 'enumeration', options: [] } },
    });
    const result = await harness.run();

    const invalid = harness.warnings.find(
      (warning) => warning.code === DROPDOWN_WARNING_CODES.PROPERTY_NAME_INVALID
    );
    expect(invalid.message).toContain("cannot exist");
    expect(invalid.details).toMatchObject({
      targetField: 'GroupCode',
      suggestedTargetField: 'groupcode',
    });
    // The uppercase one never reaches HubSpot; the correct one still syncs.
    expect(harness.hubspotPropertyGateway.findProperty).toHaveBeenCalledTimes(1);
    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0].propertyName).toBe('groupcode');
    expect(result.metrics.dropdown.propertiesSkipped).toBe(1);
  });

  it('sends the mapping targetField as the property name, not the SAP field', async () => {
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
      targets: [{ sourceField: 'GroupCode', objectType: 'contact', targetField: 'groupcode' }],
      properties: { 'contact.groupcode': { type: 'enumeration', options: [] } },
    });
    await harness.run();

    expect(harness.hubspotPropertyGateway.findProperty).toHaveBeenCalledWith({
      accessToken: 'token-123',
      objectType: 'contact',
      propertyName: 'groupcode',
    });
  });

  // Pairs with the optionCount below: rowCount says what SAP handed over, so a
  // short dropdown can be blamed on the read or on the extraction, not both.
  it('logs how many rows each source returned from SAP', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{
          serviceLayerPath: '/SalesPersons',
          valueField: 'SalesEmployeeCode',
          labelField: 'SalesEmployeeName',
          fields: ['SalesPersonCode'],
        }],
      },
      rows: {
        '/SalesPersons': [
          { SalesEmployeeCode: 1, SalesEmployeeName: 'Ana' },
          { SalesEmployeeCode: 2, SalesEmployeeName: 'Luis' },
          { SalesEmployeeCode: 3, SalesEmployeeName: 'Sofia' },
        ],
      },
      targets: [{ sourceField: 'SalesPersonCode', objectType: 'contact', targetField: 'slpcodelist' }],
      properties: { 'contact.slpcodelist': { type: 'enumeration', options: [] } },
    });
    await harness.run();

    expect(harness.useCase.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'Dropdown source rows fetched',
      serviceLayerPath: '/SalesPersons',
      rowCount: 3,
    }));
  });

  // The diagnostic gap this closes: a field mapped on contact but not on company
  // used to leave no trace at all for the company side.
  it('logs which properties each SAP field resolved to', async () => {
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
      targets: [{ sourceField: 'GroupCode', objectType: 'contact', targetField: 'groupcode' }],
      properties: { 'contact.groupcode': { type: 'enumeration', options: [] } },
    });
    await harness.run();

    expect(harness.useCase.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'Dropdown field resolved to HubSpot properties',
      sapField: 'GroupCode',
      targets: ['contact.groupcode'],
      optionCount: 1,
    }));
  });

  it('logs an already-correct property instead of staying silent', async () => {
    const harness = buildHarness({
      dropdownConfigValue: {
        sources: [{
          serviceLayerPath: '/UserFieldsMD',
          valueField: 'Code',
          labelField: 'Name',
          fields: ['U_SA'],
        }],
      },
      rows: { '/UserFieldsMD': [{ Code: 'S', Name: 'Si' }] },
      targets: [{ sourceField: 'U_SA', objectType: 'contact', targetField: 'segmento_actividad' }],
      properties: {
        'contact.segmento_actividad': {
          type: 'enumeration',
          options: [{ value: 'S', label: 'Si', displayOrder: 0, hidden: false }],
        },
      },
    });
    await harness.run();

    expect(harness.updates).toEqual([]);
    expect(harness.useCase.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'Dropdown property options already up to date',
      objectType: 'contact',
      property: 'segmento_actividad',
      sapField: 'U_SA',
    }));
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
