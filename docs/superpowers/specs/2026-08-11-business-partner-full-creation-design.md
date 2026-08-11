# Creación completa de BusinessPartner en SAP B1 desde HubSpot (BPAddresses + ContactEmployees + Properties1..64)

Fecha: 2026-08-11
Dirección: **HubSpot → SAP** (webhooks de deal). Flavor: **solo B1 (`SERVICE_LAYER`)**.
Spec hermano pendiente: `2026-08-11-business-partner-sap-to-hubspot-design.md` (dirección SAP → HubSpot).

## Problema

Cuando un webhook de deal necesita un BusinessPartner en SAP, todo desemboca en
`SapWebhookOrderAdapter.findOrCreateBusinessPartner()`
(`src/infrastructure/sap/SapWebhookOrderAdapter.js:154`): busca por `CardCode` (línea 200), luego
por el campo declarado en la config `defaultFindSAP` (línea 226), y si no lo encuentra lo crea
(líneas 256-321).

El problema es **qué** crea. El payload del POST es un whitelist cerrado de nueve campos
(`SapWebhookOrderAdapter.js:268-278`):

```js
const payload = {
  CardName: cardName,
  CardType: 'C',
  CompanyPrivate: companyExists ? 'C' : 'I',
  EmailAddress: mappedEmail || '',
  Phone1: toNonEmptyString(mappedCompany?.Phone1 || mappedContact?.Phone1) || undefined,
  PriceListNum: resolvedPriceListNum,
  FederalTaxID: toNonEmptyString(federalTaxId) || undefined,
  Frozen: 'tNO',
  Valid: 'tYES',
};
```

más `CardCode`/`Series` (280-288) y `PayTermsGrpCode` (290-299). Consecuencias medidas:

1. **Todo lo demás que el tenant haya mapeado se descarta en silencio durante la creación.** Un
   mapping de `GroupCode`, `Currency`, `SalesPersonCode`, `U_TIPO_IND`, `U_SUBGRUPO`, `U_VENDEQUI`,
   `U_CORREO_FACTURA` existe en `FieldMappings`, se lee, se mapea… y nunca llega al POST. Hoy esos
   campos solo alcanzan SAP por la ruta PATCH de `upsertDataSAP`, que **por diseño solo corre
   cuando el BP ya existía**.
2. **`BPAddresses` no existe en el código.** Cero ocurrencias en `src/`. `bo_BillTo`, `bo_ShipTo` y
   `AddressType`: cero ocurrencias en todo el repositorio. La única mención de `BPAddresses` es
   como campo opaco de `$select` vía `COMPANY_ADD_FIELDS_URL_SAP` (`.env.example:37`), consumido
   genéricamente por `serviceLayerUrlBuilder.js:43-64` en la dirección de lectura.
3. **`ContactEmployees` se crea en una segunda llamada, no en el POST**, y solo cuando el deal trae
   company **y** contact (`ProcessHubspotWebhookEvent.js:134`, `webhookQuotationSupport.js:197`).
   Además `addContactEmployeeIfNeeded()` (`SapWebhookOrderAdapter.js:368`) recibe **un** contacto,
   no una lista.
4. **`Properties1..64` no tiene forma de existir.** Son 64 campos booleanos de SAP alimentados por
   **una sola** propiedad multi-select de HubSpot. `FieldMapping` no puede expresar 1→N: su índice
   único es `{hubspotCredentialId, objectType, sourceContext, sourceField}`
   (`FieldMapping.js:57-65`) y el mapeo es copia cruda de un valor
   (`mapHubspotToSapFields`, `src/domain/orders/order-builder.service.js:6-27`). No existe ninguna
   capa de transformación de valores en el repositorio: `FieldMapping` no tiene columna de
   transform/converter, y `grep` de `valueMap`, `converter`, `transformValue` devuelve cero.

Un cliente de SAP Business One exige crear el BusinessPartner con sus direcciones y sus contactos
en un solo paso, con este payload objetivo:

