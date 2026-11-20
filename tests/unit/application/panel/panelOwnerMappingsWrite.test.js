import { jest } from '@jest/globals';
import PanelOwnerMappingsWrite from '../../../../src/application/use-cases/panel/PanelOwnerMappingsWrite.js';
import { FakeLoginAttempts, FakeTenantDirectory, TENANTS } from './panelFakes.js';
import {
  ACME_CREDENTIAL,
  ACME_CREDENTIAL_2,
  FakeCrmOwnerDirectory,
  InMemoryOwnerMappingWriter,
  OWNER_IDS as O,
  sampleCrmDirectory,
} from './ownerMappingWriteFakes.js';

const ACME = 'sap_integration_acme';
const INITECH = 'sap_integration_initech';
const NOW = new Date('2026-11-20T15:04:05.000Z');
const VERSION = '2026-07-03T02:03:51.125Z';
const client = { id: 'u1', name: 'Adriana Solís', email: 'admin@acme.test', accountType: 'cliente', role: 'admin', tenantKey: ACME };
const staff = { id: 'u2', name: 'Dev Smarteam', email: 'dev@smarteam.test', accountType: 'smarteam', tenantKey: null };
const clientScope = { user: client, routeTenantKey: undefined };
const staffScope = (tenantKey) => ({ user: staff, routeTenantKey: tenantKey });

function build({ crm = sampleCrmDirectory(), syncAttempts = null } = {}) {
  const writer = new InMemoryOwnerMappingWriter();
  const logger = { warn: jest.fn(), error: jest.fn() };
  const useCase = new PanelOwnerMappingsWrite({
    ownerMappingWriter: writer,
    crmOwnerDirectory: crm,
    tenantDirectory: new FakeTenantDirectory(TENANTS),
    syncAttempts,
    logger,
    now: () => NOW,
  });
  return { useCase, writer, crm, logger };
}

function patch(overrides = {}) {
  return { erpOwnerId: '113,758', erpEmployeeId: '70', expectedUpdatedAt: VERSION, ...overrides };
}

