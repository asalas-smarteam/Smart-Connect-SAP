# Direcciones fiscal y de entrega del BusinessPartner por configuración (`requireAddress.addresses`)

Rama `feat/amc-address-config`. Reemplaza el diseño por FieldMapping con selector, que sigue en la rama `feat/amc-bpaddress-fieldmapping` como alternativa y está descrito en `2026-10-13-bpaddress-selector-fieldmapping-design.md`.

## Pedido

Tenant AMC (SAP B1 por Service Layer): llevar la calle de la dirección de entrega y de la fiscal del BusinessPartner a propiedades de la company y del contact en HubSpot: `direccion_entrega` y `direccion_fiscal` (la ciudad y el departamento se dejaron fuera de la config de AMC tras la reunión del 2026-10-14, aunque el código acepta cualquier campo). Además, `pais`, `departamento_entrega` y `departamento_fiscal` deben ser desplegables que mantiene la tarea `DROPDOWN_OPTIONS`. Solo SAP -> HubSpot; el sentido inverso no cambia.

## Por qué una configuración y no un FieldMapping

Un FieldMapping copia un campo de SAP a una propiedad. La dirección es una fila de una lista (`BPAddresses`) que hay que elegir por su tipo, así que no cabe. Alejandro describió en su audio un objeto en `Configurations` que dice a qué propiedad va cada dirección, y `requireAddress` ya existía como la compuerta de esta función. El diseño por selector sí funcionaba, pero obligaba a tocar el resolvedor de FieldMapping y a proteger el sentido HubSpot -> SAP de las claves con selector; este no toca ninguno de los dos.

## Forma de la configuración

```json
{
  "key": "requireAddress",
  "value": {
    "required": true,
    "addresses": [
      { "AddressType": "bo_ShipTo", "sourceField": "Street", "targetField": "direccion_entrega" },
      { "AddressType": "bo_BillTo", "sourceField": "Street", "targetField": "direccion_fiscal" }
    ]
  }
}
```

`addresses` es un array de reglas dentro de `value`, no una clave de `Configurations`. **Una regla es una propiedad de HubSpot**: `AddressType` y/o `AddressName` eligen la fila de `BPAddresses`, `sourceField` es el campo de esa fila y `targetField` la propiedad. Varias reglas pueden compartir la fila (calle y ciudad de la misma entrega son dos reglas). Si dos reglas escriben el mismo `targetField` se queda la primera y la otra se reporta (`DUPLICATE_PROPERTY`). La forma `byName` anterior (objeto con `fields`) se eliminó: no había nada desplegado, así que una clave `byName` en el documento simplemente se ignora. Es una decisión tomada con el product owner después de la reunión con Alejandro; el nombre `byName` de `businessPartnerCreation.addresses.byName` es otra config (HubSpot -> SAP) y no se toca.

## Piezas

- **Dominio** (`address-sync.service.js`, `address-sync.constants.js`): `normalizeAddressSyncConfig` normaliza la entrada y reporta lo que descarta (regla inválida, sin criterio, `sourceField` o `targetField` inválido, propiedad repetida). `readSapAddressesToProperties` elige la fila por `AddressType` y/o `AddressName`, la primera que coincide y nunca por posición, y devuelve solo valores no vacíos.
- **Lectura de la config** (`AddressSyncConfigRepository`): devuelve `{ required, addresses }`, registra los problemas una vez, nunca lanza, y en un flavor distinto de B1 deja `addresses` vacío.
- **`$select`** (`bp-addresses-select.service.js`): agrega `BPAddresses` solo para company y contact y solo si la función está encendida.
- **Enriquecedor** (`AddressSyncEnrichmentAdapter`): corre después de `mapRecords` y antes del envío, con el mismo contrato que los otros enriquecedores. Escribe sobre las propiedades ya mapeadas, así que gana la dirección de SAP. No lanza nunca.
- **Caso de uso** (`SyncSapConfigToHubspot`): lee la config una vez por corrida, arma el `$select` y emite el warning `ADDRESS_SYNC_MISCONFIGURED` si `required` es `true` y no hay nada válido para escribir. El warning viejo `ADDRESS_SYNC_NOT_IMPLEMENTED` desapareció.

## Registros que ya existen en HubSpot

Para un registro que ya existe, SAP solo escribe las propiedades listadas en `hubspotUpdateFields` (`{ company: [...], contact: [...] }`); sin ellas, la actualización manda `idsap` e `internalcode` y un cambio de dirección ni siquiera la dispara. Con ellas, el sync FULL de AMC pisa en cada corrida lo que se corrija a mano. No existe un modo "llenar solo si está vacío". Es una decisión de producto pendiente.

## Hallazgos

- `COMPANY_ADD_FIELDS_URL_SAP=ContactEmployees,BPAddresses` ya está en `.env` y `.env.example`: en company el `$select` ya trae `BPAddresses`, y `buildServiceLayerUrl` no lo duplica. Para contact no hay variable equivalente.
- Ningún otro tenant tiene `requireAddress: true` (Printer lo tiene en `false`; AMC no lo tenía), así que activarlo no cambia a nadie más.
- El sync de contactos de AMC está inactivo (`active: false`): las propiedades de contact no se llenan hasta activarlo.

## Pruebas

Cada pieza tiene pruebas unitarias, y `addressSyncJourney.test.js` recorre company y contact de punta a punta con solo Mongo y SAP simulados: tenants sin config, `required: false`, requerido sin `addresses`, un documento `byName` heredado, la forma de AMC (solo calle), S/4, registros nuevos y existentes con y sin `hubspotUpdateFields`. Una verificación por mutación (deshabilitar `Object.assign` del enriquecedor y el log de config ilegible) hizo fallar 17 de 54 pruebas con la forma anterior; con la forma por reglas, 26 de 62 en el enriquecedor y el recorrido.

## Despliegue y pasos manuales

El orden importa: primero el código, después la config en Mongo.

1. Desplegar el código.
2. Recrear `pais`, `departamento_entrega` y `departamento_fiscal` como desplegables en company y contact (antes probar con una propiedad desechable si un nombre interno borrado se puede reutilizar).
3. Cargar en Mongo `requireAddress`, las fuentes de `dropdownOptionsSync` (`/Countries` con `["Country"]` y `/States` con filtro `Country eq 'GT'`) y `hubspotUpdateFields`.
4. Al final, modificar el script del workflow de HubSpot para que lea `direccion_entrega` y `direccion_fiscal` de company y contact.

Marcha atrás: poner `required: false` (o borrar la clave) apaga la función; el `$select` y las escrituras vuelven a ser las de antes.

## Preguntas abiertas para Alejandro

1. **Desplegables sin FieldMapping (T6).** La tarea empareja cada lista con su propiedad por `FieldMapping.sourceField` ↔ `source.fields`. Sin filas de FieldMapping para los `departamento_*`, hay que elegir: que cada fuente de `dropdownOptionsSync` declare su propiedad destino (campo opcional, la propuesta) o que la tarea lea `requireAddress`.
2. `hubspotUpdateFields`: confirmar que SAP pise la dirección en cada corrida FULL.