```json
{
  "CardName": "EMPRESA DE PRUEBA 29052026",
  "CardType": "cCustomer",
  "GroupCode": 105,
  "Phone1": "+50259877130",
  "PayTermsGrpCode": 13,
  "FederalTaxID": "0003004080-9",
  "PriceListNum": 1,
  "SalesPersonCode": 1,
  "EmailAddress": "ac123@gmail.com",
  "Properties1": "tYES",
  "U_TIPO_IND": "IP",
  "Series": 59,
  "U_SUBGRUPO": "EMPRESAS MERCANTILES",
  "U_TIPO": "N",
  "U_VENDEQUI": "CHIEQP - Luis Lee",
  "U_CORREO_FACTURA": "asalas@smarteamcr.com",
  "BPAddresses": [
    { "AddressName": "factura", "Street": "...", "County": "La Habana", "Country": "GT", "TaxCode": "IVA", "AddressType": "bo_BillTo" },
    { "AddressName": "Entrega", "Street": "...", "County": "La Habana", "Country": "GT", "TaxCode": "IVA", "AddressType": "bo_ShipTo" }
  ],
  "ContactEmployees": [
    { "Name": "Juan Mazariegos", "Position": "Sr.", "Phone1": "3038-5327", "Title": "Lic.",
      "Active": "tYES", "FirstName": "Juan", "LastName": "Mazariegos", "U_SUCURSAL": "central" }
  ]
}
```

Y además reglas que **varían por tenant**: hay clientes que crean una sola dirección, otros más de
dos; hay clientes que no usan `Properties1..64` en absoluto; y la regla de quién es el
ContactEmployee cuando el deal trae company y contact cambia respecto a lo que hace hoy el sistema.

## Objetivo

Convertir el armado del payload de creación en una **strategy seleccionada por configuración de
tenant**, capaz de producir el JSON de arriba, con `BPAddresses` y `ContactEmployees` anidados en un
único POST, y con `Properties1..64` derivadas de una propiedad multi-select de HubSpot.

**Restricción dura: cero regresión.** La strategy por defecto reproduce el comportamiento actual
bit a bit. Ningún tenant cambia de conducta sin que alguien escriba una configuración.

## Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Alcance de flavor | Solo B1 (`SERVICE_LAYER`) | `BPAddresses`/`ContactEmployees` anidados son forma de B1. En S/4 son entidades separadas (`to_BusinessPartnerAddress`, BP relationships) y requerirían POSTs independientes. Si el tenant es S/4, la funcionalidad no aplica |
| Activación | Config `businessPartnerCreation.payloadStrategy`; default `legacyWhitelist` | Los mappings de contexto `businessPartner` los leen **ambas** direcciones (ver `TenantWebhookRuntimeRepository.js:47-48` y `SyncSapConfigToHubspot.js:73`). Pasar a "enviar todo lo mapeado" globalmente haría que campos declarados solo para leer de SAP empiecen a escribirse en la creación |
| Direcciones: origen de los datos | Array `bpAddress` en el payload del webhook, mapeado con su propio juego de `FieldMappings` | Mismo patrón que ya usa `line_items` (`field-mapping.service.js:273-282`). El **número de direcciones lo manda el dato**, no la config: 1, 2 o N sale natural |
| Direcciones: `objectType` del mapping | `objectType: 'address'`, `sourceContext: 'bpAddress'`, un solo juego de filas | El array es independiente de quién sea el BP, así que las mismas filas sirven si el BP es company o contact. `objectType` no tiene enum en el modelo (`FieldMapping.js:13-15`), así que no hay migración. Sigue la convención de que `objectType` nombra *la cosa del payload que estas filas leen* — igual que `line_items` usa `objectType: 'product'` |
| Direcciones: unión con la config | Por `AddressName` normalizado (trim + minúsculas) contra `addresses.byName` | Es la llave natural y la que el cliente ya usa ("factura" / "Entrega"). `AddressType` deja de ser una regla en código y pasa a ser un valor de config |
| Direcciones: faltantes | Config `addresses.required: []`. Si falta un `AddressName` declarado ahí → `PermanentWebhookError` **antes** de escribir en SAP | Este tenant exige siempre 2, pero otros tienen 1 o más de 2. Una lista por tenant cubre los tres casos; vacía o ausente no valida nada. Fallar antes del POST evita dejar un BP a medias en SAP, y el mensaje se ve en HubSpot vía `requireMessageHS` |
| Origen de los ContactEmployees | Config `contactEmployeeSource`; default `dealContact` (= hoy), nuevo `payloadArray` (lee `payload.contactEmployees`) | Explícito y auditable: si el workflow de un tenant legacy empieza a mandar `contactEmployees` por error, su comportamiento no cambia. Consistente con cómo se resuelve todo lo demás en este repositorio |
| Selección del BP | **No cambia**: BP = company si viene, si no el contact | Regla confirmada con el cliente: es idéntica en ambos comportamientos. Lo único que cambia entre strategies es de dónde salen los CE |
| Deal sin company y sin contact | `PermanentWebhookError` explícito, en **ambas** strategies | Hoy revienta por accidente con `CardName is required to create Business Partner` (`SapWebhookOrderAdapter.js:265`), que es un mensaje engañoso. El deal siempre debe traer uno de los dos |
| ContactEmployees al crear vs al existir | Si el BP se **crea**: anidados en el POST y se salta `addContactEmployeeIfNeeded`. Si **ya existía**: se reconcilian con el PATCH actual | Una sola llamada a SAP en el camino de creación (reproduce el JSON objetivo) y sin riesgo de duplicar. El puerto expone `includesContactEmployeesInCreate()` para que el use-case lo sepa en vez de inferirlo |
| `Properties1..64` | Strategy + config, **nunca** `FieldMapping` | Es 1 propiedad de HubSpot → N campos de SAP. El índice único de `FieldMapping` es por `sourceField`, así que no puede expresarlo. `strategy: 'none'` (o clave ausente) = apagado, para los tenants que no usan estos campos |
| `Properties1..64`: resolución del número | Directa: el valor interno de la opción de HubSpot **es** el número (`55` → `Properties55: 'tYES'`) | Es como el cliente ya tiene numeradas sus opciones. Una tabla de 64 equivalencias sería superficie de config que hoy nadie necesita |
| `Properties1..64`: solo las seleccionadas | Se envían únicamente las `tYES`; las no seleccionadas se omiten | Es lo que pidió el cliente, y en un POST de creación omitir equivale a dejar el default de SAP |
| Precedencia de cada campo | valor del payload ya mapeado (no vacío) → default de config → **se omite** | `mapHubspotToSapFields` (`order-builder.service.js:20-23`) ya descarta `null`/`undefined`/`''`, así que la precedencia se apoya en comportamiento existente |
| Valores vacíos | Se omiten del POST; **nunca** se envía `null` explícito | Ya está documentado en este proyecto que un `null` en un mapping sobreescribe el valor bueno. En una creación, omitir un campo deja que SAP aplique su propio default |
| Write-back a HubSpot | `idsap` = `CardCode` al objeto que **es** el BP. `internalCode` = `InternalCode` de SAP a **cada** contacto que sí quedó como ContactEmployee | Hoy `buildWebhookEventReferenceUpdates` (`webhook-payload.service.js:73`) escribe `internalCode` al contact del deal cuando hay company+contact. Con `payloadArray` ese contact puede no ser CE, y escribirle `internalCode` dejaría un dato mentiroso en HubSpot |
| `contactEmployees` como objeto suelto | Se acepta array **o** objeto único (se envuelve en array) | El ejemplo del cliente lo mostró como objeto. Dos líneas de tolerancia evitan una clase entera de errores de configuración del workflow |
| Separador de multi-select | Se reutiliza `HUBSPOT_OPTION_VALUE_SEPARATOR` de `src/domain/sync/dropdown-options.constants.js:54` | Es el primer split/join por `;` del repositorio; un literal nuevo duplicaría una constante que ya existe con su comentario explicativo |
| Bug de `$select` a corregir | `serviceLayerUrlBuilder.js:28-31` debe excluir también `sourceContext: 'bpAddress'` | Hoy solo excluye `contactEmployee`. Sin este cambio, `Street`/`County`/`ZipCode` se agregarían al `$select` de `BusinessPartners` en la sync SAP→HubSpot y **romperían un flujo que hoy funciona** |
| Deuda que **no** se toca | La casi-duplicación entre `ProcessHubspotWebhookEvent.js:62-159` y `webhookQuotationSupport.js:112-230` | Unificarlas es un refactor con riesgo de regresión que no sirve a este objetivo. Solo se extrae la resolución BP/CE a un servicio compartido, que sí es necesario para no implementar la strategy tres veces |

