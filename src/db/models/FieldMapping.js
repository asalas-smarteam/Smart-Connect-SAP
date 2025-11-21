function FieldMapping(sequelize, DataTypes) {
  const FieldMapping = sequelize.sequelize.define(
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
    },
    {
      timestamps: false,
    }
  );

  return FieldMapping;
}

export default FieldMapping;
