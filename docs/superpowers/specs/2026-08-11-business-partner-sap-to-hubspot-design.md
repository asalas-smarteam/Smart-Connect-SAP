# BusinessPartner de SAP B1 hacia HubSpot: `Properties1..64` y compuerta de direcciones

Fecha: 2026-08-11
Dirección: **SAP → HubSpot** (tarea programada de `clientConfig`). Flavor: **solo B1 (`SERVICE_LAYER`)**.
Spec hermano: `2026-08-11-business-partner-full-creation-design.md` (dirección HubSpot → SAP). **Léelo primero**: este spec reutiliza dos servicios que aquel implementa.

## Problema

La tarea programada `SyncSapConfigToHubspot` (`src/application/use-cases/SyncSapConfigToHubspot.js`) trae BusinessPartners de SAP y los escribe en HubSpot como companies o contacts. Un cliente de SAP Business One usa los 64 campos booleanos `Properties1` .. `Properties64` del BusinessPartner para marcar a qué agencias corresponde cada cliente, y necesita que esas marcas se vean seleccionadas en una propiedad multi-select de HubSpot. Hoy eso es imposible, por tres razones apiladas:

1. **`FieldMapping` no puede expresar N→1.** Son 64 campos de SAP alimentando **una** propiedad de HubSpot. El índice único del modelo es `{hubspotCredentialId, objectType, sourceContext, sourceField}` (`src/infrastructure/database/models/tenant/FieldMapping.js:57-65`) y el mapeo es una copia escalar de un valor (`buildMappedProperties`, `src/application/services/mappingValueResolver.service.js:95-120`). No existe ninguna capa de transformación de valores en el repositorio: `grep` de `valueMap`, `converter`, `transformValue` devuelve cero.
2. **Los 64 campos nunca llegan al `$select`.** El `$select` de B1 se arma exclusivamente desde los `sourceField` de los mappings activos más una variable de entorno (`sanitizeSelectFields` y `getAdditionalFieldsByObjectType`, `src/infrastructure/sap/serviceLayerUrlBuilder.js:21-64`). Sin filas de mapping para `Properties1`..`Properties64` —que no tendrían sentido, ver punto 1— SAP jamás devuelve esos campos.
3. **Un array no se puede escribir.** HubSpot serializa un multi-select como string unido por `;`, y `isWritableValue` (`src/application/services/hubspotPropertyPayload.service.js:8-19`) **descarta cualquier array u objeto sin error ni log**, así que un valor multi-valuado enviado como array desaparece en silencio.

Aparte, el mismo cliente tiene direcciones múltiples en SAP (`BPAddresses`), y traerlas a HubSpot en esta dirección **no tiene destino válido**: una company de HubSpot tiene un solo juego de propiedades de dirección, y las propiedades que este tenant usa (`Address`, `Address2`, zip) viven en el **deal**, no en la company ni en el contact. Ver "Fuera de alcance".

## Objetivo

Que las banderas `PropertiesN` de un BusinessPartner de SAP B1 lleguen a una propiedad multi-select de HubSpot, en ambos tipos de objeto (company y contact), sin que ningún tenant que no configure nada cambie de conducta. Y dejar declarada una compuerta explícita (`requireAddress`) que documenta que las direcciones no se sincronizan en esta dirección todavía.

## Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Mecanismo para `PropertiesN` | Enricher (`SapRecordEnricherPort`), **nunca** `FieldMapping` | Es N campos de SAP → 1 propiedad de HubSpot; el índice único de `FieldMapping` es por `sourceField` y el mapeo es copia escalar. Ya hay dos enrichers en producción con este patrón (`S4ContactEnrichmentAdapter`, `WarehouseStockEnrichmentAdapter`) |
| Cómo llegan los 64 campos al `$select` | Mappings sintéticos con `targetField: null`, copiando `withDynamicDescriptionSelectFields` (`src/domain/sync/dynamic-description.service.js:288-315`) | Es el precedente exacto y ya probado del repositorio para "un campo que el `$select` necesita pero que no tiene fila de mapping propia". No contamina el mapeo porque `mapRecords` vuelve a consultar los mappings por su cuenta y no recibe los sintéticos |
| Dónde escribe el enricher | Directo en `record.properties[hubspotProperty]` | El enricher de almacenes escribe en `record.rawSapData` porque `product.handler.js` tiene un paso que lo mueve a properties; para company/contact **no existe** ese paso, y `ProcessCrmObjectBatches`/`SendMappedItemsToHubspot` leen `item.properties`. Escribir ahí es el camino corto y correcto |
| Formato del valor | String unido por `;` | `isWritableValue` descarta arrays en silencio (`hubspotPropertyPayload.service.js:13-19`). Se reutiliza `HUBSPOT_OPTION_VALUE_SEPARATOR` de `src/domain/sync/dropdown-options.constants.js:54` en vez de un literal nuevo |
| Ninguna `PropertiesN` en `tYES` | Se escribe `''`, que **deselecciona todo** en HubSpot | Confirmado con el usuario: esto es parte de una homologación de datos donde **SAP es la fuente de la verdad**. Deseleccionar en SAP debe deseleccionar en HubSpot; sincronizar a medias dejaría marcas fantasma que nadie puede explicar. `sanitizeProperties` descarta `null`/`undefined` pero **conserva `''`** (`hubspotPropertyPayload.service.js:27-30`), así que el borrado efectivamente viaja |
| Distinción vacío vs apagado | `readSapPropertiesFlags` devuelve `null` cuando la strategy está apagada y `''` cuando está activa sin ninguna seleccionada; el enricher solo escribe cuando **no** es `null` | Un tenant sin la config no debe recibir escrituras de esta propiedad; un tenant con la config y sin marcas sí debe recibir el borrado. Son dos casos distintos y el tipo de retorno los separa |
| Tipos de objeto cubiertos | `company` y `contact` | Un BusinessPartner puede ser jurídico (→ company) o persona (→ contact), y las `PropertiesN` existen en ambos casos porque son campos de la cabecera del BP |
| Flavor | Solo B1; en S/4 el enricher es no-op | `Properties1..64` son campos de `BusinessPartners` de B1; `A_BusinessPartner` de S/4 no los tiene |
| Reutilización desde el spec hermano | `readSapPropertiesFlags` y `listSapPropertiesFieldNames` **ya quedan implementados y probados** en el spec HubSpot→SAP | Se diseñaron bidireccionales a propósito. Este spec no los reescribe: los consume. La clave de config `propertiesFlags` también es compartida |
| Errores del enricher | Nunca lanza; loguea y sigue | Igual que los dos enrichers existentes. Una propiedad de HubSpot mal configurada no debe tumbar la sincronización completa de un tenant |
| Direcciones SAP→HubSpot | No se implementan. Config nueva `requireAddress` con `{ required: false }` | Decisión del usuario por tiempo. En `true` hoy se registra un warning y sigue; el destino real (custom object de HubSpot) es un spec aparte |
| Ubicación de `requireAddress` | Clave propia, **no** dentro de `businessPartnerCreation` | `businessPartnerCreation` está definida en el spec hermano como HubSpot→SAP únicamente. Mezclar direcciones en una sola clave haría ambigua su lectura |
| Reglas jurídico/persona | **No requieren código nuevo** | Lo resuelven `clientConfig.objectType` más los filtros sembrados en `src/infrastructure/database/seeds/defaultSapFilters.seed.js` (`CompanyPrivate eq 'I'` para contact, `eq 'C'` para company) |

## Alternativas descartadas

