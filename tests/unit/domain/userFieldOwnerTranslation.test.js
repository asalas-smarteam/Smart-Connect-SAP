import { jest } from '@jest/globals';
import { buildMappedProperties } from '../../../src/application/services/mappingValueResolver.service.js';
import { createOwnerDirectory } from '../../../src/domain/owners/owner-directory.service.js';

// El caso real del tenant printer: el MISMO SalesPersonCode alimenta una
// propiedad de tipo OWNER (que solo acepta el ownerId del portal) y un slpcode
// suelto (que debe llegar tal cual). Por eso la marca es por mapeo.
const SAP_TO_HS_MAPPINGS = [
  {
    sourceField: 'SalesPersonCode',
    targetField: 'propietario_del_contacto_resma_tmk',
    userField: true,
  },
  { sourceField: 'SalesPersonCode', targetField: 'slpcode' },
  { sourceField: 'CardName', targetField: 'name' },
];

const OWNER_DIRECTORY = createOwnerDirectory([
  // CSV: la misma persona tiene un SalesPersonCode por sucursal en B1.
  { sapOwnerId: '600,601,862', hubspotOwnerId: '123123123', active: true },
]);

describe('buildMappedProperties — campos de usuario (SAP -> HubSpot)', () => {
  it('traduce el campo marcado y deja intacto el que no lo está', () => {
    const properties = buildMappedProperties({
      input: { SalesPersonCode: 600, CardName: 'ACME' },
      mappings: SAP_TO_HS_MAPPINGS,
      ownerDirectory: OWNER_DIRECTORY,
    });

    expect(properties.propietario_del_contacto_resma_tmk).toBe('123123123');
    expect(properties.slpcode).toBe(600);
    expect(properties.name).toBe('ACME');
  });

  // Es el bug que originó todo esto: mandar el 600 hacía que HubSpot rechazara
  // el registro COMPLETO con 400, no solo esa propiedad.
  it('omite la propiedad cuando el código de SAP no está homologado', () => {
    const onUnresolvedOwner = jest.fn();
    const properties = buildMappedProperties({
      input: { SalesPersonCode: 777, CardName: 'ACME' },
      mappings: SAP_TO_HS_MAPPINGS,
      ownerDirectory: OWNER_DIRECTORY,
      onUnresolvedOwner,
    });

    expect(properties).not.toHaveProperty('propietario_del_contacto_resma_tmk');
    // El resto del registro sigue viajando: un vendedor sin homologar no puede
    // costar el sync de la empresa entera.
    expect(properties.name).toBe('ACME');
    expect(properties.slpcode).toBe(777);
    expect(onUnresolvedOwner).toHaveBeenCalledWith({
      sourceField: 'SalesPersonCode',
      targetField: 'propietario_del_contacto_resma_tmk',
      value: 777,
    });
  });

  it('sin directorio no traduce nada (conducta previa y tenants S/4)', () => {
    const properties = buildMappedProperties({
      input: { SalesPersonCode: 600, CardName: 'ACME' },
      mappings: SAP_TO_HS_MAPPINGS,
    });

    expect(properties.propietario_del_contacto_resma_tmk).toBe(600);
  });

  it('un SalesPersonCode vacío sigue limpiando el propietario en HubSpot', () => {
    const properties = buildMappedProperties({
      input: { SalesPersonCode: '', CardName: 'ACME' },
      mappings: SAP_TO_HS_MAPPINGS,
      ownerDirectory: OWNER_DIRECTORY,
    });

    expect(properties.propietario_del_contacto_resma_tmk).toBe('');
  });

  // Con la cadena de fallback activa, un campo de usuario omitido debe dejar su
  // turno al siguiente mapeo del mismo targetField en vez de cortar la cadena.
  it('respeta la cadena de fallback sobre el mismo targetField', () => {
    const properties = buildMappedProperties({
      input: { SalesPersonCode: 777, U_VENDEDOR_ALT: 600 },
      mappings: [
        {
          sourceField: 'SalesPersonCode',
          targetField: 'propietario_del_contacto_resma_tmk',
          userField: true,
        },
        {
          sourceField: 'U_VENDEDOR_ALT',
          targetField: 'propietario_del_contacto_resma_tmk',
          userField: true,
        },
      ],
      fallbackConfig: { enabled: true },
      ownerDirectory: OWNER_DIRECTORY,
    });

    expect(properties.propietario_del_contacto_resma_tmk).toBe('123123123');
  });

  // El formato CSV de sapOwnerId: cualquiera de los códigos de la persona
  // resuelve al mismo owner de HubSpot.
  it('traduce cualquier código del CSV al mismo owner', () => {
    for (const code of [600, 601, 862]) {
      const properties = buildMappedProperties({
        input: { SalesPersonCode: code },
        mappings: SAP_TO_HS_MAPPINGS,
        ownerDirectory: OWNER_DIRECTORY,
      });

      expect(properties.propietario_del_contacto_resma_tmk).toBe('123123123');
    }
  });
});
