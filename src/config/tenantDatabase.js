import mongoose from 'mongoose';
import env from './env.js';
import { registerTenantModels } from '../db/models/tenant/index.js';

const { MONGODB_URI, TENANT_DB_PREFIX } = env;

const tenantConnections = new Map();

function buildTenantDatabaseName(tenantKey) {
  const prefix = TENANT_DB_PREFIX || 'sap_integration';
  if (tenantKey.startsWith(`${prefix}_`)) {
    return tenantKey;
  }
  return `${prefix}_${tenantKey}`;
}

async function getTenantConnection(tenantKey) {
  if (!tenantKey) {
    throw new Error('tenantKey is required to connect to tenant database');
  }

  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not defined');
  }

  const databaseName = buildTenantDatabaseName(tenantKey);
  const cached = tenantConnections.get(databaseName);

  if (cached?.connection?.readyState === 1) {
    return cached.connection;
  }

  if (cached?.connecting) {
    await cached.connecting;
    return cached.connection;
  }

  const connection = mongoose.createConnection(MONGODB_URI, { dbName: databaseName });
  const connecting = connection.asPromise();
  tenantConnections.set(databaseName, { connection, connecting });
  await connecting;
  tenantConnections.set(databaseName, { connection });
  return connection;
}

async function getTenantModels(tenantKey) {
  const connection = await getTenantConnection(tenantKey);
  return registerTenantModels(connection);
}

async function disconnectTenantConnections() {
  await Promise.all(
    Array.from(tenantConnections.values()).map(({ connection }) => connection.close())
  );
  tenantConnections.clear();
}

export {
  buildTenantDatabaseName,
  getTenantConnection,
  getTenantModels,
  disconnectTenantConnections,
};
