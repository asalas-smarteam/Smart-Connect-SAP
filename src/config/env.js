import dotenv from 'dotenv';

dotenv.config();

const {
  PORT,
  DB_HOST,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_PORT,
  SAP_SYNC_CRON_ENABLED,
} = process.env;

export default {
  PORT,
  DB_HOST,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_PORT,
  SAP_SYNC_CRON_ENABLED,
};
