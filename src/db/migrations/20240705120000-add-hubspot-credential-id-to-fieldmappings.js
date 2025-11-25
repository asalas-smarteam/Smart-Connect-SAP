'use strict';

export async function up(queryInterface, Sequelize) {
  await queryInterface.addColumn('FieldMappings', 'hubspotCredentialId', {
    type: Sequelize.INTEGER,
    allowNull: true,
  });
}

export async function down(queryInterface) {
  await queryInterface.removeColumn('FieldMappings', 'hubspotCredentialId');
}