describe('PanelOwnerMappingsWrite.update (plan 12, O2 and O4)', () => {
  it('saves both codes, moves updatedAt and answers the N2 view', async () => {
    const { useCase, writer } = build();

    const result = await useCase.update({ scope: clientScope, id: O.erick, body: patch({ erpOwnerId: ' 113 , 758 ' }) });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({ id: O.erick, erpOwnerId: '113,758', erpEmployeeId: '70', crmOwnerId: '82929225', source: 'crm_seed' }));
    expect(result.data.updatedAt).not.toBe(VERSION);
    expect(JSON.stringify(result.data)).not.toMatch(/hubspotCredentialId|__v/);
    expect(writer.find(ACME, O.erick).sapOwnerId).toBe('113,758');
  });

  it('writes one history entry with who, when, from and to in the right tenant', async () => {
    const { useCase, writer } = build();

    await useCase.update({ scope: clientScope, id: O.erick, body: patch() });

    expect(writer.historyOf(ACME)).toEqual([{
      mappingId: O.erick,
      crmOwnerId: '82929225',
      action: 'updated',
      changedBy: { userId: 'u1', name: 'Adriana Solís', email: 'admin@acme.test', accountType: 'cliente' },
      changedAt: NOW,
      changes: [
        { field: 'erpOwnerId', from: '53', to: '113,758' },
        { field: 'erpEmployeeId', from: '67', to: '70' },
      ],
    }]);
    expect(writer.historyOf(INITECH)).toEqual([]);
  });

  it('records only the field that really changed and stores null for "" and null', async () => {
    const { useCase, writer } = build();

    await useCase.update({ scope: staffScope(ACME), id: O.erick, body: patch({ erpOwnerId: '53', erpEmployeeId: '' }) });

    const [entry] = writer.historyOf(ACME);
    expect(entry.changes).toEqual([{ field: 'erpEmployeeId', from: '67', to: null }]);
    expect(entry.changedBy.accountType).toBe('smarteam');
    expect(writer.find(ACME, O.erick).sapOwnerId_2).toBeNull();
  });

  it('answers 200 with the row as is when nothing changes, without writing or history', async () => {
    const { useCase, writer } = build();

    const result = await useCase.update({ scope: clientScope, id: O.erick, body: patch({ erpOwnerId: '53', erpEmployeeId: ' 67 ' }) });

    expect(result.ok).toBe(true);
    expect(result.data.updatedAt).toBe(VERSION);
    expect(writer.updateCalls).toBe(0);
    expect(writer.historyOf(ACME)).toEqual([]);
  });

  it('answers stale_update when the version read is not the current one, without writing', async () => {
    const { useCase, writer } = build();
    await useCase.update({ scope: clientScope, id: O.erick, body: patch() });
    const calls = writer.updateCalls;

    const result = await useCase.update({ scope: clientScope, id: O.erick, body: patch({ erpOwnerId: '1' }) });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'STALE_UPDATE' }));
    expect(writer.updateCalls).toBe(calls);
  });

  it('answers stale_update when another editor wins the race between the read and the write', async () => {
    const { useCase, writer } = build();
    const original = writer.findById.bind(writer);
    let first = true;
    writer.findById = async (tenantKey, id) => {
      const row = await original(tenantKey, id);
      if (first) {
        first = false;
        writer.find(tenantKey, id).updatedAt = new Date('2026-11-20T00:00:00.000Z');
      }
      return row;
    };

    const result = await useCase.update({ scope: clientScope, id: O.erick, body: patch() });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'STALE_UPDATE' }));
    expect(writer.historyOf(ACME)).toEqual([]);
  });

  it('answers not_found when the row disappears between the read and the write', async () => {
    const { useCase, writer } = build();
    const original = writer.findById.bind(writer);
    let calls = 0;
    writer.findById = async (tenantKey, id) => {
      calls += 1;
      return calls === 1 ? original(tenantKey, id) : null;
    };
    writer.updateErpCodes = async () => null;

    expect(await useCase.update({ scope: clientScope, id: O.erick, body: patch() })).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('answers erp_owner_taken when the seller code is in another row of the same credential', async () => {
    const { useCase, writer } = build();

    const result = await useCase.update({ scope: clientScope, id: O.erick, body: patch({ erpOwnerId: '113,758,864' }) });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'ERP_OWNER_TAKEN' }));
    expect(writer.find(ACME, O.erick).sapOwnerId).toBe('53');
    expect(writer.historyOf(ACME)).toEqual([]);
  });

  it('answers 400 for invalid bodies before reading', async () => {
    const { useCase, writer } = build();

    for (const body of [
      patch({ active: false }),
      patch({ erpEmployeeId: '1,2' }),
      patch({ erpOwnerId: { $gt: '' } }),
      patch({ erpOwnerId: true }),
      { erpOwnerId: '1' },
      { expectedUpdatedAt: VERSION },
      null,
      [],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await useCase.update({ scope: clientScope, id: O.erick, body });
      expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'VALIDATION_ERROR', message: expect.any(String) }));
    }
    expect(writer.touchedTenants).toEqual([]);
  });

  it('never reaches rows of another company and answers not_found for unknown ids or tenants', async () => {
    const { useCase } = build();
    const otherCompany = { ...client, tenantKey: INITECH };

    expect(await useCase.update({ scope: { user: otherCompany }, id: O.erick, body: patch() })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(await useCase.update({ scope: clientScope, id: 'ffffffffffffffffffffffff', body: patch() })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(await useCase.update({ scope: clientScope, id: 'abc', body: patch() })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(await useCase.update({ scope: staffScope('sap_integration_fantasma'), id: O.erick, body: patch() })).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('still answers 200 when the history write fails, and logs it without personal data', async () => {
    const { useCase, writer, logger } = build();
    writer.failHistoryNext = true;

    const result = await useCase.update({ scope: clientScope, id: O.erick, body: patch() });

    expect(result.ok).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ mappingId: O.erick, tenantKey: ACME }));
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/admin@acme\.test|Adriana/);
  });
});

