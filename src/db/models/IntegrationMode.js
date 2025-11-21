function IntegrationMode(sequelize, DataTypes) {
  const IntegrationMode = sequelize.sequelize.define(
    'IntegrationMode',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      name: {
        type: DataTypes.STRING,
        unique: true,
      },
      description: {
        type: DataTypes.STRING,
      },
    },
    {
      timestamps: false,
    }
  );

  return IntegrationMode;
}

export default IntegrationMode;
