const { Sequelize } = require('sequelize');
const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT } = require('./env');
const logger = require('../core/logger');

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
  host: DB_HOST,
  port: DB_PORT,
  dialect: 'mysql',
});

async function connect() {
  try {
    await sequelize.authenticate();
    logger.info('Database connected');
  } catch (error) {
    logger.error('Error connecting to the database:', error);
  }
}

module.exports = { sequelize, connect };
