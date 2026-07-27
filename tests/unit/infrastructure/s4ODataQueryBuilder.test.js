import {
  buildS4ODataQuery,
  splitSelectAndExpand,
  toODataV2DateTime,
} from '../../../src/infrastructure/sap/s4ODataQueryBuilder.js';

const baseConfig = {
  serviceLayerPath: '/API_BUSINESS_PARTNER/A_BusinessPartner',
  intervalMinutes: 60,
};

const flatMappings = [
  { sourceField: 'BusinessPartner', targetField: 'idsap' },
  { sourceField: 'BusinessPartnerFullName', targetField: 'name' },
];

describe('splitSelectAndExpand', () => {
  it('keeps flat fields in $select', () => {
    expect(splitSelectAndExpand(flatMappings)).toEqual({
      select: ['BusinessPartner', 'BusinessPartnerFullName'],
      expand: [],
    });
  });

  it('turns dotted paths into $expand plus the navigation root in $select', () => {
    const result = splitSelectAndExpand([
      { sourceField: 'BusinessPartner' },
      { sourceField: 'to_BusinessPartnerAddress.to_EmailAddress.EmailAddress' },
      { sourceField: 'to_BusinessPartnerAddress.to_PhoneNumber.PhoneNumber' },
      { sourceField: 'to_Customer.TaxNumber1' },
    ]);

    expect(result.select).toEqual([
      'BusinessPartner',
      'to_BusinessPartnerAddress',
      'to_Customer',
    ]);
    expect(result.expand).toEqual([
      'to_BusinessPartnerAddress/to_EmailAddress',
      'to_BusinessPartnerAddress/to_PhoneNumber',
      'to_Customer',
    ]);
  });

  it('skips mappings excluded from the select and invalid identifiers', () => {
    const result = splitSelectAndExpand([
      { sourceField: 'BusinessPartner' },
      { sourceField: 'Stock', includeInServiceLayerSelect: false },
      { sourceField: '' },
      { sourceField: 'bad-field!' },
      { sourceField: 'to_X.bad field' },
    ]);

    expect(result).toEqual({ select: ['BusinessPartner'], expand: [] });
  });

  it('drops expand paths already implied by a deeper one', () => {
    const result = splitSelectAndExpand([
      { sourceField: 'to_BusinessPartnerAddress.CityName' },
      { sourceField: 'to_BusinessPartnerAddress.to_EmailAddress.EmailAddress' },
      { sourceField: 'to_Customer.TaxNumber1' },
    ]);

    expect(result.expand).toEqual([
      'to_BusinessPartnerAddress/to_EmailAddress',
      'to_Customer',
    ]);
    expect(result.select).toEqual(['to_BusinessPartnerAddress', 'to_Customer']);
  });

  it('deduplicates repeated roots and paths', () => {
    const result = splitSelectAndExpand([
      { sourceField: 'to_BusinessPartnerAddress.to_EmailAddress.EmailAddress' },
      { sourceField: 'to_BusinessPartnerAddress.to_EmailAddress.IsDefaultEmailAddress' },
    ]);

    expect(result.select).toEqual(['to_BusinessPartnerAddress']);
    expect(result.expand).toEqual(['to_BusinessPartnerAddress/to_EmailAddress']);
  });
});

describe('toODataV2DateTime', () => {
  it('emits a v2 datetime literal without timezone suffix', () => {
    expect(toODataV2DateTime(new Date('2026-07-21T15:04:05.000Z')))
      .toBe("datetime'2026-07-21T15:04:05'");
  });
});

