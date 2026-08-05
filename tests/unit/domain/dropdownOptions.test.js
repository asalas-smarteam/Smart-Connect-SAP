import {
  classifyTargetProperty,
  extractOptionSets,
  mergePropertyOptions,
  normalizeDropdownOptionsConfig,
  normalizeDropdownSource,
  propertyOptionsAreEqual,
} from '../../../src/domain/sync/dropdown-options.service.js';
import {
  DROPDOWN_WARNING_CODES,
  HUBSPOT_MAX_PROPERTY_OPTIONS,
  resolveClientConfigTaskType,
} from '../../../src/domain/sync/dropdown-options.constants.js';

describe('resolveClientConfigTaskType', () => {
  it('falls back to SAP_SYNC for absent or unknown values', () => {
    expect(resolveClientConfigTaskType(undefined)).toBe('SAP_SYNC');
    expect(resolveClientConfigTaskType(null)).toBe('SAP_SYNC');
    expect(resolveClientConfigTaskType('')).toBe('SAP_SYNC');
    expect(resolveClientConfigTaskType('SOMETHING_ELSE')).toBe('SAP_SYNC');
  });

  it('accepts the dropdown task type case-insensitively', () => {
    expect(resolveClientConfigTaskType('DROPDOWN_OPTIONS')).toBe('DROPDOWN_OPTIONS');
    expect(resolveClientConfigTaskType(' dropdown_options ')).toBe('DROPDOWN_OPTIONS');
  });
});

describe('normalizeDropdownOptionsConfig', () => {
  it('treats a missing document as disabled', () => {
    expect(normalizeDropdownOptionsConfig(null)).toEqual({
      enabled: false,
      sources: [],
      invalidSources: [],
    });
  });

  it('honours an explicit enabled:false even with sources present', () => {
    const config = normalizeDropdownOptionsConfig({
      enabled: false,
      sources: [{ serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] }],
    });

    expect(config.enabled).toBe(false);
    expect(config.sources).toHaveLength(1);
  });

  it('accepts a bare array of sources', () => {
    const config = normalizeDropdownOptionsConfig([
      { serviceLayerPath: '/Currencies', valueField: 'Code', labelField: 'Name', fields: ['Currency'] },
    ]);

    expect(config.enabled).toBe(true);
    expect(config.sources[0].serviceLayerPath).toBe('/Currencies');
  });

  it('separates invalid sources instead of dropping them silently', () => {
    const config = normalizeDropdownOptionsConfig({
      sources: [
        { serviceLayerPath: '/Currencies', valueField: 'Code', fields: ['Currency'] },
        { serviceLayerPath: '/Countries', fields: ['Country'] },
        { sourceType: 'udf', fields: ['U_SA'] },
      ],
    });

    expect(config.sources).toHaveLength(1);
    expect(config.invalidSources).toEqual([
      { id: 'sources[1]', index: 1, error: 'valueField is required' },
      { id: 'sources[2]', index: 2, error: 'tableName is required for a udf source' },
    ]);
  });
});

