import dotenv from 'dotenv';

dotenv.config();

const {
  PORT,
  MONGODB_URI,
  SAP_SYNC_CRON_ENABLED,
  JWT_SECRET,
  TENANT_DB_PREFIX,
  INTERNAL_KEY,
} = process.env;

export default {
  PORT,
  MONGODB_URI,
  SAP_SYNC_CRON_ENABLED,
  JWT_SECRET,
  TENANT_DB_PREFIX,
  INTERNAL_KEY,
};
