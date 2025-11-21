function ClientConfig(sequelize, DataTypes) {
  const ClientConfig = sequelize.sequelize.define(
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

  return ClientConfig;
}

export default ClientConfig;
