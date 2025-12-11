export default function AssociationRegistry({ sequelize }, DataTypes) {
  return sequelize.define(
    'AssociationRegistry',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      hubspotCredentialId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      baseObjectType: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      baseSapId: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      baseHubspotId: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      associatedObjectType: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      associatedSapId: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      associatedHubspotId: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      quantity: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      timestamps: false,
    },
  );
}
