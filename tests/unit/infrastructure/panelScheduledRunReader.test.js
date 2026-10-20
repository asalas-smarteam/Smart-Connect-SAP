import { jest } from '@jest/globals';
import BullMqScheduledRunReader, { configIdFromSchedulerId } from '../../../src/infrastructure/queue/BullMqScheduledRunReader.js';
import { ScheduledRunReaderPort } from '../../../src/application/ports/panel/scheduled-run-reader.port.js';
import { assertPort } from '../../../src/application/ports/port-validator.js';

const ACME = 'sap_integration_acme';
const A = '6a6b9490cd7c01b21aa58c3e';
const B = '6a6b9490cd7c01b21aa58c3f';
const at = (iso) => new Date(iso).getTime();

function queue({ schedulers = [], legacy = [] } = {}) {
  return {
    getJobSchedulers: jest.fn().mockResolvedValue(schedulers),
    getRepeatableJobs: jest.fn().mockResolvedValue(legacy),
  };
}

describe('BullMqScheduledRunReader (plan 7, J5)', () => {
  it('implements the port', () => {
    expect(() => assertPort(new BullMqScheduledRunReader({ getQueue: () => queue() }), ScheduledRunReaderPort)).not.toThrow();
  });

  it.each([
    [`sap-sync:${ACME}:${A}`, A],
    [`sap-sync:${ACME}:${A}:2`, A],
    [`sap-sync:${ACME}2:${A}`, null],
    [`sap-sync:manual:${ACME}:${A}:1700000000000`, null],
    [`sap-sync:${ACME}:no-es-id`, null],
    [`sap-sync:${ACME}:${A}:x`, null],
    [undefined, null],
  ])('reads %s as %s', (id, expected) => {
    expect(configIdFromSchedulerId(id, ACME)).toBe(expected);
  });

  it('takes the nearest next run among the slots of each task of the tenant', async () => {
    const reader = new BullMqScheduledRunReader({
      getQueue: () => queue({
        schedulers: [
          { key: `sap-sync:${ACME}:${A}:0`, next: at('2026-10-21T19:00:00Z') },
          { key: `sap-sync:${ACME}:${A}:1`, next: at('2026-10-21T13:00:00Z') },
          { key: `sap-sync:${ACME}2:${B}`, next: at('2026-10-21T10:00:00Z') },
        ],
        legacy: [{ key: 'md5hash', id: `sap-sync:${ACME}:${B}`, next: at('2026-10-21T15:00:00Z') }],
      }),
    });

    const runs = await reader.nextRunsFor(ACME);

    expect([...runs.keys()].sort()).toEqual([A, B]);
    expect(runs.get(A).toISOString()).toBe('2026-10-21T13:00:00.000Z');
    expect(runs.get(B).toISOString()).toBe('2026-10-21T15:00:00.000Z');
  });

  it('rejects when Redis takes too long', async () => {
    const slow = { getJobSchedulers: () => new Promise(() => {}), getRepeatableJobs: () => Promise.resolve([]) };
    const reader = new BullMqScheduledRunReader({ getQueue: () => slow, timeoutMs: 20 });

    await expect(reader.nextRunsFor(ACME)).rejects.toThrow('timed out');
  });

  it('rejects when Redis fails', async () => {
    const broken = { getJobSchedulers: jest.fn().mockRejectedValue(new Error('down')), getRepeatableJobs: jest.fn().mockResolvedValue([]) };
    const reader = new BullMqScheduledRunReader({ getQueue: () => broken });

    await expect(reader.nextRunsFor(ACME)).rejects.toThrow('down');
  });
});
