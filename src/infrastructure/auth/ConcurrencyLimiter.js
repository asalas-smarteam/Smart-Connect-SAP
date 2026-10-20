import { PanelHasherBusyError } from '#domain/panel/errors.js';

// Semáforo con cola acotada. Como mucho maxConcurrent tareas corren a la vez; hasta maxQueue
// esperan su turno en orden de llegada; con la cola llena se rechaza sin ejecutar la tarea.
export class ConcurrencyLimiter {
  constructor({ maxConcurrent = 2, maxQueue = 32, createBusyError = () => new PanelHasherBusyError() } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.createBusyError = createBusyError;
    this.active = 0;
    this.queue = [];
  }

  async run(task) {
    if (this.active >= this.maxConcurrent) {
      if (this.queue.length >= this.maxQueue) {
        throw this.createBusyError();
      }
      await new Promise((resolve) => this.queue.push(resolve));
    } else {
      this.active += 1;
    }

    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  // El lugar pasa directo al siguiente de la cola: active no baja si alguien espera.
  #release() {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

export default ConcurrencyLimiter;
