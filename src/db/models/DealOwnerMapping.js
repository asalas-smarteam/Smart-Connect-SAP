export default function DealOwnerMapping({ sequelize }, DataTypes) {
  return sequelize.define(
    'DealOwnerMapping',
    {
      id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      hubspotCredentialId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      sapOwnerId: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      hubspotOwnerId: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      displayName: {
        type: DataTypes.STRING,
        allowNull: true,
      },
    },
    {
      timestamps: false,
      indexes: [
        {
          name: 'uniq_deal_owner_mapping',
          unique: true,
          fields: ['hubspotCredentialId', 'sapOwnerId'],
        },
      ],
    }
  );
}