## Alternativas descartadas

| Alternativa | Por qué se descartó |
|---|---|
| Cambiar el payload de creación para **todos** los tenants (sin strategy) | Los mappings de contexto `businessPartner` se leen en ambas direcciones. Un tenant que declaró `DocEntry` o `CardCode` para poblar HubSpot los empezaría a mandar en el POST de creación |
| Dos `sourceContext` separados, `bpAddressBillTo` y `bpAddressShipTo` | Fija el diseño en exactamente dos direcciones. El cliente puede tener 1 o más de 2, y cada variante nueva exigiría otro valor de enum y otra query |
| Un solo `sourceContext` con discriminador embebido en `sourceField` (ej. `BillTo.Street`) | Obliga a tocar el índice único de `FieldMapping` y a parsear convenciones dentro de un nombre de campo |
| `slots` en config con `overrides` por slot (SAP field → propiedad de HubSpot) | Era necesario solo para que "Entrega" pudiera tener calle distinta a "factura". Con el array en el payload cada entrada trae sus propios valores, así que `overrides` desaparece: menos config y menos código |
| Duplicar los mappings de dirección en `objectType: 'company'` y `objectType: 'contact'` | Las mismas filas duplicadas para un dato que no depende del BP. Doble mantenimiento sin ningún beneficio |
| Decidir la fuente de los CE por el dato (si viene `contactEmployees`, usarlo; si no, `[contact]`) | Un `contactEmployees: []` vacío enviado por error borraría, de forma invisible, el CE que hoy sí se crea |
| Fallback al contact del deal cuando `contactEmployees` no viene bajo `payloadArray` | Reproduciría exactamente el comportamiento que el cliente pidió cambiar, y lo haría sin que nadie lo note. Se prefiere `CE = []` + warning con código propio |
| Consultar la API de asociaciones de HubSpot para traer los contactos de la empresa | Hoy el webhook **no hace ninguna** llamada a HubSpot para resolver asociaciones: el payload llega pre-armado desde un workflow (`resolveEventPayload`, `webhook-payload.service.js:3-14`). Agregaría un adapter nuevo, latencia y rate-limit dentro del webhook |
| Una clave `businessPartnerShape` bidireccional para jurídico vs persona | En SAP→HubSpot eso **ya está resuelto** por `clientConfig.objectType` más los filtros de `src/infrastructure/database/seeds/defaultSapFilters.seed.js:6-68` (`CompanyPrivate eq 'I'` para contact, `'C'` para company). No hace falta strategy nueva |
| Tabla de 64 equivalencias etiqueta→número para `Properties1..64` | El cliente ya numeró sus opciones de 1 a 64. Serían 64 entradas de config a mantener a mano para un caso hipotético |
| Poner `Properties`, direcciones y defaults en cuatro claves de config separadas | Tres claves cohesionadas son más fáciles de leer y de documentar. Se sigue el precedente de `upsertDataSAP` y `dropdownOptionsSync`, que también agrupan ajustes relacionados |
| Rellenar con la config las direcciones que el workflow no envíe | Metería direcciones basura en SAP (solo `AddressName` + `AddressType`, sin calle) para cumplir literalmente el "siempre 2" |

## Cambio en el payload del webhook

El workflow de HubSpot pasa a enviar dos claves nuevas. `contact` sigue existiendo (puede ser
`null`); `contactEmployees` y `bpAddress` son las nuevas:

```json
{
  "payload": {
    "portalId": "50082681",
    "deal": { },
    "company": { },
    "contact": null,
    "contactEmployees": [ { } ],
    "bpAddress": [ { "AddressName": "factura" }, { "AddressName": "Entrega" } ],
    "line_items": [ ],
    "processedAt": "2026-08-07T21:13:50.278Z"
  }
}
```

`resolveEventPayload` (`src/application/services/webhook-payload.service.js:3-14`) las expone igual
que las demás, con el mismo fallback `payload.X || payload.data.X` que ya usa para
`deal`/`company`/`contact`/`line_items`.

