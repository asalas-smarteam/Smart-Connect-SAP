module.exports = function HubspotCredentials({ sequelize }, DataTypes) {
  return sequelize.define(
    'HubspotCredentials',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      clientConfigId: {
        type: DataTypes.INTEGER,
      },
      portalId: {
        type: DataTypes.STRING,
      },
      accessToken: {
        type: DataTypes.TEXT,
      },
      refreshToken: {
        type: DataTypes.TEXT,
      },
      expiresAt: {
        type: DataTypes.DATE,
      },
      scope: {
        type: DataTypes.TEXT,
      },
    },
    {
      timestamps: false,
    }
  );
};
