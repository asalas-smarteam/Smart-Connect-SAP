export default function FieldMapping({ sequelize }, DataTypes) {
  return sequelize.define(
    'FieldMapping',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      sourceField: {
        type: DataTypes.STRING,
      },
      targetField: {
        type: DataTypes.STRING,
      },
      objectType: {
        type: DataTypes.STRING,
      },
      clientConfigId: {
        type: DataTypes.INTEGER,
      },
      hubspotCredentialId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
    },
    {
      timestamps: false,
    }
  );
}
