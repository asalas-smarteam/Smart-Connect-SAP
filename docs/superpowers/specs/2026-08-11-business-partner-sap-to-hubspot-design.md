# BusinessPartner de SAP B1 hacia HubSpot: ContactEmployees de cualquier BP y `Properties1..64`

Fecha: 2026-08-11
Dirección: **SAP → HubSpot** (tarea programada de `clientConfig`). Flavor: **solo B1 (`SERVICE_LAYER`)**.
Spec hermano: `2026-08-11-business-partner-full-creation-design.md` (dirección HubSpot → SAP). **Léelo primero**: este spec reutiliza dos servicios que aquel implementa.

## Problema

La tarea programada `SyncSapConfigToHubspot` (`src/application/use-cases/SyncSapConfigToHubspot.js`) trae BusinessPartners de SAP y los escribe en HubSpot. Un BusinessPartner de SAP B1 se ve en HubSpot de dos formas, y **en ambas sus `ContactEmployees` son contactos de HubSpot asociados al BP**:

| BusinessPartner en SAP | Objeto en HubSpot | Sus ContactEmployees | Estado hoy |
|---|---|---|---|
| Jurídico (`CompanyPrivate` = `'C'`) | **company** | contactos asociados a la company | **ya funciona** |
| Persona (`CompanyPrivate` = `'I'`) | **contact** | contactos asociados a ese contacto | **no existe** |

Qué decide cuál es cuál: `clientConfig.objectType` selecciona el handler de HubSpot por lookup en un mapa (`src/composition/hubspot-sync.composition.js:102-108`), y los filtros sembrados en `src/infrastructure/database/seeds/defaultSapFilters.seed.js` separan `CompanyPrivate eq 'I'` de `eq 'C'` en la consulta a SAP. Eso ya está y no necesita código nuevo.

Lo que falta son tres cosas independientes.

### 1. Los ContactEmployees de un BP persona no llegan a HubSpot

Dos bloqueos apilados:

**El dato no sale de SAP.** `ContactEmployees` entra al `$select` únicamente por una variable de entorno, y el mapa de esas variables es `{ company, product, deal }` (`src/infrastructure/sap/serviceLayerUrlBuilder.js:43-47`) — **no hay una para `contact`**. En la tarea de contactos el campo nunca llega, ni siquiera a `rawSapData`.

**El código de hijos no corre para un padre contacto.** En el camino secuencial, `handleCompanyAssociations` termina llamando a `syncCompanyContacts` (`src/application/use-cases/HandleHubspotAssociations.js:464`), mientras que `handleContactAssociations` (`:409-435`) sencillamente no tiene esa llamada. En el camino por lotes, la rama de `contact` de `handleAssociations` hace su asociación al registro y **retorna en la línea 671** (`src/application/use-cases/ProcessCrmObjectBatches.js:660-672`), sin llegar nunca al bloque de hijos que sí tiene la rama de `company` (`:686-698`).

Y cuando el dato sí llegue, falta la asociación en sí: `associationTypeId`, `associationCategory` y `contact_to_contact` tienen **cero ocurrencias en todo el repositorio**.

### 2. `Properties1..64` no puede existir

El cliente usa los 64 campos booleanos `Properties1` .. `Properties64` del BusinessPartner para marcar a qué agencias corresponde cada cliente, y necesita verlos seleccionados en una propiedad multi-select de HubSpot. Tres razones por las que hoy es imposible:

- **`FieldMapping` no puede expresar N→1.** El índice único es `{hubspotCredentialId, objectType, sourceContext, sourceField}` (`src/infrastructure/database/models/tenant/FieldMapping.js:57-65`) y el mapeo es una copia escalar (`buildMappedProperties`, `src/application/services/mappingValueResolver.service.js:95-120`). No hay ninguna capa de transformación de valores en el repositorio: `grep` de `valueMap`, `converter`, `transformValue` devuelve cero.
- **Los 64 campos nunca llegan al `$select`**, que se arma solo desde los `sourceField` de mappings activos más la variable de entorno (`serviceLayerUrlBuilder.js:21-64`).
- **Un array no se puede escribir.** HubSpot serializa un multi-select como string unido por `;`, y `isWritableValue` (`src/application/services/hubspotPropertyPayload.service.js:8-19`) **descarta cualquier array u objeto sin error ni log**.

### 3. Las direcciones no tienen destino válido

SAP tiene N direcciones por BusinessPartner (`BPAddresses`); una company de HubSpot tiene un solo juego de propiedades de dirección, y las propiedades que este tenant usa (`Address`, `Address2`, zip) viven en el **deal**. Ver "Fuera de alcance".

## Objetivo

