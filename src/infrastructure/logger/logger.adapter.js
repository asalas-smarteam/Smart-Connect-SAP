import * as loggerModule from './logger.js';

const logger = loggerModule.default;

export const loggerAdapter = logger;
export const logTenantEvent = loggerModule.logTenantEvent;

export default logger;
