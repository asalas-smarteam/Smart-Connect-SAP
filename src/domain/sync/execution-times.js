// Única fuente de verdad sobre el formato de las horas de ejecución de una ClientConfig.
// Puro y sin imports a propósito: lo consumen el schema de Mongoose, el scheduler de BullMQ, el
// servicio del master y el script de migración, y ninguno debe arrastrar el grafo de módulos de
// otro.
//
// El orden ascendente y la deduplicación NO son cosmética: el nombre del job scheduler de BullMQ se
// deriva del índice dentro del array, así que un array desordenado o con repetidos produciría
// nombres distintos para la misma configuración.
export const EXECUTION_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// El tope acota además el rango de nombres que se enumeran al borrar schedulers
// (ver buildRemovalKeyCandidates en sapSyncScheduler.service.js). Si sube este número, sube esa
// enumeración con él.
export const MAX_EXECUTION_TIMES = 24;

export function normalizeExecutionTimes(value) {
  if (value === null || value === undefined || value === '') {
    return [];
  }

  const entries = Array.isArray(value) ? value : [value];
  const times = [];

  for (const entry of entries) {
    const time = String(entry ?? '').trim();

    if (!time) {
      continue;
    }

    if (!EXECUTION_TIME_PATTERN.test(time)) {
      throw new Error('executionTime must use HH:mm format');
    }

    if (!times.includes(time)) {
      times.push(time);
    }
  }

  if (times.length > MAX_EXECUTION_TIMES) {
    throw new Error(`executionTime cannot have more than ${MAX_EXECUTION_TIMES} entries`);
  }

  // 'HH:mm' con cero a la izquierda ordena lexicográficamente igual que cronológicamente.
  return times.sort();
}
