import TenantOperationsReader from './TenantOperationsReader.js';

// Lectura del evento o la sync enlazados a un ticket, en la base del tenant de la sesión.
// Delega en el lector de eventos y syncs (driver nativo, sin modelos): leer no crea nada y las
// proyecciones son las mismas del panel (sin payload completo, auditoría, errores ni credenciales).
export class TenantTicketContextReader {
  constructor({ operationsReader = new TenantOperationsReader() } = {}) {
    this.operationsReader = operationsReader;
  }

  async readEvent(tenantKey, id) {
    return this.operationsReader.findEvent(tenantKey, id, { withRaw: false });
  }

  async readSync(tenantKey, id) {
    const found = await this.operationsReader.findSync(tenantKey, id, { errorsLimit: 0 });
    if (!found) {
      return null;
    }
    const { sync } = found;
    const [task = null] = sync.clientConfigId
      ? await this.operationsReader.findTasks(tenantKey, [String(sync.clientConfigId)])
      : [];
    return { sync, task };
  }
}

export default TenantTicketContextReader;
