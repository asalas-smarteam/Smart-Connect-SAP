function getTenantLogEntry(tenantModels) {
  if (!tenantModels) {
    throw new Error('Tenant models are required for logging');
  }
  return tenantModels.LogEntry;
}

const loggingService = {
  async logEvent(type, payload, level = 'info', tenantModels) {
    try {
      const LogEntry = getTenantLogEntry(tenantModels);
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