1. Que los `ContactEmployees` de un BusinessPartner lleguen a HubSpot como contactos asociados al BP, **sin importar si el BP es una company o un contact**.
2. Que las banderas `PropertiesN` lleguen a una propiedad multi-select de HubSpot, en ambos tipos de objeto.
3. Dejar declarada una compuerta explícita (`requireAddress`) que documenta que las direcciones no se sincronizan todavía en esta dirección.

Sin que ningún tenant que no configure nada cambie de conducta.

## Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Hijos de un padre contacto | Parametrizar `parentObjectType` (default `'company'`) en la maquinaria existente | `SyncCompanyContactsInBatches` son ~900 líneas con dedup por claims, bisección de conflictos 409, reporte de emails duplicados y degradación a secuencial. Duplicarlas para un padre contacto sería insostenible. Los pares ya se arman como `{fromId, toId}` y la llamada es `batchAssociateDefault(token, 'company', 'contact', ...)`: ese `'company'` pasa a ser parámetro |
| Sin renombrar archivos ni métodos | `SyncCompanyContactsInBatches.js` y `syncCompanyContacts` conservan su nombre | Decisión del usuario. Renombrar movería imports en `hubspot-sync.composition.js`, `ProcessCrmObjectBatches.js` y `HandleHubspotAssociations.js` (que importa `buildContactErrorEntry` desde ahí) más sus tests. El nombre queda algo desactualizado y se compensa con un comentario de cabecera |
| `ASSOCIATION_MAP` | **No se toca** | Ese mapa gobierna qué asociaciones se traen de SAP, no la sincronización de hijos, que se invoca por separado al final de `handleCompanyAssociations` (`:464`). Agregar `contact: ['contact']` ahí disparararía una búsqueda de asociaciones en SAP que nadie pidió |
| Camino secuencial | Agregar la llamada a `syncCompanyContacts` al final de `handleContactAssociations` | Es exactamente lo que ya hace `handleCompanyAssociations` en su línea 464. Simetría, dos líneas |
| Camino por lotes | Sacar el bloque de hijos de la rama `company` y ejecutarlo para ambos objectType, pasando `parentObjectType: objectType` | Hay que eliminar el `return` de `ProcessCrmObjectBatches.js:671`, que hoy corta la rama de `contact` antes del bloque |
| Cómo llega `ContactEmployees` al `$select` de la tarea de contactos | Mapping sintético con `targetField: null`, con `sourceContext: 'businessPartner'` | Mismo mecanismo que para `PropertiesN` (ver abajo), y **crítico**: `sanitizeSelectFields` excluye del `$select` los mappings con `sourceContext: 'contactEmployee'` (`serviceLayerUrlBuilder.js:29`), así que el sintético NO puede llevar ese contexto o se filtraría a sí mismo. `ContactEmployees` sí pasa `SAP_FIELD_PATTERN` porque no tiene punto |
| Asociación contacto→contacto por lotes | `batchAssociateDefault(token, 'contact', 'contact', pares)`, la función que ya existe | `hubspotClient.js:361-374` toma `fromObjectType`/`toObjectType` como strings libres, así que produce la URL v4 válida sin código nuevo, y ya apunta a la ruta `batch/associate/default` |
| Asociación contacto→contacto por par | Función **nueva** `associateObjectsDefault`, con la ruta `/associations/default/` verificada en vivo | `associateObjects` (`hubspotClient.js:394-404`) usa la ruta **tipada** con cuerpo `[]`, que sigue sin verificar. No se modifica esa función porque afectaría asociaciones que ya están en producción; ver la sección de verificación |
| Doble dirección | Se asocia **una sola vez** por par | Verificado en vivo: HubSpot crea las dos direcciones en una sola llamada para el tipo sin etiqueta. Asociar dos veces sería una llamada desperdiciada por cada ContactEmployee |
| Guarda de auto-asociación | Se descartan los pares donde `fromId === toId`, con warning | Cuando el BP es una persona, un ContactEmployee puede resolver al **mismo** contacto de HubSpot (mismo email). Asociar un contacto a sí mismo es basura o un rechazo de la API, y este caso no existía cuando el padre era siempre una company |
| Identidad de los contactos hijo | `internalcode`, sin cambios | Ya está así (`hubspot-sync.composition.js:65`) y funciona igual sea el padre company o contact. `SyncCompanyContactsInBatches:185-192` **aborta** si esa propiedad no es escribible, en vez de degradar — esa protección se conserva tal cual |
| Mecanismo para `PropertiesN` | Enricher (`SapRecordEnricherPort`), **nunca** `FieldMapping` | Es N campos de SAP → 1 propiedad de HubSpot. Ya hay dos enrichers en producción con este patrón (`S4ContactEnrichmentAdapter`, `WarehouseStockEnrichmentAdapter`) |
| Cómo llegan los 64 campos al `$select` | Mappings sintéticos con `targetField: null`, copiando `withDynamicDescriptionSelectFields` (`src/domain/sync/dynamic-description.service.js:288-315`) | Es el precedente exacto y ya probado del repositorio para "un campo que el `$select` necesita pero que no tiene fila de mapping propia". No contamina el mapeo porque `mapRecords` vuelve a consultar los mappings por su cuenta y no recibe los sintéticos |
| Dónde escribe el enricher | Directo en `record.properties[hubspotProperty]` | El enricher de almacenes escribe en `record.rawSapData` porque `product.handler.js` tiene un paso que lo mueve a properties; para company/contact **no existe** ese paso, y `ProcessCrmObjectBatches`/`SendMappedItemsToHubspot` leen `item.properties` |
| Formato del valor | String unido por `;` | `isWritableValue` descarta arrays en silencio. Se reutiliza `HUBSPOT_OPTION_VALUE_SEPARATOR` de `src/domain/sync/dropdown-options.constants.js:54` en vez de un literal nuevo |
| Ninguna `PropertiesN` en `tYES` | Se escribe `''`, que **deselecciona todo** en HubSpot | Confirmado con el usuario: es parte de una homologación donde **SAP es la fuente de la verdad**. `sanitizeProperties` descarta `null`/`undefined` pero **conserva `''`** (`hubspotPropertyPayload.service.js:27-30`), así que el borrado efectivamente viaja |
| Distinción vacío vs apagado | `readSapPropertiesFlags` devuelve `null` con la strategy apagada y `''` con la strategy activa sin ninguna seleccionada; el enricher solo escribe cuando **no** es `null` | Un tenant sin la config no debe recibir escrituras de esa propiedad; un tenant con la config y sin marcas sí debe recibir el borrado |
| Flavor | Solo B1; en S/4 todo lo nuevo es no-op | `Properties1..64` son campos de `BusinessPartners` de B1. Los contactos de S/4 llegan por otro camino que ya existe (`_s4Contacts`, `S4ContactEnrichmentAdapter`) y no se toca |
| Reutilización desde el spec hermano | `readSapPropertiesFlags` y `listSapPropertiesFieldNames` **ya quedan implementados y probados** allá | Se diseñaron bidireccionales a propósito. La clave de config `propertiesFlags` también es compartida |
| Direcciones SAP→HubSpot | No se implementan. Config nueva `requireAddress` con `{ required: false }` | Decisión del usuario por tiempo. El destino real (custom object de HubSpot) es un spec aparte |
| Ubicación de `requireAddress` | Clave propia, **no** dentro de `businessPartnerCreation` | Esa clave está definida en el spec hermano como HubSpot→SAP únicamente |