| Alternativa | Por qué se descartó |
|---|---|
| 64 filas de `FieldMapping`, una por `PropertiesN` | Cada fila apuntaría a la misma propiedad de HubSpot, y el índice único es `{credential, objectType, sourceContext, sourceField}` sin incluir `targetField`: las 64 filas serían legales pero la última en resolverse ganaría, y el resultado sería una sola marca en vez de la lista. Además obligaría al tenant a mantener 64 filas a mano |
| Meter `Properties1..64` en `COMPANY_ADD_FIELDS_URL_SAP` | Es una **variable de entorno global**, no una config por tenant: agregaría los 64 campos al `$select` de todos los tenants del despliegue, incluidos los que no usan la funcionalidad. Y no existe la variable equivalente para `contact` (el mapa es `company`/`product`/`deal`, `serviceLayerUrlBuilder.js:43-47`) |
| Agregar una columna de transformación a `FieldMapping` | Resolvería este caso, pero introduce una capa de transformación de valores en un modelo que hoy no la tiene y que leen todos los flujos y todos los tenants. Superficie de regresión enorme para el caso de un cliente |
| Escribir el multi-select como array | `isWritableValue` lo descarta **sin error ni log**; el síntoma sería "la propiedad simplemente no se actualiza", que es exactamente el tipo de fallo que cuesta días encontrar |
| Omitir el campo cuando no hay ninguna `PropertiesN` en `tYES` | Dejaría marcas fantasma en HubSpot que nadie podría explicar ni rastrear, y rompe la premisa de homologación donde SAP es la fuente de la verdad |
| Sembrar desde el código las 64 opciones de la propiedad multi-select | Las etiquetas (Central, Quetzaltenango, …) no viven en ningún sitio que el código pueda leer hoy. Existe la maquinaria (`HubspotPropertyAdapter.updatePropertyOptions`, `mergePropertyOptions`), pero sin fuente de datos sería inventar |
| Validar al inicio de la corrida que la propiedad existe y es `enumeration` | Agrega una llamada a la API de propiedades de HubSpot por corrida para proteger contra un error de configuración de una sola vez. Se prefiere el warning por registro, que es gratis |
| Traer `BPAddresses` con un mapping punteado (`BPAddresses.Street`) | Tres bloqueos: (a) el resolvedor devuelve **siempre `BPAddresses[0]`**, fijado por el test `tests/unit/mappingService.test.js:5-25`; (b) `mappingCollectionPriority` no puede mandar la calle de factura a una propiedad y la de entrega a otra, porque dos mappings con `targetField` distinto resolverían por el mismo orden de prioridad y devolverían la misma fila; (c) en B1 un `sourceField` con punto **nunca llega al `$select`** porque `SAP_FIELD_PATTERN` (`serviceLayerUrlBuilder.js:1`) no admite el punto y lo descarta sin warning |
| Extender `mappingCollectionPriority` para que un mapping declare a qué fila apunta | Toca el resolvedor de mappings que usan todos los tenants y todos los flujos, en ambas direcciones. Riesgo alto para un caso puntual |
| Volcar las direcciones en las propiedades de dirección de la company | Este tenant tiene `Address`/`Address2`/zip en el **deal**, no en la company. No hay dónde ponerlas sin inventar propiedades que el cliente no pidió |

## Configuración

### `propertiesFlags` — compartida con el spec hermano

**No es nueva en este spec.** La define, normaliza y siembra el spec HubSpot→SAP; aquí solo se consume la dirección de lectura.

```js
{
  key: 'propertiesFlags',
  userUpdated: 'admin',
  value: {
    strategy: 'numberedMultiSelect',   // 'none' (default) = apagado
    hubspotProperty: 'groupname',      // propiedad multi-select destino en HubSpot
    min: 1,
    max: 64,
    trueValue: 'tYES',
  },
}
```

Se lee con `BusinessPartnerCreationConfigRepository.getPropertiesFlagsConfig({ tenantModels })`, que ya existe tras el spec hermano y nunca lanza.

### `requireAddress` — nueva

```js
{ key: 'requireAddress', userUpdated: 'admin', value: { required: false } }
```

En `false` (default, y lo que se siembra) no se sincroniza ninguna dirección SAP→HubSpot. En `true` se registra el warning `ADDRESS_SYNC_NOT_IMPLEMENTED` en el `SyncLog` y la corrida sigue normalmente. Se documenta en `configuration_examples.md`.

## Arquitectura

### Pieza A — inyección al `$select`

Función pura nueva en `src/domain/business-partners/sap-properties-flags.service.js` (el archivo que crea el spec hermano):

```js
withPropertiesFlagsSelectFields(mappings, propertiesFlagsConfig, { objectType, sourceContext })
```

Copia el molde de `withDynamicDescriptionSelectFields` (`src/domain/sync/dynamic-description.service.js:288-315`):

- Si la strategy está apagada, devuelve `mappings` sin tocar (misma referencia).
- Si está activa, calcula los nombres con `listSapPropertiesFieldNames(config)` (ya implementado en el spec hermano), descarta los que ya estén cubiertos por un mapping con `includeInServiceLayerSelect !== false`, y agrega el resto como mappings sintéticos:

```js
{
  sourceField: 'Properties55',
  targetField: null,          // solo para el $select, nunca escribe propiedades
  objectType,
  sourceContext,
  includeInServiceLayerSelect: true,
  isActive: true,
}
```

Se enchufa en `fetchOptions.mappings` de `SyncSapConfigToHubspot.js:88-94`, envolviendo la llamada que ya está ahí:

```js
      const fetchOptions = {
        ...buildSapFetchOptions(activeConfig, this.dateProvider),
        mappings: withPropertiesFlagsSelectFields(
          withDynamicDescriptionSelectFields(sapMappings, dynamicDescriptionConfig, {
            objectType: activeConfig.objectType,
            sourceContext,
          }),
          propertiesFlagsConfig,
          { objectType: activeConfig.objectType, sourceContext }
        ),
      };
```

