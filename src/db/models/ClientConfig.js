export default function ClientConfig({ sequelize }, DataTypes) {
  return sequelize.define(
    'ClientConfig',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      clientName: {
        type: DataTypes.STRING,
      },
      integrationModeId: {
        type: DataTypes.INTEGER,
      },
      apiUrl: {
        type: DataTypes.STRING,
      },
      apiToken: {
        type: DataTypes.STRING,
      },
      storeProcedureName: {
        type: DataTypes.STRING,
      },
      sqlQuery: {
        type: DataTypes.TEXT,
      },
      intervalMinutes: {
        type: DataTypes.INTEGER,
      },
      externalDbHost: {
        type: DataTypes.STRING,
      },
      externalDbPort: {
        type: DataTypes.INTEGER,
      },
      externalDbUser: {
        type: DataTypes.STRING,
      },
      externalDbPassword: {
        type: DataTypes.STRING,
      },
      externalDbName: {
        type: DataTypes.STRING,
      },
      externalDbDialect: {
        type: DataTypes.STRING,
      },
      associationFetchEnabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      associationFetchConfig: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: `
    Arreglo de configuraciones de extracción por objeto:

    [
      {
        "objectType": "company",
        "associationFetchType": "api",      // 'api' | 'sp'
        "associationFetchConfig": {
            "url": "https://api.test.com",
            "method": "GET"
        }
      },
      {
        "objectType": "product",
        "associationFetchType": "sp",       // 'api' | 'sp'
        "associationFetchConfig": {
            "storedProcedure": "sp_get_associations"
        }
      }
    ]
  `,
      },
      hubspotCredentialId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      objectType: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      lastRun: {
        type: DataTypes.DATE,
      },
      lastError: {
        type: DataTypes.TEXT,
      },
      requireUpdateHubspotID: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      updateMethod: {
        type: DataTypes.STRING,
      },
      updateSpName: {
        type: DataTypes.STRING,
      },
      updateTableName: {
        type: DataTypes.STRING,
      },
    },
    {
      timestamps: false,
    }
  );

}
