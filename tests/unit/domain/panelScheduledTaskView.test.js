import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SCHEDULER_TIME_ZONE, toScheduledTaskView } from '../../../src/domain/panel/scheduledTaskView.js';
import { NEXT_RUN, TASK_IDS as T, sampleScheduledTasks } from '../application/panel/operationFakes.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const [products, options, orders] = sampleScheduledTasks().sap_integration_acme;
const FORBIDDEN = [
  'apiToken', 'apiUrl', 'sqlQuery', 'storeProcedureName', 'updateMethod', 'updateSpName', 'updateTableName',
  'integrationModeId', 'hubspotCredentialId', 'associationFetchConfig', 'externalDbPassword', 'externalDbHost',
  'externalDbUser', '__v', 'serviceLayerPath', 'hubspotBatchSize', 'requireUpdateHubspotID', 'clientName', 'lastRun',
];

function keysDeep(value, into = new Set()) {
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      keysDeep(nested, into);
    }
  }
  return into;
}

describe('scheduled task view (plan 7, J2)', () => {
  it('maps every field with the generic names', () => {
    const view = toScheduledTaskView(products, { side: 'smarteam', nextRunAt: new Date(NEXT_RUN) });

    expect(view).toEqual({
      id: T.products,
      name: 'Obtener Productos',
      type: 'record_sync',
      objectType: 'product',
      sourcePath: '/Items',
      mode: 'full',
      schedule: {
        intervalMinutes: null,
        times: ['07:00', '12:00'],
        days: ['monday', 'tuesday'],
        startTime: null,
        endTime: null,
        timeZone: 'America/Costa_Rica',
      },
      batchSize: 100,
      associationsEnabled: false,
      requireCrmIdUpdate: true,
      filters: [
        { property: 'ItemsGroupCode', operator: 'in', value: [101, 102], isDefault: false, isDynamic: false, dynamicType: null, editable: true },
        { property: 'UpdateDate', operator: 'ge', value: null, isDefault: true, isDynamic: true, dynamicType: 'date', editable: false },
      ],
      orderBy: [{ property: 'DocDate', direction: 'desc' }],
      active: true,
      lastRunAt: '2026-09-22T21:42:33.950Z',
      lastError: 'AxiosError: connect ECONNREFUSED 10.0.0.5:50000',
      nextRunAt: NEXT_RUN,
    });
  });

  it.each(['cliente', 'smarteam'])('never exposes internal fields to %s', (side) => {
    const keys = keysDeep(toScheduledTaskView({ ...products, externalDbPassword: 'x', externalDbHost: 'h', externalDbUser: 'u' }, { side }));

    for (const key of FORBIDDEN) {
      expect(keys.has(key)).toBe(false);
    }
  });

  it('sanitizes lastError for the client and keeps it raw for Smarteam', () => {
    const client = toScheduledTaskView(products, { side: 'cliente' });
    const staff = toScheduledTaskView(products, { side: 'smarteam' });

    expect(client.lastError).not.toMatch(/10\.0\.0\.5|ECONNREFUSED|AxiosError/);
    expect(typeof client.lastError).toBe('string');
    expect(staff.lastError).toBe(products.lastError);
  });

  it('gives the client only the path when sourcePath has a scheme and host', () => {
    expect(toScheduledTaskView(options, { side: 'cliente' }).sourcePath).toBe('/b1s/v1/ItemGroups');
    expect(toScheduledTaskView(options, { side: 'smarteam' }).sourcePath).toBe(options.serviceLayerPath);
  });

  it('maps the dropdown type, the incremental window and the interval', () => {
    const view = toScheduledTaskView(options, { side: 'smarteam' });

    expect(view.type).toBe('dropdown_options');
    expect(view.mode).toBe('incremental');
    expect(view.objectType).toBeNull();
    expect(view.schedule).toEqual(expect.objectContaining({ intervalMinutes: 30, startTime: '06:00', endTime: '18:00', times: [], days: [] }));
  });

  it('uses the schema defaults for an old document', () => {
    expect(toScheduledTaskView(orders)).toEqual(expect.objectContaining({
      type: 'record_sync',
      objectType: null,
      sourcePath: null,
      mode: 'incremental',
      batchSize: 1,
      associationsEnabled: false,
      requireCrmIdUpdate: false,
      filters: [],
      orderBy: [],
      active: false,
      lastRunAt: null,
      lastError: null,
    }));
  });

  it('shows nextRunAt only for active tasks', () => {
    expect(toScheduledTaskView(orders, { nextRunAt: new Date(NEXT_RUN) }).nextRunAt).toBeNull();
    expect(toScheduledTaskView(products).nextRunAt).toBeNull();
  });

  it('answers null for an unknown task type and empty texts', () => {
    const view = toScheduledTaskView({ _id: 'x', taskType: 'OTRO', clientName: '', startTime: '' });

    expect(view.type).toBeNull();
    expect(view.name).toBeNull();
    expect(view.schedule.startTime).toBeNull();
  });

  it('keeps the same time zone as the sync scheduler', () => {
    const source = readFileSync(path.join(projectRoot, 'src/infrastructure/scheduler/sapSyncScheduler.service.js'), 'utf8');
    const match = /SAP_SYNC_SCHEDULER_TIMEZONE\s*=\s*'([^']+)'/.exec(source);

    expect(match?.[1]).toBe(SCHEDULER_TIME_ZONE);
  });
});
