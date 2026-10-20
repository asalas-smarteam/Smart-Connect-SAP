import { getSapSyncQueue } from './sapSync.queue.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
export const DEFAULT_TIMEOUT_MS = 1500;

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Scheduled runs lookup timed out')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Id del programador → configId, si es de este tenant: sap-sync:<tenantKey>:<configId>[:<slot>].
// Los ids manuales (sap-sync:manual:…) y los de otro tenant (acme vs acme2) no coinciden.
export function configIdFromSchedulerId(schedulerId, tenantKey) {
  const prefix = `sap-sync:${tenantKey}:`;
  if (typeof schedulerId !== 'string' || !schedulerId.startsWith(prefix)) {
    return null;
  }
  const [configId, slot, ...rest] = schedulerId.slice(prefix.length).split(':');
  if (rest.length > 0 || !OBJECT_ID.test(configId) || (slot !== undefined && !/^\d+$/.test(slot))) {
    return null;
  }
  return configId;
}

// Lee de BullMQ (Redis) la próxima ejecución de cada tarea programada. Solo lectura: no crea,
// borra ni mueve jobs. Con Redis caído, la conexión compartida espera sin límite, por eso el tope.
export class BullMqScheduledRunReader {
  constructor({ getQueue = getSapSyncQueue, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.getQueue = getQueue;
    this.timeoutMs = timeoutMs;
  }

  async nextRunsFor(tenantKey) {
    const queue = this.getQueue();
    const [schedulers, legacy] = await withTimeout(Promise.all([
      typeof queue.getJobSchedulers === 'function' ? queue.getJobSchedulers() : [],
      typeof queue.getRepeatableJobs === 'function' ? queue.getRepeatableJobs() : [],
    ]), this.timeoutMs);

    const runs = new Map();
    for (const job of [...(schedulers ?? []), ...(legacy ?? [])]) {
      const configId = configIdFromSchedulerId(job?.key, tenantKey) ?? configIdFromSchedulerId(job?.id, tenantKey);
      const next = Number(job?.next);
      if (!configId || !Number.isFinite(next) || next <= 0) {
        continue;
      }
      const current = runs.get(configId);
      if (!current || next < current.getTime()) {
        runs.set(configId, new Date(next));
      }
    }
    return runs;
  }
}

export default BullMqScheduledRunReader;
