import { getTenantModels } from '../config/tenantDatabase.js';

function resolveTenantKey(tenantContext) {
  if (!tenantContext) {
    throw new Error('tenantKey is required for logging');
  }

  if (typeof tenantContext === 'string') {
    return tenantContext;
  }

  if (tenantContext.tenantKey) {
    return tenantContext.tenantKey;
  }

  if (tenantContext?.tenant?.client?.tenantKey) {
    return tenantContext.tenant?.client?.tenantKey;
  }

  throw new Error('tenantKey is required for logging');
}

async function getTenantLogEntry(tenantContext) {
  const tenantKey = resolveTenantKey(tenantContext);
  const tenantModels = await getTenantModels(tenantKey);
  return tenantModels.LogEntry;
}

const loggingService = {
  async logEvent(type, payload, level = 'info', tenantContext) {
    try {
      const LogEntry = await getTenantLogEntry(tenantContext);
      await LogEntry.create({
        type,
        payload,
        level,
      });
    } catch (error) {
      console.error('Failed to log event:', error);
    }
  },
};

export default loggingService;
