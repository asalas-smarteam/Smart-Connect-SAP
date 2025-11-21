export default function defineIntegrationMode({ sequelize }, DataTypes) {
  return sequelize.define(
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
}
