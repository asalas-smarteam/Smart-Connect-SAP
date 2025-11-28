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
      hubspotCredentialId: {
        type: DataTypes.INTEGER,
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
    },
    {
      timestamps: false,
    }
  );

}
