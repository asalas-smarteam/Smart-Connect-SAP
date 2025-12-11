/**
 * Migration stub: AssociationConfig
 * ---------------------------------
 * Tabla pensada para configurar asociaciones multi-tenant entre objetos de
 * HubSpot y SAP. No crea la tabla aún; documenta la estructura y dependencia
 * de hubspotCredentialId para aislar tenants.
 *
 * Campos propuestos:
 * - id
 * - hubspotCredentialId
 * - objectType
 * - associationType
 * - sapForeignKeyField
 * - hubspotForeignKeyField (reservado para expansiones)
 */

export async function up(/* queryInterface, Sequelize */) {
  // TODO: implementar creación de la tabla AssociationConfig con índices por
  // hubspotCredentialId y objectType para un acceso eficiente.
}

export async function down(/* queryInterface */) {
  // TODO: implementar rollback eliminando la tabla AssociationConfig.
}