describe('normalizeDropdownSource', () => {
  it('normalizes a collection source and prefixes the path with a slash', () => {
    const { source } = normalizeDropdownSource({
      serviceLayerPath: 'BusinessPartnerGroups',
      query: { $filter: "Type eq 'bbpgt_CustomerGroup'" },
      valueField: 'Code',
      labelField: 'Name',
      fields: ['GroupCode', 'GroupCode', ' '],
    });

    expect(source).toMatchObject({
      sourceType: 'collection',
      serviceLayerPath: '/BusinessPartnerGroups',
      query: { $filter: "Type eq 'bbpgt_CustomerGroup'" },
      valueField: 'Code',
      labelField: 'Name',
      optionsPath: null,
      fieldNameField: null,
      fields: ['GroupCode'],
    });
  });

  it('expands a udf shorthand into the generic per-row shape', () => {
    const { source } = normalizeDropdownSource({
      sourceType: 'udf',
      tableName: 'OCRD',
      fields: ['U_SA', 'U_FormCob'],
    }, 3);

    expect(source).toMatchObject({
      id: 'sources[3]',
      sourceType: 'udf',
      serviceLayerPath: '/UserFieldsMD',
      query: { $filter: "TableName eq 'OCRD'" },
      optionsPath: 'ValidValuesMD',
      valueField: 'Value',
      labelField: 'Description',
      fieldNameField: 'Name',
      fieldNamePrefix: 'U_',
      tableName: 'OCRD',
      fields: ['U_SA', 'U_FormCob'],
    });
  });

  it('lets a udf source override the generated filter', () => {
    const { source } = normalizeDropdownSource({
      sourceType: 'udf',
      tableName: 'OCRD',
      query: { $filter: "TableName eq 'OCRD' and Name eq 'SA'" },
      fields: ['U_SA'],
    });

    expect(source.query).toEqual({ $filter: "TableName eq 'OCRD' and Name eq 'SA'" });
  });

  it('rejects sources missing required parts', () => {
    expect(normalizeDropdownSource({ valueField: 'Code', fields: ['x'] }).error)
      .toBe('serviceLayerPath is required');
    expect(normalizeDropdownSource({ serviceLayerPath: '/x', valueField: 'Code' }).error)
      .toBe('fields must contain at least one SAP field name');
    expect(normalizeDropdownSource('nope').error).toBe('source must be an object');
  });
});

describe('extractOptionSets - shared mode', () => {
  const { source } = normalizeDropdownSource({
    serviceLayerPath: '/BusinessPartnerGroups',
    valueField: 'Code',
    labelField: 'Name',
    fields: ['GroupCode', 'U_TipoCL'],
  });

  it('applies one option list to every field of the source', () => {
    const { optionSets, issues } = extractOptionSets({
      source,
      rows: [
        { Code: 100, Name: 'Nacional' },
        { Code: 101, Name: 'Extranjero' },
      ],
    });

    expect(issues).toEqual([]);
    expect(optionSets).toEqual([
      {
        field: 'GroupCode',
        options: [
          { value: '100', label: 'Nacional' },
          { value: '101', label: 'Extranjero' },
        ],
      },
      {
        field: 'U_TipoCL',
        options: [
          { value: '100', label: 'Nacional' },
          { value: '101', label: 'Extranjero' },
        ],
      },
    ]);
  });

  it('deduplicates values, skips blanks and falls back to the value as label', () => {
    const { optionSets } = extractOptionSets({
      source,
      rows: [
        { Code: 100, Name: 'Nacional' },
        { Code: 100, Name: 'Duplicado' },
        { Code: '', Name: 'Sin codigo' },
        { Code: 102, Name: '   ' },
      ],
    });

    expect(optionSets[0].options).toEqual([
      { value: '100', label: 'Nacional' },
      { value: '102', label: '102' },
    ]);
  });

  it('refuses values containing the HubSpot separator and reports them', () => {
    const { optionSets, issues } = extractOptionSets({
      source,
      rows: [
        { Code: 'A;B', Name: 'Invalido' },
        { Code: 'OK', Name: 'Valido' },
      ],
    });

    expect(optionSets[0].options).toEqual([{ value: 'OK', label: 'Valido' }]);
    expect(issues[0]).toMatchObject({
      code: DROPDOWN_WARNING_CODES.INVALID_OPTION_VALUE,
      details: { samples: ['A;B'] },
    });
  });

  it('reports a source that returned nothing usable', () => {
    const { optionSets, issues } = extractOptionSets({ source, rows: [] });

    expect(optionSets).toEqual([]);
    expect(issues[0].code).toBe(DROPDOWN_WARNING_CODES.NO_OPTIONS);
  });

  it('caps the list at the HubSpot limit and reports the truncation', () => {
    const rows = Array.from({ length: HUBSPOT_MAX_PROPERTY_OPTIONS + 5 }, (_, index) => ({
      Code: index + 1,
      Name: `Item ${index + 1}`,
    }));
    const { optionSets, issues } = extractOptionSets({ source, rows });

    expect(optionSets[0].options).toHaveLength(HUBSPOT_MAX_PROPERTY_OPTIONS);
    expect(issues[0]).toMatchObject({
      code: DROPDOWN_WARNING_CODES.OPTIONS_TRUNCATED,
      details: { truncated: 5 },
    });
  });

  it('flattens a nested optionsPath across rows', () => {
    const { source: nested } = normalizeDropdownSource({
      serviceLayerPath: '/UserTables',
      optionsPath: 'Rows',
      valueField: 'Code',
      labelField: 'Name',
      fields: ['U_FormCob'],
    });
    const { optionSets } = extractOptionSets({
      source: nested,
      rows: [
        { Rows: [{ Code: '01', Name: 'Contado' }] },
        { Rows: [{ Code: '02', Name: 'Credito' }] },
      ],
    });

    expect(optionSets[0].options).toEqual([
      { value: '01', label: 'Contado' },
      { value: '02', label: 'Credito' },
    ]);
  });
});