**Por qué los sintéticos no contaminan el mapeo:** `fetchOptions.mappings` solo se usa para armar el request a SAP. `mapRecords` (`SyncSapConfigToHubspot.js:130-135`) no recibe esa lista — vuelve a consultar los mappings desde Mongo por su cuenta. Verificado en `MappingSyncRepository.mapRecords`, que llama a `findMappings` internamente.

### Pieza B — el enricher

`src/infrastructure/sap/customers/PropertiesFlagsEnrichmentAdapter.js`, cumpliendo `SapRecordEnricherPort` (`methods: ['enrich']`), con la misma forma que `WarehouseStockEnrichmentAdapter`:

```
enrich({ mappedRecords, objectType, tenantModels }) -> void
```

1. Devuelve inmediatamente si `objectType` no es `company` ni `contact`, o si falta `tenantModels`.
2. Lee `propertiesFlags` una sola vez por corrida (no por registro) con `BusinessPartnerCreationConfigRepository.getPropertiesFlagsConfig({ tenantModels })`, inyectado por constructor como `configRepository` — igual que `WarehouseStockEnrichmentAdapter` recibe su `WarehouseStockConfigRepository`.
3. Devuelve si `strategy` es `none` o si falta `hubspotProperty`.
4. Devuelve si el flavor del tenant no es B1, resuelto con `resolveSapFlavor({ tenantModels })` de `src/infrastructure/config/SapFlavorConfigRepository.js` — la misma función que usa el guard de flavor del spec hermano.
5. Por registro: `readSapPropertiesFlags({ sapRecord: record.rawSapData, config })`. Si el resultado **no** es `null`, escribe `record.properties[config.hubspotProperty] = resultado` — incluido el string vacío, que deselecciona todo.
6. Nunca lanza: cualquier error se loguea y la corrida sigue.

Se invoca en `SyncSapConfigToHubspot.js` después de `warehouseStockEnricher` (líneas 162-168), con el mismo guard `if (this.propertiesFlagsEnricher)`, y se cablea en `src/composition/sap-sync.composition.js` junto a los otros dos enrichers (líneas 69-97), pasando por `assertPort(..., SapRecordEnricherPort)`.

**Orden importante:** corre después de `mapRecords` porque necesita `rawSapData` (que se adjunta en `SyncSapConfigToHubspot.js:136-139` por índice posicional), y antes de `sendMappedRecords` para que `sanitizeProperties` vea el valor ya resuelto.

### Compuerta `requireAddress`

No hay pieza de código de direcciones. Solo:
- Un repositorio de config que lee la clave y la normaliza a `{ required: boolean }`, sin lanzar.
- Una comprobación en `SyncSapConfigToHubspot` que, cuando `required` es `true` y el `objectType` es `company` o `contact`, registra el warning `ADDRESS_SYNC_NOT_IMPLEMENTED` una vez por corrida.
- La semilla en `tenantProvisioning.js` y la entrada en `configuration_examples.md`.

## Lo que ya funciona y no se toca

**Regla del usuario: "si el BP es una empresa, es una company en HubSpot y sus ContactEmployees son contactos asociados a la empresa".** Esto ya existe completo, en dos caminos que se eligen por `clientConfig.hubspotBatchSize` (`src/application/use-cases/SendMappedItemsToHubspot.js:136-170`):

- **Secuencial:** `HandleHubspotAssociations.syncCompanyContacts` (`src/application/use-cases/HandleHubspotAssociations.js:214-407`). Lee `rawSapData._s4Contacts ?? rawSapData.ContactEmployees` (líneas 237-239), mapea con contexto `contactEmployee`, y asocia par por par con `PUT /crm/v4/objects/company/{id}/associations/contact/{id}` (vía `associationService`, hasta `hubspotClient.js:394-404`).
- **Por lotes:** `SyncCompanyContactsInBatches` (`src/application/use-cases/SyncCompanyContactsInBatches.js:119-324`). Mismo dato, pero con un barrido `listAllObjects` indexado en memoria, `batch/create` con bisección de conflictos 409, dedup por claims y `POST /crm/v4/associations/company/contact/batch/associate/default` (`hubspotClient.js:361-374`).

