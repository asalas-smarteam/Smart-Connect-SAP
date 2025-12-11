'use strict';

export async function up(queryInterface, Sequelize) {
  await queryInterface.addColumn('ClientConfigs', 'associationFetchEnabled', {
    type: Sequelize.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  });

  await queryInterface.addColumn('ClientConfigs', 'associationFetchConfig', {
    type: Sequelize.JSON,
    allowNull: true,
    comment: `
    Arreglo de configuraciones de extracción por objeto:

    [
      {
        "objectType": "company",
        "associationFetchType": "api",      // 'api' | 'sp'
        "associationFetchConfig": {
            "url": "https://api.test.com",
            "method": "GET"
        }
      },
      {
        "objectType": "product",
        "associationFetchType": "sp",       // 'api' | 'sp'
        "associationFetchConfig": {
            "storedProcedure": "sp_get_associations"
        }
      }
    ]
  `,
  });
}

export async function down(queryInterface) {
  await queryInterface.removeColumn('ClientConfigs', 'associationFetchConfig');
  await queryInterface.removeColumn('ClientConfigs', 'associationFetchEnabled');
}
