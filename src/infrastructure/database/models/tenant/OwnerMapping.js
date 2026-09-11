import mongoose from 'mongoose';

const { Schema } = mongoose;

export const ownerMappingSchema = new Schema(
  {
    hubspotCredentialId: {
      type: Schema.Types.ObjectId,
      ref: 'HubspotCredentials',
      required: true,
    },
    hubspotOwnerId: {
      type: String,
      required: true,
    },
    hubspotOwnerEmail: {
      type: String,
      default: null,
    },
    hubspotOwnerName: {
      type: String,
      default: null,
    },
    // Código del empleado de ventas en SAP. Es TEXTO y admite VARIOS códigos
    // separados por coma: '100,200,300'.
    //
    // En B1 la misma persona tiene un SalesPersonCode por sucursal o
    // departamento ('CENTMK - Teresa Barahona' = 113, 'QUITMK - Teresa
    // Barahona' = 758, 'JUTTMK - ...' = 864), así que la relación real es N
    // códigos de SAP -> 1 owner de HubSpot. No se modela con una fila por
    // código porque el índice uniq_hubspot_owner_mapping admite un solo
    // documento por hubspotOwnerId, y romperlo dejaría a listOwnerMappings y al
    // seed de HubSpot devolviendo la misma persona repetida.
    //
    // OJO: uniq_sap_owner_mapping_partial es sobre la cadena COMPLETA, así que
    // no impide que un mismo código aparezca dentro del CSV de dos personas.
    // Quien parsea es parseSapOwnerIds en
    // src/domain/owners/owner-directory.service.js.
    //
    // Un valor CSV NO sirve para la dirección HubSpot -> SAP: resolveDocumentSlpCode
    // lo valida con Number.isInteger y devuelve null con un warn en vez de
    // escribir '100,200,300' en el SlpCode de un documento.
    sapOwnerId: {
      type: String,
      default: null,
    },
    sapOwnerName: {
      type: String,
      default: null,
    },
    // SEGUNDA lista de codigos de SAP para la MISMA persona de HubSpot. Existe porque
    // `sapOwnerId` es un SlpCode (catalogo /SalesPersons, lo que viaja en SalesPersonCode)
    // y `DocumentsOwner` espera un EmployeeID (catalogo /EmployeesInfo): son numeraciones
    // distintas, asi que reusar `sapOwnerId` para las dos asignaria OTRA persona y SAP lo
    // aceptaria sin error.
    //
    // Solo se usa en la direccion HubSpot -> SAP. La direccion SAP -> HubSpot sigue
    // traduciendo unicamente por `sapOwnerId` (ver owner-directory.service.js): meter esta
    // segunda lista ahi haria que un mismo codigo resolviera a dos owners distintos segun
    // el catalogo del que venga, y el directorio no sabe de cual viene.
    //
    // Queda SIN indice unico a proposito, al reves que `sapOwnerId`. El lookup de
    // resolveDocumentsOwnerCode entra por `hubspotOwnerId`, asi que la unicidad no aporta
    // nada al camino de lectura, y un indice unico nuevo sobre una coleccion que ya tiene
    // datos falla al crearse si algun tenant repite el codigo.
    //
    // Igual que `sapOwnerId`, un valor CSV ('23,24') NO sirve para HubSpot -> SAP:
    // resolveDocumentsOwnerCode lo valida con Number.isInteger y omite el campo con un warn.
    sapOwnerId_2: {
      type: String,
      default: null,
    },
    active: {
      type: Boolean,
      default: true,
    },
    source: {
      type: String,
      enum: ['hubspot_seed', 'manual'],
      default: 'hubspot_seed',
    },
  },
  {
    timestamps: true,
    collection: 'OwnerMappings',
  }
);

ownerMappingSchema.index(
  { hubspotCredentialId: 1, hubspotOwnerId: 1 },
  { unique: true, name: 'uniq_hubspot_owner_mapping' }
);

ownerMappingSchema.index(
  { hubspotCredentialId: 1, sapOwnerId: 1 },
  {
    unique: true,
    name: 'uniq_sap_owner_mapping_partial',
    partialFilterExpression: { sapOwnerId: { $type: 'string' } },
  }
);

export function createOwnerMappingModel(connection) {
  return (
    connection.models.OwnerMapping
    || connection.model('OwnerMapping', ownerMappingSchema)
  );
}