**Regla del usuario: "el cómo se define si es BP empresa o BP persona va por la tarea de clientConfig y por los filtros de la consulta al API de SAP".** Confirmado: `clientConfig.objectType` selecciona el handler de HubSpot por lookup en un mapa (`src/composition/hubspot-sync.composition.js:102-108`) y los filtros sembrados en `src/infrastructure/database/seeds/defaultSapFilters.seed.js` separan `CompanyPrivate eq 'I'` (persona → contact) de `eq 'C'` (jurídica → company). No hace falta ninguna strategy nueva para esto, y por eso el spec hermano eliminó la clave `businessPartnerShape` que se había considerado.

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| `propertiesFlags` ausente o `strategy: 'none'` | El enricher no escribe nada y la inyección al `$select` devuelve los mappings intactos. Conducta idéntica a hoy |
| `hubspotProperty` vacío en la config | El enricher no hace nada + warning una vez por corrida |
| Tenant con flavor S/4 | El enricher es no-op + warning una vez por corrida |
| `record.rawSapData` es `null` | Ese registro se salta; los demás siguen |
| Falla la lectura de la config | Se usan los defaults (apagado); nunca lanza |
| La propiedad de HubSpot no existe o no es `enumeration` | HubSpot rechaza ese registro; el error se recoge por el manejo de errores por lote que ya existe. **Prerequisito documentado:** la propiedad debe existir de antemano con sus opciones numeradas |
| Un valor `PropertiesN` distinto de `trueValue` | Se trata como no seleccionado, sin warning (es el caso normal: `tNO`) |
| `requireAddress.required === true` | Warning `ADDRESS_SYNC_NOT_IMPLEMENTED` una vez por corrida; la corrida sigue |

## Prerequisitos fuera del código

La propiedad multi-select de HubSpot debe existir **antes** de activar la config, con sus opciones cuyos valores internos son los números del rango (`1`, `2`, … `64`). Se crea a mano o con el flujo `SyncDropdownOptionsToHubspot` que ya existe. Este spec no la crea.

## Pruebas

Todo lo nuevo es dominio puro más un adapter con dependencias inyectadas, así que se prueba unitariamente. Jest necesita `NODE_OPTIONS=--experimental-vm-modules` en este proyecto.

1. **Guardia de regresión:** con `propertiesFlags` ausente, `withPropertiesFlagsSelectFields` devuelve la **misma referencia** de mappings y el enricher no escribe ninguna propiedad.
2. `withPropertiesFlagsSelectFields`: inyecta los 64 nombres; deduplica contra un mapping que ya declare `Properties5`; respeta un rango personalizado; no cuenta como cubierto un mapping con `includeInServiceLayerSelect: false`; los sintéticos llevan `targetField: null`.
3. Enricher: escribe `'1;3;64'` a partir de las banderas de SAP; escribe `''` cuando ninguna está en `tYES` (**el caso de deselección, el más importante**); no escribe nada cuando la strategy está apagada; se salta `objectType: 'product'` y `'deal'`; se salta S/4; sobrevive a `rawSapData: null`; no lanza cuando la lectura de config falla.
4. Composición: el adapter cumple `SapRecordEnricherPort`.
5. `requireAddress`: default `false`; `true` produce el warning y no aborta.

## Archivos afectados

### Modificados

| Archivo | Qué cambia |
|---|---|
| `src/domain/business-partners/sap-properties-flags.service.js` | Agregar `withPropertiesFlagsSelectFields` (el archivo lo crea el spec hermano) |
| `src/application/use-cases/SyncSapConfigToHubspot.js:88-94` | Envolver `fetchOptions.mappings` con la inyección nueva |
| `src/application/use-cases/SyncSapConfigToHubspot.js:162-168` | Invocar `propertiesFlagsEnricher` después de `warehouseStockEnricher`; agregarlo al constructor |
| `src/application/use-cases/SyncSapConfigToHubspot.js` | Comprobación de `requireAddress` con el warning una vez por corrida |
| `src/composition/sap-sync.composition.js:69-97` | Cablear el enricher con `assertPort` |
| `src/infrastructure/tenants/tenantProvisioning.js:83-158` | Sembrar `requireAddress` con `{ required: false }` |
| `configuration_examples.md` | Documentar `requireAddress` |

### Nuevos

- `src/infrastructure/sap/customers/PropertiesFlagsEnrichmentAdapter.js`
- `src/infrastructure/config/AddressSyncConfigRepository.js`
- `tests/unit/domain/propertiesFlagsSelectFields.test.js`
- `tests/unit/infrastructure/propertiesFlagsEnrichmentAdapter.test.js`
- `tests/unit/infrastructure/addressSyncConfigRepository.test.js`