## Configuración

Dos claves nuevas en la colección `Configurations` (modelo
`src/infrastructure/database/models/tenant/Configuration.js`, `value` es `Schema.Types.Mixed`).

### `businessPartnerCreation` — solo HubSpot → SAP

```js
{
  key: 'businessPartnerCreation',
  userUpdated: 'admin',
  value: {
    payloadStrategy: 'fullMapped',           // 'legacyWhitelist' (default) | 'fullMapped'
    contactEmployeeSource: 'payloadArray',   // 'dealContact' (default) | 'payloadArray'
    defaults: {
      BusinessPartner: { CardType: 'cCustomer', PayTermsGrpCode: 13, Series: 59, PriceListNum: 1 },
      ContactEmployee: { Active: 'tYES' },
      BPAddress:       { TaxCode: 'IVA' },   // aplica a TODAS las direcciones
    },
    addresses: {
      strategy: 'payloadArray',              // 'none' (default) | 'payloadArray'
      byName: {
        factura: { AddressType: 'bo_BillTo', Country: 'GT' },
        entrega: { AddressType: 'bo_ShipTo', Country: 'GT' },
      },
      required: ['factura', 'entrega'],       // vacío o ausente = no valida
    },
  },
}
```

Reglas de resolución de direcciones, en este orden exacto:

1. **Precedencia por campo:** valor del payload ya mapeado (no vacío) → `addresses.byName[nombre]` →
   `defaults.BPAddress` → se omite. Que el payload gane es lo que permite que un tenant que necesite
   dos direcciones con el mismo `AddressName` pero tipo distinto simplemente mande `AddressType`
   desde el workflow, sin que la config interfiera.
2. **Unión con `byName`:** el `AddressName` de cada entrada se normaliza (trim + minúsculas) y se
   busca así en `byName`; las llaves de `byName` y los valores de `required` se normalizan igual.
3. **`AddressName` enviado a SAP:** el del payload con trim, **no** el de la config.
4. **`AddressName` ausente de `byName`:** la dirección se crea con lo mapeado + `defaults.BPAddress`,
   más un warning.

Ausencia total de la clave = comportamiento actual exacto.

### `propertiesFlags` — bidireccional (el spec SAP→HubSpot la reutiliza)

```js
{
  key: 'propertiesFlags',
  userUpdated: 'admin',
  value: {
    strategy: 'numberedMultiSelect',   // 'none' (default) | 'numberedMultiSelect'
    hubspotProperty: 'groupname',      // propiedad multi-select en HubSpot
    min: 1,
    max: 64,
    trueValue: 'tYES',
  },
}
```

Ambas claves se documentan en `configuration_examples.md` con el formato del catálogo (detalle en
prosa + el documento literal) y se siembran apagadas en
`src/infrastructure/tenants/tenantProvisioning.js:83-157`.

## FieldMappings

Un solo valor nuevo en el enum de `sourceContext` (`FieldMapping.js:16-27`): **`'bpAddress'`**.

| Qué | `objectType` | `sourceContext` | Estado |
|---|---|---|---|
| Encabezado del BP cuando el BP es una empresa | `company` | `businessPartner` | **ya existe** (`TenantWebhookRuntimeRepository.js:47`) |
| Encabezado del BP cuando el BP es una persona | `contact` | `businessPartner` | **ya existe** (`:48`) |
| ContactEmployees | `contact` | `contactEmployee` | **ya existe** (`:49`) |
| Direcciones | `address` | `bpAddress` | **nuevo** |

Que el encabezado ya tenga dos juegos (company y contact) es lo que hace que un BP-persona
funcione sin cambios: el adapter resuelve cada campo como `mappedCompany?.X || mappedContact?.X`.
Y un ContactEmployee siempre es un contacto de HubSpot, sin importar si el BP es empresa o persona,
así que su contexto tampoco cambia.

Ejemplo de filas de dirección:

```js
{ sourceField: 'Street',  targetField: 'direccion', objectType: 'address', sourceContext: 'bpAddress', isActive: true }
{ sourceField: 'County',  targetField: 'ciudad',    objectType: 'address', sourceContext: 'bpAddress', isActive: true }
{ sourceField: 'ZipCode', targetField: 'zip',       objectType: 'address', sourceContext: 'bpAddress', isActive: true }
```