## La asociación contacto→contacto: verificado en vivo

**Verificado el 2026-08-11 contra el portal real del cliente.** `GET /crm/v4/objects/contact/{id}/associations/contact?limit=100` devolvió asociaciones existentes con:

```json
{
  "category": "HUBSPOT_DEFINED",
  "typeId": 449,
  "label": null
}
```

Y la **escritura** también quedó verificada, con `PUT /crm/v4/objects/contact/233059562020/associations/default/contact/233053375747` sin cuerpo:

```json
{
  "status": "COMPLETE",
  "results": [
    { "from": { "id": "233059562020" }, "to": { "id": "233053375747" },
      "associationSpec": { "associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 449 } },
    { "from": { "id": "233053375747" }, "to": { "id": "233059562020" },
      "associationSpec": { "associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 449 } }
  ]
}
```

Cuatro conclusiones, que entre ellas eliminan el riesgo que este spec tenía:

1. El par contacto↔contacto **existe** en el portal, y tanto la lectura como la escritura funcionan por la API v4.
2. `label: null` con `category: HUBSPOT_DEFINED` es el tipo **sin etiqueta**, exactamente el que crean los endpoints `associate/default`. **No hace falta mandar `associationTypeId`** ni una función que sepa de tipos etiquetados.
3. **La asociación es simétrica: HubSpot crea las dos direcciones en una sola llamada.** Se ve en el `results` de arriba, que trae el par `from`/`to` y también su inverso. Consecuencias de diseño: (a) **no hay que asociar dos veces**, un solo PUT o un solo par en el batch basta; (b) el BusinessPartner va a aparecer en la lista de contactos asociados de su propio ContactEmployee, y eso es conducta de HubSpot, no algo que el código pueda evitar ni deba intentar corregir.
4. La respuesta tiene forma de lote (`status`, `results`) incluso para el PUT individual.

