export default function DealPipelineMapping({ sequelize }, DataTypes) {
  return sequelize.define(
    'DealPipelineMapping',
    {
      hubspotPipelineId: {
        type: DataTypes.STRING,
        allowNull: false,
        primaryKey: true
      },
      hubspotCredentialId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      sapPipelineKey: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      hubspotPipelineLabel: {
        type: DataTypes.STRING,
        allowNull: true,
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
          name: 'idx_unique_pipeline_mapping',
          unique: true,
          fields: ['hubspotCredentialId', 'sapPipelineKey'],
        },
      ],
    }
  );
}
