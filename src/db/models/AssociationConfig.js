/**
 * Modelo AssociationConfig (stub)
 * -------------------------------
 * Define la estructura esperada para la tabla AssociationConfig sin crearla ni
 * consumirla aún. Sirve como contrato de datos para futuras implementaciones de
 * sincronización de asociaciones multi-tenant.
 */

export default function AssociationConfig({ sequelize }, DataTypes) {
  // Nota: este modelo describe campos sin activar sincronización. Requiere la
  // migración correspondiente para existir en BD.
  return sequelize.define(
    "AssociationConfig",
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      hubspotCredentialId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: "Aísla las configuraciones por tenant",
      },
      objectType: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: "Objeto base de la asociación (e.g., deal)",
      },
      associationType: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: "Relación destino (e.g., deal↔contact, deal↔company)",
      },
      sapForeignKeyField: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: "Campo SAP que referencia al objeto asociado",
      },
      hubspotForeignKeyField: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: "Reservado para expansiones HubSpot→SAP",
      },
    },
    {
      timestamps: false,
      comment:
        "Configuración declarativa de asociaciones multi-tenant (pendiente de migración)",
    }
  );
}