describe('extractOptionSets - per-row mode (udf)', () => {
  const { source } = normalizeDropdownSource({
    sourceType: 'udf',
    tableName: 'OCRD',
    fields: ['U_SA', 'U_FormCob', 'U_AgReten'],
  });

  it('gives each UDF its own option list and prefixes the field name', () => {
    const { optionSets } = extractOptionSets({
      source,
      rows: [
        {
          Name: 'SA',
          TableName: 'OCRD',
          ValidValuesMD: [
            { Value: 'S', Description: 'Si' },
            { Value: 'N', Description: 'No' },
          ],
        },
        {
          Name: 'FormCob',
          TableName: 'OCRD',
          ValidValuesMD: [{ Value: '01', Description: 'Contado' }],
        },
      ],
    });

    expect(optionSets).toEqual([
      {
        field: 'U_SA',
        options: [
          { value: 'S', label: 'Si' },
          { value: 'N', label: 'No' },
        ],
      },
      {
        field: 'U_FormCob',
        options: [{ value: '01', label: 'Contado' }],
      },
    ]);
  });

  it('ignores UDFs that were not requested', () => {
    const { optionSets } = extractOptionSets({
      source,
      rows: [
        { Name: 'OtroCampo', ValidValuesMD: [{ Value: 'X', Description: 'X' }] },
        { Name: 'SA', ValidValuesMD: [{ Value: 'S', Description: 'Si' }] },
      ],
    });

    expect(optionSets.map((set) => set.field)).toEqual(['U_SA']);
  });

  it('reports requested UDFs that SAP never returned', () => {
    const { issues } = extractOptionSets({
      source,
      rows: [{ Name: 'SA', ValidValuesMD: [{ Value: 'S', Description: 'Si' }] }],
    });

    expect(issues).toEqual([
      {
        code: DROPDOWN_WARNING_CODES.NO_OPTIONS,
        field: 'U_FormCob',
        message: 'SAP did not return a definition for U_FormCob',
        details: { source: 'sources[0]', serviceLayerPath: '/UserFieldsMD', tableName: 'OCRD' },
      },
      {
        code: DROPDOWN_WARNING_CODES.NO_OPTIONS,
        field: 'U_AgReten',
        message: 'SAP did not return a definition for U_AgReten',
        details: { source: 'sources[0]', serviceLayerPath: '/UserFieldsMD', tableName: 'OCRD' },
      },
    ]);
  });

  it('reports a UDF that exists but has an empty valid-value list', () => {
    const { optionSets, issues } = extractOptionSets({
      source,
      rows: [{ Name: 'SA', ValidValuesMD: [] }],
    });

    expect(optionSets).toEqual([]);
    expect(issues[0]).toMatchObject({
      code: DROPDOWN_WARNING_CODES.NO_OPTIONS,
      field: 'U_SA',
    });
  });
});

