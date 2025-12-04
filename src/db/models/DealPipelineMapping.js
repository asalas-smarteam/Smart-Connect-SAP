export default function DealPipelineMapping({ sequelize }, DataTypes) {
  return sequelize.define(
    'DealPipelineMapping',
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
      sapPipelineKey: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      hubspotPipelineId: {
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
          unique: true,
          fields: ['hubspotCredentialId', 'sapPipelineKey'],
        },
      ],
    }
  );
}