Recordar la dirección de las columnas: `sourceField` es el campo de **SAP** y `targetField` la
propiedad de **HubSpot** (`mapHubspotToSapFields` hace `mapped[sourceField] = pickByPath(source, targetField)`).

**Cómo se mapea el array:** las direcciones se mapean **una entrada a la vez**, llamando
`mapHubspotToSapFields(entrada, addressMappings)` por cada elemento de `payload.bpAddress` — mismo
patrón que usa hoy `applyDealWebhookMapping` con `line_items`
(`src/application/services/field-mapping.service.js:273-282`). El resultado es un array de objetos
ya con nombres de campo de SAP.

**El fallback a `businessPartner` debe quedar apagado** al leer estos mappings:

```js
mappingService.getMappingsByObjectType(
  hubspotCredentialId, 'address', 'bpAddress', tenantModels,
  { allowBusinessPartnerFallback: false }
)
```

Sin `allowBusinessPartnerFallback: false`, un tenant sin filas `bpAddress` recibiría las filas de
contexto `businessPartner` y filtraría campos de encabezado (`CardName`, `CardCode`, `DocEntry`…)
dentro de cada `BPAddresses[]`. Es exactamente el riesgo que ya documenta el comentario de
`TenantWebhookRuntimeRepository.js:68-70` para el contexto de inventory transfer request.

## Arquitectura

Se sigue el molde de strategy que ya está establecido en este repositorio (puerto + constantes +
factory + repositorio de config), tal como lo usan `warehouse-stock-strategy.port.js`,
`warehouse-stock-strategy.factory.js`, `WarehouseStockConfigRepository.js` y su cableado en
`src/composition/sap-sync.composition.js:69-97`.

### Puertos

```js
// src/application/ports/sap/business-partner-payload-strategy.port.js
createPort({
  name: 'BusinessPartnerPayloadStrategyPort',
  methods: ['buildCreatePayload', 'includesContactEmployeesInCreate'],
})
```

`buildCreatePayload({ mappedBusinessPartner, mappedAddresses, mappedContactEmployees, propertiesFlags, defaults, resolved })`
devuelve el objeto listo para el POST. `resolved` lleva lo que ya calcula hoy el adapter
(`cardName`, `resolvedCardCode`, `resolvedPriceListNum`, `resolvedPayTermsGrpCode`,
`resolvedDefaultSeries`, `companyExists`).

`includesContactEmployeesInCreate()` devuelve un booleano para que el use-case sepa si debe saltarse
`addContactEmployeeIfNeeded` tras una creación, en vez de inferirlo del nombre de la strategy.

### Módulos nuevos

Dominio puro, sin I/O, bajo `src/domain/business-partners/` (la carpeta ya existe, contiene
`upsert-sap-fields.service.js`):

- `business-partner-creation.constants.js` — claves de config, nombres de strategy, defaults.
- `business-partner-payload.factory.js` — nombre → instancia; lanza con la lista de válidas si no
  existe, igual que `WarehouseStockStrategyFactory`.
- `strategies/legacy-whitelist-bp-payload.strategy.js` — el whitelist actual, sin cambios de
  conducta.
- `strategies/full-mapped-bp-payload.strategy.js` — todo lo mapeado + defaults + `BPAddresses` +
  `ContactEmployees` + `PropertiesN`.
- `bp-addresses.service.js` — construye el array de direcciones desde el array del payload ya
  mapeado, uniendo por `AddressName` contra `byName`, y valida `required`.
- `sap-properties-flags.service.js` — bidireccional:
  - `buildSapPropertiesFlags({ hubspotValue, config })` → `{ Properties1: 'tYES', Properties55: 'tYES' }`
  - `readSapPropertiesFlags({ sapRecord, config })` → `'1;2;55'` (se diseña aquí, lo consume el spec SAP→HubSpot)
- `contact-employee-source.service.js` — resuelve `{ businessPartnerSource, businessPartner, contactEmployeeSources[] }`
  según `contactEmployeeSource`, y lanza `PermanentWebhookError` si no hay company ni contact.

