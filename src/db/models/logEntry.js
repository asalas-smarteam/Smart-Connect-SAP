function LogEntry(sequelize, DataTypes) {
  const LogEntry = sequelize.define(
    'LogEntry',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      type: {
        type: DataTypes.STRING,
      },
      payload: {
        type: DataTypes.JSON,
      },
      level: {
        type: DataTypes.STRING,
      },
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      timestamps: false,
    }
  );

  return LogEntry;
}

module.exports = LogEntry;
