import PanelAuditLog from '../models/global/PanelAuditLog.js';
import defaultLogger from '../../logger/logger.adapter.js';

// Escritura best effort: si falla, se loguea y la acción del usuario sigue. La auditoría y los
// usuarios viven en la misma master, así que si esa base cae la acción falla igual.
export class MongoosePanelAuditLog {
  constructor({ model = PanelAuditLog, logger = defaultLogger } = {}) {
    this.model = model;
    this.logger = logger;
  }

  async record(entry) {
    try {
      await this.model.create(entry);
    } catch (error) {
      this.logger.error({
        msg: 'Panel audit log write failed',
        action: entry?.action ?? null,
        error: error?.message,
      });
    }
  }
}

export default MongoosePanelAuditLog;
