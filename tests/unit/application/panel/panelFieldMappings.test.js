import { jest } from '@jest/globals';
import PanelFieldMappings from '../../../../src/application/use-cases/panel/PanelFieldMappings.js';
import { FakeTenantDirectory, TENANTS } from './panelFakes.js';
import { FakeFieldMappingReader, MAPPING_IDS as M, sampleFieldMappings } from './operationFakes.js';

const ACME = 'sap_integration_acme';
const INITECH = 'sap_integration_initech';
const client = { id: 'u1', accountType: 'cliente', tenantKey: ACME };
const staff = { id: 'u2', accountType: 'smarteam', tenantKey: null };
const clientScope = { user: client, routeTenantKey: undefined };
const staffScope = (tenantKey) => ({ user: staff, routeTenantKey: tenantKey });

function build() {
  const reader = new FakeFieldMappingReader(sampleFieldMappings());
  const logger = { warn: jest.fn() };
  const fieldMappings = new PanelFieldMappings({
    fieldMappingReader: reader,
    tenantDirectory: new FakeTenantDirectory(TENANTS),
    logger,
  });
  return { fieldMappings, reader, logger };
}

function hasKeyDeep(value, key) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Object.entries(value).some(([name, nested]) => name === key || hasKeyDeep(nested, key));
}

describe('PanelFieldMappings.list', () => {
  it('lists the mappings of the session company, active and inactive, in the reader order', async () => {
    const { fieldMappings, reader } = build();

    const result = await fieldMappings.list({ scope: clientScope });

    expect(result.ok).toBe(true);
    expect(reader.touchedTenants).toEqual([ACME]);
    expect(result.data.items.map((item) => item.id)).toEqual([M.stock, M.name, M.legacy]);
    expect(result.data.items[0]).toEqual({
      id: M.stock,
      sourceField: 'QuantityOnStock',
      targetField: 'quantity',
      objectType: 'product',
      sourceContext: 'product',
      isActive: true,
      editable: false,
      includeInSourceQuery: false,
      userField: false,
    });
    expect(result.data.items[1].isActive).toBe(false);
    expect(result.data.items[2]).toEqual(expect.objectContaining({ sourceContext: null, isActive: true, includeInSourceQuery: true }));
  });

  it('never returns clientConfigId or hubspotCredentialId', async () => {
    const { fieldMappings } = build();

    const result = await fieldMappings.list({ scope: clientScope });

    expect(hasKeyDeep(result.data, 'clientConfigId')).toBe(false);
    expect(hasKeyDeep(result.data, 'hubspotCredentialId')).toBe(false);
  });

  it('gives Smarteam the same content for a valid company', async () => {
    const { fieldMappings } = build();

    const asClient = await fieldMappings.list({ scope: clientScope });
    const asStaff = await fieldMappings.list({ scope: staffScope(ACME) });

    expect(asStaff).toEqual(asClient);
  });

  it('answers not_found for an unknown or invalid company without reading', async () => {
    const { fieldMappings, reader } = build();

    for (const tenantKey of ['sap_integration_fantasma', '', { $ne: 1 }]) {
      expect(await fieldMappings.list({ scope: staffScope(tenantKey) })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    }
    expect(await fieldMappings.list({ scope: { user: { ...client, tenantKey: null } } })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(reader.touchedTenants).toEqual([]);
  });

  it('returns an empty list for a company without mappings', async () => {
    const { fieldMappings } = build();

    expect(await fieldMappings.list({ scope: staffScope(INITECH) })).toEqual({ ok: true, data: { items: [] } });
  });

  it('turns a query timeout into QUERY_TIMEOUT', async () => {
    const { fieldMappings, reader } = build();
    reader.timeoutNext = true;

    const result = await fieldMappings.list({ scope: clientScope });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'QUERY_TIMEOUT' }));
  });

  it('logs a warning when the list was cut at the safety cap', async () => {
    const { fieldMappings, reader, logger } = build();
    reader.truncateNext = true;

    const result = await fieldMappings.list({ scope: clientScope });

    expect(result.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ tenantKey: ACME }));
  });
});