describe('PanelOwnerMappingsWrite.sync (plan 12, O3 and O4)', () => {
  it('inserts only the missing owners like the seed and refreshes name and email', async () => {
    const { useCase, writer } = build();

    const result = await useCase.sync({ scope: clientScope });

    expect(result).toEqual({ ok: true, data: { added: 2, updated: 1, total: 5 } });
    const luis = writer.tenantRows(ACME).find((row) => row.hubspotOwnerId === '93000001');
    expect(luis).toEqual(expect.objectContaining({
      hubspotCredentialId: ACME_CREDENTIAL,
      hubspotOwnerName: 'Luis Vega',
      sapOwnerId: null,
      sapOwnerId_2: null,
      sapOwnerName: null,
      active: true,
      source: 'hubspot_seed',
    }));
    expect(writer.find(ACME, O.ana).hubspotOwnerEmail).toBe('ana@acme.test');
  });

  it('never touches ERP codes, active or source, never deletes and keeps updatedAt on refresh', async () => {
    const { useCase, writer } = build();
    const before = structuredClone(writer.tenantRows(ACME));

    await useCase.sync({ scope: clientScope });

    for (const row of before) {
      const after = writer.find(ACME, row._id);
      expect(after).toBeTruthy();
      for (const field of ['sapOwnerId', 'sapOwnerId_2', 'sapOwnerName', 'active', 'source', 'updatedAt']) {
        expect(after[field]).toEqual(row[field]);
      }
    }
  });

  it('writes one synced_created entry per inserted row and none for refreshes', async () => {
    const { useCase, writer } = build();

    await useCase.sync({ scope: staffScope(ACME) });

    const history = writer.historyOf(ACME);
    expect(history).toHaveLength(2);
    expect(history.every((entry) => entry.action === 'synced_created' && entry.changes.length === 0)).toBe(true);
    expect(history.map((entry) => entry.crmOwnerId)).toEqual(['93000001', '93000002']);
    expect(history[0].changedBy).toEqual({ userId: 'u2', name: 'Dev Smarteam', email: 'dev@smarteam.test', accountType: 'smarteam' });
  });

  it('is idempotent', async () => {
    const { useCase, writer } = build();
    await useCase.sync({ scope: clientScope });

    expect(await useCase.sync({ scope: clientScope })).toEqual({ ok: true, data: { added: 0, updated: 0, total: 5 } });
    expect(writer.historyOf(ACME)).toHaveLength(2);
  });

  it('treats a duplicate key race as "already exists"', async () => {
    const { useCase, writer } = build();
    writer.raceOnInsert.add('93000001');

    const result = await useCase.sync({ scope: clientScope });

    expect(result.data).toEqual({ added: 1, updated: 1, total: 5 });
    expect(writer.historyOf(ACME).map((entry) => entry.crmOwnerId)).toEqual(['93000002']);
  });

  it('goes through every credential of the tenant', async () => {
    const crm = sampleCrmDirectory();
    crm.credentialsByTenant[ACME].push(ACME_CREDENTIAL_2);
    crm.ownersByCredential[ACME_CREDENTIAL_2] = [{ hubspotOwnerId: '82929225', hubspotOwnerName: 'Erick Figueroa', hubspotOwnerEmail: 'e@otro.test' }];
    const { useCase, writer } = build({ crm });

    const result = await useCase.sync({ scope: clientScope });

    expect(crm.fetchCalls).toEqual([ACME_CREDENTIAL, ACME_CREDENTIAL_2]);
    expect(result.data).toEqual({ added: 3, updated: 1, total: 6 });
    expect(writer.tenantRows(ACME).filter((row) => row.hubspotOwnerId === '82929225')).toHaveLength(2);
  });

  it('answers crm_unavailable when a credential fails, keeping what other credentials inserted', async () => {
    const crm = sampleCrmDirectory();
    crm.credentialsByTenant[ACME].unshift(ACME_CREDENTIAL_2);
    crm.failing.add(ACME_CREDENTIAL_2);
    const { useCase, writer, logger } = build({ crm });

    const result = await useCase.sync({ scope: clientScope });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'CRM_UNAVAILABLE' }));
    expect(writer.tenantRows(ACME).filter((row) => String(row.hubspotCredentialId) === ACME_CREDENTIAL_2)).toEqual([]);
    expect(writer.tenantRows(ACME)).toHaveLength(5);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ tenantKey: ACME, credentialId: ACME_CREDENTIAL_2, status: 401 }));
  });

  it('answers crm_unavailable when the tenant has no CRM credential', async () => {
    const { useCase } = build({ crm: new FakeCrmOwnerDirectory() });

    expect(await useCase.sync({ scope: clientScope })).toEqual(expect.objectContaining({ ok: false, reason: 'CRM_UNAVAILABLE' }));
  });

  it('allows one sync per minute per tenant (429 with Retry-After)', async () => {
    const { useCase, crm } = build({ syncAttempts: new FakeLoginAttempts(1) });

    expect((await useCase.sync({ scope: clientScope })).ok).toBe(true);
    const second = await useCase.sync({ scope: staffScope(ACME) });

    expect(second).toEqual(expect.objectContaining({ ok: false, reason: 'TOO_MANY_REQUESTS', retryAfterSeconds: 60 }));
    expect(crm.listCalls).toBe(1);
  });

  it('answers not_found for an unknown tenant without touching the CRM', async () => {
    const { useCase, crm } = build();

    expect(await useCase.sync({ scope: staffScope('sap_integration_fantasma') })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(crm.listCalls).toBe(0);
  });
});
