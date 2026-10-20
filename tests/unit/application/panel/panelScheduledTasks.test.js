import { jest } from '@jest/globals';
import PanelScheduledTasks from '../../../../src/application/use-cases/panel/PanelScheduledTasks.js';
import { FakeTenantDirectory, TENANTS } from './panelFakes.js';
import {
  FakeScheduledRunReader,
  FakeScheduledTaskReader,
  NEXT_RUN,
  TASK_IDS as T,
  sampleNextRuns,
  sampleScheduledTasks,
} from './operationFakes.js';

const ACME = 'sap_integration_acme';
const INITECH = 'sap_integration_initech';
const client = { id: 'u1', accountType: 'cliente', tenantKey: ACME };
const staff = { id: 'u2', accountType: 'smarteam', tenantKey: null };
const clientScope = { user: client, routeTenantKey: undefined };
const staffScope = (tenantKey) => ({ user: staff, routeTenantKey: tenantKey });

function build() {
  const reader = new FakeScheduledTaskReader(sampleScheduledTasks());
  const runReader = new FakeScheduledRunReader(sampleNextRuns());
  const logger = { warn: jest.fn() };
  const scheduledTasks = new PanelScheduledTasks({
    scheduledTaskReader: reader,
    scheduledRunReader: runReader,
    tenantDirectory: new FakeTenantDirectory(TENANTS),
    logger,
  });
  return { scheduledTasks, reader, runReader, logger };
}

describe('PanelScheduledTasks.list', () => {
  it('lists the tasks of the session company in the reader order, with the next run', async () => {
    const { scheduledTasks, reader } = build();

    const result = await scheduledTasks.list({ scope: clientScope });

    expect(result.ok).toBe(true);
    expect(reader.touchedTenants).toEqual([ACME]);
    expect(result.data.items.map((item) => item.id)).toEqual([T.products, T.options, T.orders]);
    expect(result.data.items[0].nextRunAt).toBe(NEXT_RUN);
    expect(result.data.items[2].nextRunAt).toBeNull();
  });

  it('sanitizes for the client and not for Smarteam', async () => {
    const { scheduledTasks } = build();

    const asClient = await scheduledTasks.list({ scope: clientScope });
    const asStaff = await scheduledTasks.list({ scope: staffScope(ACME) });

    expect(asClient.data.items[0].lastError).not.toMatch(/10\.0\.0\.5/);
    expect(asStaff.data.items[0].lastError).toMatch(/10\.0\.0\.5/);
    expect(asClient.data.items[1].sourcePath).toBe('/b1s/v1/ItemGroups');
    expect(JSON.stringify(asStaff.data)).not.toMatch(/apiToken|sqlQuery|token-secreto|SELECT/);
  });

  it('answers not_found for an unknown or invalid company without reading', async () => {
    const { scheduledTasks, reader, runReader } = build();

    for (const tenantKey of ['sap_integration_fantasma', '', { $ne: 1 }]) {
      expect(await scheduledTasks.list({ scope: staffScope(tenantKey) })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    }
    expect(reader.touchedTenants).toEqual([]);
    expect(runReader.touchedTenants).toEqual([]);
  });

  it('returns an empty list for a company without tasks', async () => {
    const { scheduledTasks } = build();

    expect(await scheduledTasks.list({ scope: staffScope(INITECH) })).toEqual({ ok: true, data: { items: [] } });
  });

  it('keeps the list when the next runs are unavailable and logs a warning', async () => {
    const { scheduledTasks, runReader, logger } = build();
    runReader.failNext = true;

    const result = await scheduledTasks.list({ scope: clientScope });

    expect(result.ok).toBe(true);
    expect(result.data.items.every((item) => item.nextRunAt === null)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ tenantKey: ACME }));
  });

  it('turns a query timeout into QUERY_TIMEOUT', async () => {
    const { scheduledTasks, reader } = build();
    reader.timeoutNext = true;

    expect(await scheduledTasks.list({ scope: clientScope })).toEqual(expect.objectContaining({ ok: false, reason: 'QUERY_TIMEOUT' }));
  });
});
