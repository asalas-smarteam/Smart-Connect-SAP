const dotenv = require('dotenv');

dotenv.config();

const { MONGODB_URI } = process.env;

const databaseName = MONGODB_URI
  ? new URL(MONGODB_URI).pathname.replace(/^\//, '')
  : 'smart-connect-sap';

module.exports = {
  mongodb: {
    url: MONGODB_URI,
    databaseName,
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    },
  },
  migrationsDir: 'scripts/migrations',
  changelogCollectionName: 'migrations_changelog',
  migrationFileExtension: '.js',
  moduleSystem: 'esm',
};