describe('buildS4ODataQuery', () => {
  it('builds path and query from config plus mappings', () => {
    const { path, query } = buildS4ODataQuery(baseConfig, flatMappings, {});

    expect(path).toBe('/API_BUSINESS_PARTNER/A_BusinessPartner');
    expect(query.$select).toBe('BusinessPartner,BusinessPartnerFullName');
    expect(query.$expand).toBeUndefined();
    expect(query.$filter).toBeUndefined();
  });

  it('requires a serviceLayerPath', () => {
    expect(() => buildS4ODataQuery({}, flatMappings, {}))
      .toThrow('serviceLayerPath is required');
  });

  it('requires at least one usable mapping', () => {
    expect(() => buildS4ODataQuery(baseConfig, [], {}))
      .toThrow('At least one active mapping');
  });

  it('renders the customer + grouping filters agreed with the client', () => {
    const config = {
      ...baseConfig,
      filters: [
        { property: 'Customer', operator: 'ne', value: '' },
        { property: 'BusinessPartnerGrouping', operator: 'eq', value: 'ZC01' },
      ],
    };

    const { query } = buildS4ODataQuery(config, flatMappings, {});

    expect(decodeURIComponent(query.$filter))
      .toBe("Customer ne '' and BusinessPartnerGrouping eq 'ZC01'");
  });

  it('renders dynamic filters as Edm.DateTime literals', () => {
    const config = {
      ...baseConfig,
      filters: [
        { property: 'LastChangeDate', operator: 'ge', isDynamic: true, dynamicType: 'datetime' },
      ],
    };

    const { query } = buildS4ODataQuery(config, flatMappings, {
      now: new Date('2026-07-21T12:00:00.000Z'),
      dynamicIntervalMinutes: 60,
    });

    expect(decodeURIComponent(query.$filter))
      .toBe("LastChangeDate ge datetime'2026-07-21T11:00:00'");
  });

  it('anchors dynamicType=date to the start of the UTC day', () => {
    const config = {
      ...baseConfig,
      filters: [
        { property: 'LastChangeDate', operator: 'ge', isDynamic: true, dynamicType: 'date' },
      ],
    };

    const { query } = buildS4ODataQuery(config, flatMappings, {
      now: new Date('2026-07-21T18:30:00.000Z'),
    });

    expect(decodeURIComponent(query.$filter))
      .toBe("LastChangeDate ge datetime'2026-07-21T00:00:00'");
  });

  it('omits dynamic filters on FULL runs', () => {
    const config = {
      ...baseConfig,
      filters: [
        { property: 'Customer', operator: 'ne', value: '' },
        { property: 'LastChangeDate', operator: 'ge', isDynamic: true },
      ],
    };

    const { query } = buildS4ODataQuery(config, flatMappings, { skipDynamicFilters: true });

    expect(decodeURIComponent(query.$filter)).toBe("Customer ne ''");
  });

  it('escapes single quotes in filter values', () => {
    const config = {
      ...baseConfig,
      filters: [{ property: 'BusinessPartnerFullName', operator: 'eq', value: "O'Brien" }],
    };

    expect(decodeURIComponent(buildS4ODataQuery(config, flatMappings, {}).query.$filter))
      .toBe("BusinessPartnerFullName eq 'O''Brien'");
  });

  it("renders 'in' as an OR group (ZC01 / ZC02)", () => {
    const config = {
      ...baseConfig,
      filters: [
        { property: 'Customer', operator: 'ne', value: '' },
        { property: 'BusinessPartnerGrouping', operator: 'in', value: ['ZC01', 'ZC02'] },
      ],
    };

    expect(decodeURIComponent(buildS4ODataQuery(config, flatMappings, {}).query.$filter))
      .toBe("Customer ne '' and (BusinessPartnerGrouping eq 'ZC01' or BusinessPartnerGrouping eq 'ZC02')");
  });

  it("collapses a single-value 'in' and rejects an empty one", () => {
    const single = {
      ...baseConfig,
      filters: [{ property: 'BusinessPartnerGrouping', operator: 'in', value: ['ZC01'] }],
    };
    expect(decodeURIComponent(buildS4ODataQuery(single, flatMappings, {}).query.$filter))
      .toBe("BusinessPartnerGrouping eq 'ZC01'");

    const empty = {
      ...baseConfig,
      filters: [{ property: 'BusinessPartnerGrouping', operator: 'in', value: [] }],
    };
    expect(() => buildS4ODataQuery(empty, flatMappings, {}))
      .toThrow("requires at least one value for 'in'");
  });

  it('supports startswith and its negation', () => {
    const config = {
      ...baseConfig,
      filters: [
        { property: 'BusinessPartnerGrouping', operator: 'startswith', value: 'ZC' },
        { property: 'BusinessPartnerGrouping', operator: 'not_startswith', value: 'ZK' },
      ],
    };

    expect(decodeURIComponent(buildS4ODataQuery(config, flatMappings, {}).query.$filter))
      .toBe("startswith(BusinessPartnerGrouping,'ZC') and not startswith(BusinessPartnerGrouping,'ZK')");
  });

  it('rejects unknown operators and invalid properties', () => {
    expect(() => buildS4ODataQuery(
      { ...baseConfig, filters: [{ property: 'X', operator: 'like', value: 'a' }] },
      flatMappings,
      {}
    )).toThrow('Unsupported SAP filter operator: like');

    expect(() => buildS4ODataQuery(
      { ...baseConfig, filters: [{ property: 'bad field', operator: 'eq', value: 'a' }] },
      flatMappings,
      {}
    )).toThrow('invalid property');
  });

  it('rejects a controlled filter that is not valid OData v2', () => {
    // Bare ISO is what the B1 path emits; Gateway rejects it.
    expect(() => buildS4ODataQuery(baseConfig, flatMappings, {
      controlledFilter: 'UpdateDate ge 2026-07-21T11:00:00',
    })).toThrow('invalid format for OData v2');
  });

  it('accepts a controlled filter already written as a v2 literal', () => {
    const { query } = buildS4ODataQuery(baseConfig, flatMappings, {
      controlledFilter: "LastChangeDate ge datetime'2026-07-21T11:00:00'",
    });

    expect(decodeURIComponent(query.$filter))
      .toBe("LastChangeDate ge datetime'2026-07-21T11:00:00'");
  });

  it('builds $orderby from the config', () => {
    const config = {
      ...baseConfig,
      orderBy: [
        { property: 'LastChangeDate', direction: 'asc' },
        { property: 'bad field', direction: 'desc' },
      ],
    };

    expect(decodeURIComponent(buildS4ODataQuery(config, flatMappings, {}).query.$orderby))
      .toBe('LastChangeDate asc');
  });
});