**Consecuencia para el código de este spec:** el camino nuevo usa la ruta `/associations/default/`, que es la verificada. Como `associateObjects` (`hubspotClient.js:394-404`) usa **otra** ruta (ver abajo), se agrega una función `associateObjectsDefault` en `hubspotClient.js` con la ruta verificada, y se usa para los pares contacto→contacto. Deliberadamente **no** se modifica `associateObjects`: eso depende de la investigación descrita abajo y afectaría asociaciones que ya están en producción.

### Lo que queda abierto: el cuerpo `[]` del PUT por par

Cuidado con una diferencia de ruta que este spec **no** puede dar por resuelta. HubSpot tiene dos endpoints distintos para crear una asociación individual:

| | Ruta | Cuerpo |
|---|---|---|
| Default (sin tipo) | `PUT /crm/v4/objects/{from}/{id}/associations/**default**/{to}/{id2}` | ninguno |
| Tipada | `PUT /crm/v4/objects/{from}/{id}/associations/{to}/{id2}` | `[{ associationCategory, associationTypeId }]` |

`associateObjects` (`hubspotClient.js:394-404`) usa **la tipada con cuerpo `[]`** — es decir, el endpoint que espera tipos, con la lista de tipos vacía. No es el endpoint default. Y las asociaciones fallidas **se tragan y solo se loguean** (`associationService.js:176-184`), así que un fallo ahí sería invisible.

Esto **no es un problema nuevo de este spec**: afecta igual a las asociaciones company↔contact que ya existen. Y hay un detalle que lo hace plausible: `SyncCompanyContactsInBatches` usa `batchAssociateDefault` como camino principal y el PUT por par **solo como fallback** (`:876-880` vs `:900`), mientras que el camino secuencial de `HandleHubspotAssociations` usa el PUT por par como principal. Si los tenants en producción corren con `hubspotBatchSize > 1`, el PUT por par casi nunca se ejecuta, y podría estar roto desde siempre sin que nadie lo note.

La ruta `/associations/default/` quedó verificada (arriba). **La tipada con `[]` sigue sin verificar**, y por eso este spec no la usa y tampoco la toca.

Queda registrado como investigación aparte, fuera de este spec: revisar si `associateObjects` con cuerpo `[]` funciona, y si no, corregirlo para **todos** los tipos de objeto (company↔contact, contact↔company, deal↔contact, deal↔company, deal↔line_item). Es un cambio de una línea, pero es el arreglo de un bug latente en funcionalidad existente y merece su propio hilo, no colarse aquí. Vale la pena evaluar también dejar de tragar los errores de asociación, o al menos elevarlos a warning contable en el `SyncLog`, para que un fallo así no vuelva a ser invisible.

El resto del spec no depende de ese resultado.

## Alternativas descartadas

| Alternativa | Por qué se descartó |
|---|---|
| Duplicar `SyncCompanyContactsInBatches` para un padre contacto | ~900 líneas de dedup por claims, bisección de 409, reporte de emails duplicados y degradación a secuencial, mantenidas en dos copias que se van a desincronizar |
| Renombrar a `SyncChildContactsInBatches` | Decisión del usuario: el nombre honesto no compensa mover imports en tres archivos de producción más sus tests, en un spec que ya toca bastante |
| Agregar `contact: ['contact']` a `ASSOCIATION_MAP` | Ese mapa dispara búsquedas de asociaciones **en SAP** (`fetchAssociationsIfNeeded`), no la sincronización de hijos. Agregarlo ahí provocaría consultas que nadie pidió y no resolvería el problema |
| Una variable de entorno `CONTACT_ADD_FIELDS_URL_SAP` | Sería global al despliegue, no por tenant: metería `ContactEmployees` en el `$select` de todos los tenants, incluidos los que no lo usan. El mapping sintético es por tenant y por config |
| 64 filas de `FieldMapping`, una por `PropertiesN` | Las 64 apuntarían a la misma propiedad de HubSpot; el índice único no incluye `targetField`, así que serían legales pero la última en resolverse ganaría y el resultado sería una sola marca en vez de la lista. Y obligaría al tenant a mantener 64 filas a mano |
| Meter `Properties1..64` en `COMPANY_ADD_FIELDS_URL_SAP` | Global al despliegue, y no existe la equivalente para `contact` |
| Agregar una columna de transformación a `FieldMapping` | Introduce una capa de transformación en un modelo que leen todos los flujos y todos los tenants, en ambas direcciones. Superficie de regresión enorme para el caso de un cliente |
| Escribir el multi-select como array | `isWritableValue` lo descarta **sin error ni log**; el síntoma sería "la propiedad no se actualiza", el tipo de fallo que cuesta días encontrar |
| Omitir el campo cuando no hay ninguna `PropertiesN` en `tYES` | Dejaría marcas fantasma en HubSpot que nadie puede explicar, y rompe la premisa de homologación donde SAP es la fuente de la verdad |
| Sembrar desde el código las 64 opciones del multi-select | Las etiquetas (Central, Quetzaltenango, …) no viven en ningún sitio que el código pueda leer hoy |
| Traer `BPAddresses` con un mapping punteado (`BPAddresses.Street`) | Tres bloqueos: (a) el resolvedor devuelve **siempre `BPAddresses[0]`**, fijado por el test `tests/unit/mappingService.test.js:5-25`; (b) `mappingCollectionPriority` no puede mandar la calle de factura a una propiedad y la de entrega a otra, porque dos mappings con `targetField` distinto resolverían por el mismo orden y devolverían la misma fila; (c) en B1 un `sourceField` con punto **nunca llega al `$select`** porque `SAP_FIELD_PATTERN` (`serviceLayerUrlBuilder.js:1`) no admite el punto y lo descarta sin warning |
| Volcar las direcciones en las propiedades de dirección de la company | Este tenant tiene `Address`/`Address2`/zip en el **deal**. No hay dónde ponerlas sin inventar propiedades que el cliente no pidió |

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