Infraestructura:

- `src/infrastructure/config/BusinessPartnerCreationConfigRepository.js` — lee ambas claves; ante
  fallo devuelve los defaults y **nunca** lanza, igual que `WarehouseStockConfigRepository.js:43`.

### Resolución de BP y CE

| Caso | `dealContact` (default, = hoy) | `payloadArray` (nuevo) |
|---|---|---|
| company + contact | BP = company; CE = `[contact]` | BP = company; CE = `payload.contactEmployees`; el contact del deal **se ignora** |
| solo contact | BP = contact; CE = `[]` | BP = contact; CE = `payload.contactEmployees` |
| solo company | BP = company; CE = `[]` | BP = company; CE = `payload.contactEmployees` |
| ninguno de los dos | `PermanentWebhookError` explícito | igual |

Bajo `payloadArray`, si `contactEmployees` no viene o llega vacío: `CE = []` más un warning en el
audit del `WebhookEvent` con código propio. **Sin** fallback al contact del deal.

Esta decisión vive hoy inline y duplicada en tres archivos —
`ProcessHubspotWebhookEvent.js:74`, `webhookQuotationSupport.js:141` y
`ProcessHubspotInventoryTransferRequest.js:46`, todos con la expresión
`companyExists: companyExists || !contactExists`. Se extrae al servicio de dominio compartido y los
tres pasan a llamarlo.

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| Nombre de strategy desconocido en la config | Lanza con la lista de válidas, **antes** de cualquier escritura a SAP |
| Falla la lectura de la config | Se usan los defaults (`legacyWhitelist`, `dealContact`, `none`); nunca lanza |
| Falta un `AddressName` declarado en `addresses.required` | `PermanentWebhookError` antes del POST |
| `AddressName` presente en el payload pero ausente de `byName` | Se crea la dirección solo con lo mapeado + warning |
| Valor de `Properties` no numérico, fuera de `[min,max]` o duplicado | Se ignora ese valor + warning; nunca tumba el webhook |
| `hubspotProperty` ausente del payload | No se envía ningún `PropertiesN` |
| `CardName` no resoluble | `PermanentWebhookError`, como hoy (`SapWebhookOrderAdapter.js:264-266`) |
| Deal sin company y sin contact | `PermanentWebhookError` con mensaje explícito |
| Tenant con `sapFlavor` distinto de B1 y `payloadStrategy: 'fullMapped'` | Se ignora la strategy, se usa `legacyWhitelist` + warning |

Todo el armado del payload es dominio puro: no puede fallar por I/O, solo por configuración
inválida, y en ese caso falla antes de escribir en SAP.

## Pruebas

Todo lo nuevo es dominio puro y se prueba unitariamente en `tests/unit/domain/`, siguiendo la
convención de `warehouseStockStrategyFactory.test.js` y `upsertSapFields.test.js`. Jest necesita
`--experimental-vm-modules` en este proyecto.

Casos obligatorios:

1. **Guardia de regresión (la más importante):** con la config ausente, `legacyWhitelist` produce un
   payload idéntico campo por campo al que produce hoy `SapWebhookOrderAdapter.js:268-299`, para los
   tres casos de asociación.
2. **Aceptación:** con la config del cliente y el payload de ejemplo, `fullMapped` produce
   exactamente el JSON objetivo de la sección "Problema".
3. `Properties`: valores válidos, string con `;`, array, no numéricos, fuera de rango, duplicados,
   vacío, propiedad ausente, `strategy: 'none'`.
4. Direcciones: 1 entrada, 2 entradas, N entradas, `AddressName` fuera de `byName`, `required`
   incumplido, campos mapeados en blanco, `AddressType` viniendo del payload (debe ganar sobre la
   config).
5. Resolución BP/CE: los cuatro casos de la tabla × las dos strategies, incluido
   `contactEmployees` ausente y vacío.
6. Precedencia: payload gana sobre default de config; valor vacío en el payload cae al default;
   ausencia total omite el campo (no manda `null`).
7. `serviceLayerUrlBuilder`: un mapping con `sourceContext: 'bpAddress'` **no** aparece en el
   `$select` generado.