describe('mergePropertyOptions', () => {
  it('hides options SAP no longer returns instead of deleting them', () => {
    const { options, summary } = mergePropertyOptions({
      existingOptions: [
        { value: '100', label: 'Nacional' },
        { value: '101', label: 'Extranjero' },
        { value: '102', label: 'Descontinuado' },
      ],
      sapOptions: [
        { value: '100', label: 'Nacional' },
        { value: '101', label: 'Extranjero' },
      ],
    });

    expect(options).toEqual([
      { label: 'Nacional', value: '100', displayOrder: 0, hidden: false },
      { label: 'Extranjero', value: '101', displayOrder: 1, hidden: false },
      { label: 'Descontinuado', value: '102', displayOrder: 2, hidden: true },
    ]);
    expect(summary).toEqual({ added: 0, relabeled: 0, unhidden: 0, hidden: 1, kept: 2 });
  });

  it('adds new options and takes the SAP label for existing ones', () => {
    const { options, summary } = mergePropertyOptions({
      existingOptions: [{ value: '100', label: 'Viejo nombre' }],
      sapOptions: [
        { value: '100', label: 'Nombre nuevo' },
        { value: '200', label: 'Recien creado' },
      ],
    });

    expect(options).toEqual([
      { label: 'Nombre nuevo', value: '100', displayOrder: 0, hidden: false },
      { label: 'Recien creado', value: '200', displayOrder: 1, hidden: false },
    ]);
    expect(summary).toMatchObject({ added: 1, relabeled: 1, hidden: 0 });
  });

  it('un-hides an option SAP brings back', () => {
    const { options, summary } = mergePropertyOptions({
      existingOptions: [{ value: '102', label: 'Descontinuado', hidden: true }],
      sapOptions: [{ value: '102', label: 'Descontinuado' }],
    });

    expect(options[0].hidden) .toBe(false);
    expect(summary.unhidden).toBe(1);
  });

  it('preserves a human-written description', () => {
    const { options } = mergePropertyOptions({
      existingOptions: [{ value: '100', label: 'Nacional', description: 'Escrito a mano' }],
      sapOptions: [{ value: '100', label: 'Nacional' }],
    });

    expect(options[0].description).toBe('Escrito a mano');
  });

  it('creates the whole list when the property had no options', () => {
    const { options, summary } = mergePropertyOptions({
      sapOptions: [{ value: 'S', label: 'Si' }],
    });

    expect(options).toEqual([{ label: 'Si', value: 'S', displayOrder: 0, hidden: false }]);
    expect(summary.added).toBe(1);
  });
});

describe('propertyOptionsAreEqual', () => {
  it('is true for the same values, labels, hidden flags and order', () => {
    expect(propertyOptionsAreEqual(
      [{ value: '1', label: 'Uno', hidden: false }],
      [{ value: '1', label: 'Uno', displayOrder: 0 }]
    )).toBe(true);
  });

  it('detects label, hidden and order changes', () => {
    expect(propertyOptionsAreEqual(
      [{ value: '1', label: 'Uno' }],
      [{ value: '1', label: 'One' }]
    )).toBe(false);
    expect(propertyOptionsAreEqual(
      [{ value: '1', label: 'Uno' }],
      [{ value: '1', label: 'Uno', hidden: true }]
    )).toBe(false);
    expect(propertyOptionsAreEqual(
      [{ value: '1', label: 'Uno' }, { value: '2', label: 'Dos' }],
      [{ value: '2', label: 'Dos' }, { value: '1', label: 'Uno' }]
    )).toBe(false);
  });
});

describe('classifyTargetProperty', () => {
  it('accepts a writable enumeration', () => {
    expect(classifyTargetProperty({ type: 'enumeration' })).toEqual({
      writable: true,
      code: null,
      message: null,
    });
  });

  it('rejects a missing property', () => {
    expect(classifyTargetProperty(null).code).toBe(DROPDOWN_WARNING_CODES.PROPERTY_NOT_FOUND);
  });

  it('rejects a non-enumeration property and says why', () => {
    const result = classifyTargetProperty({ type: 'string' });

    expect(result.code).toBe(DROPDOWN_WARNING_CODES.PROPERTY_NOT_ENUMERATION);
    expect(result.message).toContain("exists as 'string'");
  });

  it('rejects a read-only definition', () => {
    expect(classifyTargetProperty({
      type: 'enumeration',
      modificationMetadata: { readOnlyDefinition: true },
    }).code).toBe(DROPDOWN_WARNING_CODES.PROPERTY_READ_ONLY);
  });
});