**No hay config nueva para los ContactEmployees de un BP persona.** Es la conducta correcta y simétrica con lo que ya pasa cuando el BP es una company; ponerle una compuerta sería pedirle al cliente que active algo que debería funcionar solo. Si el `$select` no trae `ContactEmployees` (tenant sin la inyección, o SAP que no los devuelve), el array llega vacío y todo el flujo es un no-op — la protección natural ya existe (`HandleHubspotAssociations.js:241-243`).

## Arquitectura

### Pieza A — inyección al `$select`

Dos funciones puras, ambas copiando el molde de `withDynamicDescriptionSelectFields` (`src/domain/sync/dynamic-description.service.js:288-315`): si no hay nada que inyectar devuelven la **misma referencia** de mappings; si hay, agregan entradas sintéticas y descartan las que ya estén cubiertas por un mapping con `includeInServiceLayerSelect !== false`.

```js
// src/domain/business-partners/sap-properties-flags.service.js  (lo crea el spec hermano)
withPropertiesFlagsSelectFields(mappings, propertiesFlagsConfig, { objectType, sourceContext })

// src/domain/business-partners/contact-employees-select.service.js  (nuevo)
withContactEmployeesSelectField(mappings, { objectType, sourceContext })
```

Forma de una entrada sintética:

```js
{
  sourceField: 'ContactEmployees',
  targetField: null,               // solo para el $select, nunca escribe propiedades
  objectType,
  sourceContext: 'businessPartner', // NO 'contactEmployee': ver abajo
  includeInServiceLayerSelect: true,
  isActive: true,
}
```

**El `sourceContext` es load-bearing.** `sanitizeSelectFields` excluye del `$select` todo mapping con `sourceContext: 'contactEmployee'` (`serviceLayerUrlBuilder.js:29`) — y tras el spec hermano también los de `'bpAddress'`. Un sintético con contexto `contactEmployee` se filtraría a sí mismo y el bug sería invisible: el `$select` sale sin el campo, SAP devuelve registros sin `ContactEmployees`, el array llega vacío y nadie se enteraría.

`withContactEmployeesSelectField` solo inyecta cuando `objectType === 'contact'`: para `company` el campo ya llega por la variable de entorno que los tenants existentes tienen configurada, y meterlo dos veces sería redundante (aunque inofensivo, porque el `$select` se deduplica con un `Set` en `serviceLayerUrlBuilder.js:148-150`).

Ambas se enchufan en `fetchOptions.mappings` de `SyncSapConfigToHubspot.js:88-94`, envolviendo la llamada que ya está ahí:

```js
      const fetchOptions = {
        ...buildSapFetchOptions(activeConfig, this.dateProvider),
        mappings: withContactEmployeesSelectField(
          withPropertiesFlagsSelectFields(
            withDynamicDescriptionSelectFields(sapMappings, dynamicDescriptionConfig, {
              objectType: activeConfig.objectType,
              sourceContext,
            }),
            propertiesFlagsConfig,
            { objectType: activeConfig.objectType, sourceContext }
          ),
          { objectType: activeConfig.objectType, sourceContext }
        ),
      };
```

**Por qué los sintéticos no contaminan el mapeo:** `fetchOptions.mappings` solo se usa para armar el request a SAP. `mapRecords` (`SyncSapConfigToHubspot.js:130-135`) no recibe esa lista — vuelve a consultar los mappings desde Mongo por su cuenta.

### Pieza B — hijos para un padre contacto

**Camino secuencial.** `handleContactAssociations` (`HandleHubspotAssociations.js:409-435`) gana al final la misma llamada que ya tiene `handleCompanyAssociations` en su línea 464:

