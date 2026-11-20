import { jest } from '@jest/globals';
import PanelOwnerMappings from '../../../../src/application/use-cases/panel/PanelOwnerMappings.js';
import { FakeTenantDirectory, TENANTS } from './panelFakes.js';
import { FakeOwnerMappingReader, OWNER_IDS as O, sampleOwnerMappings } from './operationFakes.js';

const ACME = 'sap_integration_acme';
const INITECH = 'sap_integration_initech';
const client = { id: 'u1', accountType: 'cliente', tenantKey: ACME };
const staff = { id: 'u2', accountType: 'smarteam', tenantKey: null };
const clientScope = { user: client, routeTenantKey: undefined };
const staffScope = (tenantKey) => ({ user: staff, routeTenantKey: tenantKey });

function build() {
  const reader = new FakeOwnerMappingReader(sampleOwnerMappings());
  const logger = { warn: jest.fn() };
  const ownerMappings = new PanelOwnerMappings({ ownerMappingReader: reader, tenantDirectory: new FakeTenantDirectory(TENANTS), logger });
  return { ownerMappings, reader, logger };
}

describe('PanelOwnerMappings.list (plan 11, N1)', () => {
  it('lists the records of the session company, active and inactive', async () => {
    const { ownerMappings, reader } = build();

    const result = await ownerMappings.list({ scope: clientScope });

    expect(result.ok).toBe(true);
    expect(reader.touchedTenants).toEqual([ACME]);
    expect(result.data.items.map((item) => item.id)).toEqual([O.erick, O.ana, O.legacy]);
    expect(result.data.items.map((item) => item.active)).toEqual([true, false, null]);
    expect(JSON.stringify(result.data)).not.toMatch(/hubspotCredentialId|__v|hubspot_seed/);
  });

  it('gives Smarteam the same content for a valid company', async () => {
    const { ownerMappings } = build();

    expect(await ownerMappings.list({ scope: staffScope(ACME) })).toEqual(await ownerMappings.list({ scope: clientScope }));
  });

  it('answers not_found for an unknown or invalid company without reading', async () => {
    const { ownerMappings, reader } = build();

    for (const tenantKey of ['sap_integration_fantasma', '', { $ne: 1 }]) {
      expect(await ownerMappings.list({ scope: staffScope(tenantKey) })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    }
    expect(reader.touchedTenants).toEqual([]);
  });

  it('returns an empty list for a company without records', async () => {
    const { ownerMappings } = build();

    expect(await ownerMappings.list({ scope: staffScope(INITECH) })).toEqual({ ok: true, data: { items: [] } });
  });

  it('turns a query timeout into QUERY_TIMEOUT and warns when the list is cut', async () => {
    const { ownerMappings, reader, logger } = build();
    reader.timeoutNext = true;
    expect(await ownerMappings.list({ scope: clientScope })).toEqual(expect.objectContaining({ ok: false, reason: 'QUERY_TIMEOUT' }));

    reader.truncateNext = true;
    await ownerMappings.list({ scope: clientScope });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ tenantKey: ACME }));
  });
});
