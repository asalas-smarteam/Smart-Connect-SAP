export default function DealStageMapping({ sequelize }, DataTypes) {
  return sequelize.define(
    'DealStageMapping',
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
      sapStageKey: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      hubspotStageId: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      hubspotStageLabel: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      hubspotPipelineId: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      timestamps: true,
      indexes: [
        {
          unique: true,
          fields: ['hubspotCredentialId', 'sapStageKey', 'hubspotPipelineId'],
        },
      ],
    }
  );
}