```js
    return this.syncCompanyContacts({
      token,
      item,
      clientConfig,
      tenantModels,
      companyHubspotId: hubspotId,
      parentObjectType: 'contact',
      syncLogId,
    });
```

Requiere que `handleContactAssociations` reciba `syncLogId` (hoy no lo recibe; `handleCompanyAssociations` sí) y que `execute` se lo pase en su rama de `contact` (`:117`).

`syncCompanyContacts` gana `parentObjectType = 'company'` y lo usa en su única llamada de asociación (`:386-392`), más la guarda de auto-asociación.

**Camino por lotes.** En `ProcessCrmObjectBatches.handleAssociations` (`:655-700`) se elimina el `return` de la línea 671 y el bloque de hijos (`:686-698`) sale de la rama de `company` para ejecutarse en ambas, con `parentObjectType: objectType`.

`SyncCompanyContactsInBatches.execute` gana `parentObjectType = 'company'` y lo propaga a `associateContactBatches`, que lo usa en `batchAssociateDefault(token, parentObjectType, 'contact', ...)` (`:876-880`) y en el fallback por par (`:900`).

**El fallback por par cambia de función.** Hoy es `associateObjects`, que usa la ruta tipada con cuerpo `[]` — sin verificar. Pasa a ser `associateObjectsDefault`, nueva en `hubspotClient.js`, con la ruta verificada:

```js
// Ruta `default` de la API v4: sin cuerpo, HubSpot aplica el tipo sin etiqueta
// del par. Verificada en vivo para contact->contact (typeId 449), donde además
// crea las dos direcciones en una sola llamada.
export async function associateObjectsDefault(token, fromType, fromId, toType, toId) {
  return hubspotRequest(
    'put',
    `/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`,
    token,
  );
}
```

Hay que exponerla también en `src/infrastructure/hubspot/hubspot-crm-batch.adapter.js:10-17`, que hoy expone una superficie deliberadamente estrecha (`associateObjects, batchAssociateDefault, batchCreateObjects, batchUpdateObjects, listAllObjects, listWritablePropertyNames`).

Y el camino secuencial: `associationService.associateCompanyWithContacts` (`src/infrastructure/hubspot/associationService.js:244-260`) baja hasta `associateObjectsBySapId` (`:139-188`), que llama a `associateObjects` por id. Ese camino también necesita `parentObjectType` y la función nueva.

**Guarda de auto-asociación**, en los dos caminos: se descarta el par cuando `fromId === toId`, con un warning. Caso nuevo que no podía ocurrir con un padre company.

`getCompanySapId` (`SyncCompanyContactsInBatches.js:21-26`) ya sirve tal cual: su expresión es `rawSapData.BusinessPartner ?? rawSapData.CardCode ?? properties.idsap`, y un BP persona tiene `CardCode` igual que uno jurídico.

### Pieza C — el enricher de `PropertiesN`

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

**Orden importante:** corre después de `mapRecords` porque necesita `rawSapData` (adjuntado por índice posicional en `SyncSapConfigToHubspot.js:136-139`), y antes de `sendMappedRecords` para que `sanitizeProperties` vea el valor ya resuelto.

### Compuerta `requireAddress`

Sin pieza de código de direcciones. Solo un repositorio que lee la clave y la normaliza a `{ required: boolean }` sin lanzar, una comprobación en `SyncSapConfigToHubspot` que registra `ADDRESS_SYNC_NOT_IMPLEMENTED` una vez por corrida cuando `required` es `true` y el `objectType` es `company` o `contact`, la semilla en `tenantProvisioning.js` y la entrada en `configuration_examples.md`.

## Lo que ya funciona y no se toca

**BP jurídico → company + sus ContactEmployees como contactos asociados.** Existe completo en dos caminos que se eligen por `clientConfig.hubspotBatchSize` (`src/application/use-cases/SendMappedItemsToHubspot.js:136-170`):

- **Secuencial:** `HandleHubspotAssociations.syncCompanyContacts` (`:214-407`). Lee `rawSapData._s4Contacts ?? rawSapData.ContactEmployees` (`:237-239`), mapea con contexto `contactEmployee`, busca cada contacto con la Search API, y asocia par por par.
- **Por lotes:** `SyncCompanyContactsInBatches` (`:119-324`). Mismo dato, pero con un barrido `listAllObjects` indexado en memoria, `batch/create` con bisección de conflictos 409, dedup por claims y `batch/associate/default`.

La parametrización de la Pieza B **no cambia nada de esto**: `parentObjectType` tiene default `'company'`, así que sin pasarlo el comportamiento es idéntico.

