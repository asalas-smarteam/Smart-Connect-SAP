export default function SyncLog({ sequelize }, DataTypes) {
  return sequelize.define(
    'SyncLog',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      clientConfigId: {
        type: DataTypes.INTEGER,
      },
      status: {
        type: DataTypes.STRING,
      },
      recordsProcessed: {
        type: DataTypes.INTEGER,
      },
      sent: {
        type: DataTypes.INTEGER,
      },
      failed: {
        type: DataTypes.INTEGER,
      },
      errorMessage: {
        type: DataTypes.TEXT,
      },
      startedAt: {
        type: DataTypes.DATE,
      },
      finishedAt: {
        type: DataTypes.DATE,
      },
    },
    {
      timestamps: false,
    }
  );
}
