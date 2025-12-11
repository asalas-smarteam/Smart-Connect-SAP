'use strict';

export async function up(queryInterface, Sequelize) {
  await queryInterface.addColumn('FieldMappings', 'isActive', {
    type: Sequelize.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  });
}

export async function down(queryInterface) {
  await queryInterface.removeColumn('FieldMappings', 'isActive');
}