**El camino de contactos de S/4** (`S4ContactEnrichmentAdapter`, `_s4Contacts`) tampoco se toca: la lectura `_s4Contacts ?? ContactEmployees` ya cubre ambos flavors en el mismo sitio.

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| `propertiesFlags` ausente o `strategy: 'none'` | El enricher no escribe nada y la inyección devuelve los mappings intactos. Conducta idéntica a hoy |
| `hubspotProperty` vacío en la config | El enricher no hace nada + warning una vez por corrida |
| Tenant con flavor S/4 | El enricher es no-op + warning una vez por corrida |
| `record.rawSapData` es `null` | Ese registro se salta; los demás siguen |
| Falla la lectura de una config | Se usan los defaults (apagado); nunca lanza |
| `ContactEmployees` no viene en el registro de SAP | El array llega vacío y el flujo de hijos retorna temprano sin tocar HubSpot (`HandleHubspotAssociations.js:241-243`) |
| Un ContactEmployee sin email y sin bypass | Se salta ese contacto con warning, como ya hace hoy (`:325-345`) |
| `fromId === toId` (auto-asociación) | Se descarta el par + warning; el contacto ya quedó creado/actualizado |
| Falla una asociación | Se loguea y no es fatal, igual que hoy (`associationService.js:176-184`) |
| `internalcode` no es escribible en HubSpot | **Aborta** el flujo de hijos, como ya hace hoy (`SyncCompanyContactsInBatches.js:185-192`). Esa protección viene del incidente de duplicados y no se relaja |
| La propiedad multi-select no existe o no es `enumeration` | HubSpot rechaza ese registro; lo recoge el manejo de errores por lote que ya existe. **Prerequisito documentado** |
| `requireAddress.required === true` | Warning `ADDRESS_SYNC_NOT_IMPLEMENTED` una vez por corrida; la corrida sigue |

## Prerequisitos fuera del código

La propiedad multi-select de HubSpot debe existir **antes** de activar `propertiesFlags`, con sus opciones cuyos valores internos son los números del rango (`1`, `2`, … `64`). Se crea a mano o con el flujo `SyncDropdownOptionsToHubspot` que ya existe. Este spec no la crea.

## Pruebas

Jest necesita `NODE_OPTIONS=--experimental-vm-modules` en este proyecto.

1. **Guardia de regresión (la más importante):** con `propertiesFlags` ausente y sin pasar `parentObjectType`, la URL del `$select`, las propiedades enviadas y los pares de asociación son idénticos a los de hoy. Las dos funciones de inyección devuelven la **misma referencia** de mappings.
2. `withContactEmployeesSelectField`: inyecta `ContactEmployees` cuando `objectType` es `contact`; no inyecta para `company`; el sintético lleva `sourceContext: 'businessPartner'` (**no** `contactEmployee`); no duplica si ya hay un mapping para ese campo; y el resultado **sobrevive a `sanitizeSelectFields`**, es decir el campo aparece en la URL final.
3. `withPropertiesFlagsSelectFields`: inyecta los 64 nombres; deduplica contra un mapping que ya declare `Properties5`; respeta un rango personalizado; no cuenta como cubierto un mapping con `includeInServiceLayerSelect: false`; los sintéticos llevan `targetField: null`.
4. Enricher: escribe `'1;3;64'` a partir de las banderas de SAP; escribe `''` cuando ninguna está en `tYES` (**el caso de deselección**); no escribe nada con la strategy apagada; se salta `product` y `deal`; se salta S/4; sobrevive a `rawSapData: null`; no lanza cuando la lectura de config falla.
5. Hijos con padre contacto, camino secuencial: `handleContactAssociations` llama a `syncCompanyContacts`; los pares se arman `contact → contact`; un par con `fromId === toId` se descarta con warning.
6. Hijos con padre contacto, camino por lotes: `handleAssociations` ya no retorna temprano en la rama de `contact`; `batchAssociateDefault` recibe `('contact', 'contact')`; el fallback por par usa `associateObjectsDefault`; sin `parentObjectType` recibe `('company', 'contact')`.
7. `associateObjectsDefault` construye la URL con `/associations/default/` y **sin cuerpo**; cada par se asocia **una sola vez** (no se emite la llamada inversa, porque HubSpot ya la crea).
8. Composición: el adapter cumple `SapRecordEnricherPort`.
9. `requireAddress`: default `false`; `true` produce el warning y no aborta.

## Archivos afectados

### Modificados

