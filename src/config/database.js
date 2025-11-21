import Sequelize from 'sequelize';
import env from './env.js';

const {
  DB_HOST,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_PORT
} = env;

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
  host: DB_HOST,
  port: DB_PORT,
  dialect: 'mysql',
});

async function connect() {
  try {
    await sequelize.authenticate();
    await sequelize.sync({ alter: true });
    console.info('Database connected');
  } catch (error) {
    console.error('Error connecting to the database:', error);
  }
}

export default { sequelize, connect };