## Fuera de alcance

### Direcciones SAP → HubSpot (spec futuro: custom object)

`requireAddress` queda en `false` y las direcciones no viajan. **El destino correcto no es la company ni el contact**, porque SAP tiene N direcciones y HubSpot un solo juego de propiedades de dirección por objeto — y las propiedades que este tenant usa (`Address`, `Address2`, zip) viven en el deal.

El diseño acordado para cuando se implemente: **un custom object de HubSpot para direcciones**, con las propiedades necesarias (`AddressName`, `AddressType`, `Street`, `County`, `ZipCode`, `Country`, `TaxCode`), un registro por cada entrada de `BPAddresses`, asociado al BusinessPartner. Lo que ese spec tendrá que resolver, y que ya está investigado aquí:

- **Meter `BPAddresses` al `$select`.** Hoy solo entra por `COMPANY_ADD_FIELDS_URL_SAP` (`.env.example:37`), que es global y solo aplica a `company`. La inyección de mappings sintéticos de este spec sirve igual para esto.
- **`hubspotClient` no conoce custom objects.** `CRM_BATCH_COLLECTIONS` / `crmCollection` (`src/infrastructure/hubspot/hubspotClient.js:273-284`) solo mapean `company` y `contact`, y eso gatea `listAllObjects`, `batchCreateObjects`, `batchUpdateObjects` y `listWritablePropertyNames`. Las funciones de asociación **no** están gateadas (toman los tipos como strings libres), así que asociar sí funcionaría; crear y leer no.
- **Identidad y reconciliación.** Cada dirección necesita una propiedad de identidad en el custom object para no duplicar en cada corrida, equivalente a lo que `idsap` es para la company y `internalcode` para el contacto.

### ContactEmployees cuando el BusinessPartner es una persona

La regla del usuario "si el BP es una persona, es un contact en HubSpot y sus ContactEmployees son contactos asociados a ese contacto" **no se implementa**: el usuario confirmó que en la práctica los BP persona de este tenant no tienen ContactEmployees cargados en SAP. Los dos bloqueadores concretos, ya investigados, para el spec que algún día lo haga:

1. **El dato no llega.** `ContactEmployees` entra al `$select` solo por `COMPANY_ADD_FIELDS_URL_SAP`, y el mapa de esas variables es `{ company, product, deal }` (`src/infrastructure/sap/serviceLayerUrlBuilder.js:43-47`) — **no hay una para `contact`**. En la tarea de contactos ese campo nunca llega, ni siquiera a `rawSapData`. La inyección de mappings sintéticos de este spec es la forma limpia de arreglarlo.
2. **No existe la asociación contacto→contacto.** `ASSOCIATION_MAP` (`src/application/use-cases/HandleHubspotAssociations.js:7-11`) es `{ deal: [...], contact: ['company'], company: ['contact'] }`, sin entrada auto-referencial, y `execute` retorna temprano para cualquier `objectType` que no esté en el mapa (línea 112). `associationTypeId`, `associationCategory` y `contact_to_contact`: **cero ocurrencias en todo el repositorio**. Las funciones del cliente (`hubspotClient.js:361-404`) toman `fromObjectType`/`toObjectType` como strings libres y siempre mandan cuerpo `[]`, o sea asociación *default*; si HubSpot exige un tipo etiquetado para contacto→contacto, hará falta una función nueva que mande `associationCategory` + `associationTypeId`.

**Camino acordado si se implementa:** parametrizar `parentObjectType` (default `'company'`) en `HandleHubspotAssociations.syncCompanyContacts` y en `SyncCompanyContactsInBatches`, **sin renombrar los archivos** — decisión del usuario, para no mover imports en `hubspot-sync.composition.js`, `ProcessCrmObjectBatches.js` y `HandleHubspotAssociations.js`, que importa `buildContactErrorEntry` desde ahí. Duplicar esas ~900 líneas de dedup por claims, bisección de 409 y reporte de emails duplicados no es opción.

### Otros

- **S/4 HANA.** `Properties1..64` no existen en `A_BusinessPartner`.
- **Sembrar las 64 opciones** de la propiedad multi-select en HubSpot.
- **Actualizar `PropertiesN` de SAP desde HubSpot fuera del webhook de creación.** El spec hermano lo cubre solo en la creación; `upsertDataSAP` no sabe de la expansión 1→N.
