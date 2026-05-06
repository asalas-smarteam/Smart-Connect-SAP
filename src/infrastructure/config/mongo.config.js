import env from './env.js';

export const mongoConfig = Object.freeze({
  uri: env.MONGODB_URI,
  tenantDbPrefix: env.TENANT_DB_PREFIX || 'sap_integration',
});

export default mongoConfig;

