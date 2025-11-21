import dotenv from 'dotenv';

dotenv.config();

const {
  PORT,
  DB_HOST,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_PORT,
} = process.env;

export default {
  PORT,
  DB_HOST,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_PORT,
};
