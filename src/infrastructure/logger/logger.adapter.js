import * as loggerModule from '../../core/logger.js';

const logger = loggerModule.default;

export const loggerAdapter = logger;
export const logTenantEvent = loggerModule.logTenantEvent;

export default logger;