## Archivos afectados

### Modificados

| Archivo | Qué cambia |
|---|---|
| `src/infrastructure/database/models/tenant/FieldMapping.js:16-27` | Agregar `'bpAddress'` al enum de `sourceContext` |
| `src/infrastructure/sap/serviceLayerUrlBuilder.js:28-31` | Excluir también `'bpAddress'` del `$select` |
| `src/infrastructure/sap/SapWebhookOrderAdapter.js:154-321` | `findOrCreateBusinessPartner` delega el armado del payload a la strategy; recibe los mappings/config nuevos |
| `src/infrastructure/sap/SapWebhookOrderAdapter.js:368-453` | `addContactEmployeeIfNeeded` pasa a aceptar una lista de contactos, no uno solo |
| `src/application/services/webhook-payload.service.js:3-14` | Exponer `contactEmployees` y `bpAddress` |
| `src/application/services/webhook-payload.service.js:44-83` | `internalCode` a cada CE real, no al contact del deal |
| `src/application/use-cases/ProcessHubspotWebhookEvent.js:62-74, 134-143` | Usar el servicio de resolución BP/CE; saltar el PATCH de CE si fueron en el POST |
| `src/application/use-cases/webhookQuotationSupport.js:128-141, 197-217` | Lo mismo |
| `src/application/use-cases/ProcessHubspotInventoryTransferRequest.js:46-47` | Lo mismo |
| `src/infrastructure/database/repositories/TenantWebhookRuntimeRepository.js:33-92` | Agregar los mappings `address`/`bpAddress` al bundle y los resolvers de las dos claves nuevas |
| `src/composition/webhook-processing.composition.js` | Cablear factory, strategies y repositorio de config con `assertPort` |
| `src/infrastructure/tenants/tenantProvisioning.js:83-157` | Sembrar las dos claves apagadas |
| `configuration_examples.md` | Documentar las dos claves nuevas |

### Nuevos

- `src/application/ports/sap/business-partner-payload-strategy.port.js`
- `src/domain/business-partners/business-partner-creation.constants.js`
- `src/domain/business-partners/business-partner-payload.factory.js`
- `src/domain/business-partners/strategies/legacy-whitelist-bp-payload.strategy.js`
- `src/domain/business-partners/strategies/full-mapped-bp-payload.strategy.js`
- `src/domain/business-partners/bp-addresses.service.js`
- `src/domain/business-partners/sap-properties-flags.service.js`
- `src/domain/business-partners/contact-employee-source.service.js`
- `src/infrastructure/config/BusinessPartnerCreationConfigRepository.js`
- `tests/unit/domain/businessPartnerPayloadStrategies.test.js`
- `tests/unit/domain/bpAddresses.test.js`
- `tests/unit/domain/sapPropertiesFlags.test.js`
- `tests/unit/domain/contactEmployeeSource.test.js`
- `tests/unit/infrastructure/businessPartnerCreationConfigRepository.test.js`

## Fuera de alcance

- **Dirección SAP → HubSpot** (cargar BPAddresses/ContactEmployees hacia HubSpot, `Properties1..64`
  inverso, reglas jurídico/persona). Va en el spec hermano, que reutiliza
  `sap-properties-flags.service.js` y la clave `propertiesFlags`.
- **S/4 HANA.** Requiere POSTs separados por dirección y BP relationships.
- **Actualizar direcciones y `PropertiesN` de un BP que ya existe.** Este spec solo cubre la
  creación. Para actualizar campos de un BP existente ya está `upsertDataSAP`
  (`src/infrastructure/config/upsertDataSap.config.js`), que no se toca: su
  `fieldsUpdated_BP` es una lista plana de campos escalares y no sabe de arrays anidados ni de la
  expansión 1→N de `PropertiesN`. Si el cliente necesita actualizar direcciones de un BP existente,
  es un spec aparte.
- **Unificar la duplicación** entre `ProcessHubspotWebhookEvent` y `webhookQuotationSupport`.
- **Segunda strategy de direcciones** (ej. leerlas de las propiedades de la company en vez de un
  array). El puerto queda listo, pero no se implementa sin un cliente que la necesite.