| Archivo | Qué cambia |
|---|---|
| `src/domain/business-partners/sap-properties-flags.service.js` | Agregar `withPropertiesFlagsSelectFields` (el archivo lo crea el spec hermano) |
| `src/application/use-cases/SyncSapConfigToHubspot.js:88-94` | Envolver `fetchOptions.mappings` con las dos inyecciones |
| `src/application/use-cases/SyncSapConfigToHubspot.js:162-168` | Invocar `propertiesFlagsEnricher`; agregarlo al constructor |
| `src/application/use-cases/SyncSapConfigToHubspot.js` | Comprobación de `requireAddress` con el warning una vez por corrida |
| `src/application/use-cases/HandleHubspotAssociations.js:117` | Pasar `syncLogId` a `handleContactAssociations` |
| `src/application/use-cases/HandleHubspotAssociations.js:409-435` | Llamar a `syncCompanyContacts` con `parentObjectType: 'contact'` |
| `src/application/use-cases/HandleHubspotAssociations.js:214-407` | `syncCompanyContacts` gana `parentObjectType = 'company'` y la guarda `fromId === toId` |
| `src/application/use-cases/ProcessCrmObjectBatches.js:655-700` | Quitar el `return` de la línea 671 y ejecutar el bloque de hijos para ambos objectType con `parentObjectType` |
| `src/application/use-cases/SyncCompanyContactsInBatches.js:119-324` | `execute` gana `parentObjectType = 'company'` y lo propaga |
| `src/application/use-cases/SyncCompanyContactsInBatches.js:850-916` | `associateContactBatches` usa `parentObjectType` en el batch y en el fallback, más la guarda `fromId === toId` |
| `src/infrastructure/hubspot/hubspotClient.js` | Agregar `associateObjectsDefault` con la ruta `/associations/default/`. **No** modificar `associateObjects` |
| `src/infrastructure/hubspot/hubspot-crm-batch.adapter.js:10-17` | Exponer `associateObjectsDefault` |
| `src/infrastructure/hubspot/associationService.js:139-188, 244-260` | `parentObjectType` y usar `associateObjectsDefault` en el camino secuencial |
| `src/composition/sap-sync.composition.js:69-97` | Cablear el enricher con `assertPort` |
| `src/infrastructure/tenants/tenantProvisioning.js:83-158` | Sembrar `requireAddress` con `{ required: false }` |
| `configuration_examples.md` | Documentar `requireAddress` |

### Nuevos

- `src/domain/business-partners/contact-employees-select.service.js`
- `src/infrastructure/sap/customers/PropertiesFlagsEnrichmentAdapter.js`
- `src/infrastructure/config/AddressSyncConfigRepository.js`
- `tests/unit/domain/contactEmployeesSelectField.test.js`
- `tests/unit/domain/propertiesFlagsSelectFields.test.js`
- `tests/unit/infrastructure/propertiesFlagsEnrichmentAdapter.test.js`
- `tests/unit/infrastructure/addressSyncConfigRepository.test.js`
- `tests/unit/application/contactParentChildContacts.test.js`

## Fuera de alcance

### Direcciones SAP → HubSpot (spec futuro: custom object)

`requireAddress` queda en `false` y las direcciones no viajan. **El destino correcto no es la company ni el contact**, porque SAP tiene N direcciones y HubSpot un solo juego de propiedades de dirección por objeto — y las propiedades que este tenant usa (`Address`, `Address2`, zip) viven en el deal.

Diseño acordado para cuando se implemente: **un custom object de HubSpot para direcciones**, con las propiedades necesarias (`AddressName`, `AddressType`, `Street`, `County`, `ZipCode`, `Country`, `TaxCode`), un registro por cada entrada de `BPAddresses`, asociado al BusinessPartner. Lo que ese spec tendrá que resolver, ya investigado aquí:

- **Meter `BPAddresses` al `$select`.** Hoy solo entra por `COMPANY_ADD_FIELDS_URL_SAP` (`.env.example:37`), que es global y solo aplica a `company`. El mecanismo de mappings sintéticos de este spec sirve igual para esto.
- **`hubspotClient` no conoce custom objects.** `CRM_BATCH_COLLECTIONS` / `crmCollection` (`src/infrastructure/hubspot/hubspotClient.js:273-284`) solo mapean `company` y `contact`, y eso gatea `listAllObjects`, `batchCreateObjects`, `batchUpdateObjects` y `listWritablePropertyNames`. Las funciones de asociación **no** están gateadas (toman los tipos como strings libres), así que asociar sí funcionaría; crear y leer no.
- **Identidad y reconciliación.** Cada dirección necesita una propiedad de identidad en el custom object para no duplicar en cada corrida, equivalente a lo que `idsap` es para la company y `internalcode` para el contacto.

### Otros

- **S/4 HANA** para `Properties1..64`: no existen en `A_BusinessPartner`.
- **Sembrar las 64 opciones** de la propiedad multi-select en HubSpot.
- **Actualizar `PropertiesN` de SAP desde HubSpot fuera del webhook de creación.** El spec hermano lo cubre solo en la creación; `upsertDataSAP` no sabe de la expansión 1→N.
