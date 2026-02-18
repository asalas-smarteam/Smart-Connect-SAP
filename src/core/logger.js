import winston from 'winston';
import { getTenantModels } from '../config/tenantDatabase.js';

const customLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const logger = winston.createLogger({
  levels: customLevels,
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({ level: 'info' }),
    new winston.transports.File({ filename: 'logs/app.log' }),
  ],
});

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

export async function logTenantEvent(tenantContext, { type, payload, level = 'info' }) {
  const tenantKey = resolveTenantKey(tenantContext);
  const tenantModels = await getTenantModels(tenantKey);
  await tenantModels.LogEntry.create({
    type,
    payload,
    level,
  });
}

export default logger;
