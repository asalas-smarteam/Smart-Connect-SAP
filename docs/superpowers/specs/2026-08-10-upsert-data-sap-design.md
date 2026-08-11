# upsertDataSAP — actualizar BusinessPartner y ContactEmployee en SAP B1 desde HubSpot

Fecha: 2026-08-10

## Problema

Hoy la información de contactos/empresas solo viaja de HubSpot a SAP cuando se procesa un webhook
de deal (`createDeal`, `createQuotation`, `inventoryTransferRequest`). Todo ese flujo desemboca en
`SapWebhookOrderAdapter.findOrCreateBusinessPartner()`
(`src/infrastructure/sap/SapWebhookOrderAdapter.js:106`): si el BusinessPartner **no** existe lo
crea; si **sí** existe, los returns tempranos devuelven el `CardCode` y no escriben absolutamente
nada en SAP (`requestPayload: null`). Lo mismo pasa con el ContactEmployee:
`addContactEmployeeIfNeeded()` (línea 247), cuando encuentra un empleado que hace match por email
o nombre (línea 277), retorna sin actualizarlo.

Un cliente de SAP Business One necesita corregir el nombre o el correo del contacto/empresa en
HubSpot y que ese cambio llegue a SAP. No existe hoy ningún camino para eso: el sync batch
existente (`mainDataInUpdate: 'SAP'`) solo corre en el flujo de sincronización masiva, no en los
webhooks de deal.

## Objetivo

Convertir el "find or create" en un **upsert controlado por configuración**: cuando el
BusinessPartner o el ContactEmployee ya existen, comparar los campos declarados en una nueva
configuración de tenant (`upsertDataSAP`) contra lo que llegó de HubSpot, y enviar un PATCH a SAP
solo si alguno de esos campos difiere. Sin romper el comportamiento de ningún tenant que no active
la config.

## Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Campos permitidos | Passthrough genérico: se manda literal lo que esté en la config | Máxima flexibilidad (sirve para `U_*`, `FederalTaxID`, `Phone1`, etc. sin tocar código); el tenant es responsable de usar nombres reales de SAP (`CardName`, no `Name`, para BusinessPartner) |
| Fallo del PATCH | No bloqueante: se registra en el audit trail y el flujo sigue creando la orden/cotización | El objetivo principal del webhook es el documento; un campo mal configurado no debe tumbar una orden |
| Origen del valor de HubSpot | `mappedCompany[campo] ?? mappedContact[campo]`. Si vienen company y contact, la company es el BP y el contact es el ContactEmployee; si solo viene uno de los dos, ese es el BP | Es la misma regla que ya usa el resto de `findOrCreateBusinessPartner` (`mappedCardCode`, `mappedEmail`) |
| Valor de HubSpot vacío o ausente | Se ignora ese campo; nunca se borra dato en SAP | Los webhooks solo mandan las properties que el workflow de HubSpot decidió incluir; un payload incompleto no debe vaciar SAP |
| Comparación | `trim()` + comparación exacta de texto (case-sensitive); si ambos lados son numéricos, se comparan como número | Evita disparar PATCHes por diferencias de formato (`3` vs `"3"`) sin esconder cambios reales de may/min |
| Alcance | Solo webhooks de deal (`createDeal`, `createQuotation`, `inventoryTransferRequest`) | El sync batch (`mainDataInUpdate: 'SAP'`) ya cubre otro caso de uso y no se toca para no afectar tenants que ya lo usan |
| Entidades | BusinessPartner y ContactEmployee | Es lo que pidió el cliente; ambas comparten el mismo endpoint PATCH de `/BusinessPartners('CardCode')` en B1 |

## La configuración

Documento en la colección `Configurations` del tenant (modelo
`src/infrastructure/database/models/tenant/Configuration.js`, `value` es `Mixed` → no hace falta
tocar el esquema):

```json
{
  "key": "upsertDataSAP",
  "value": {
    "required": true,
    "fieldsUpdated_BP": ["EmailAddress", "CardName"],
    "fieldsUpdated_CE": ["Name", "E_Mail"]
  }
}
```

- `required: false` (o el documento ausente) → comportamiento actual, sin cambios.
- `fieldsUpdated_BP` / `fieldsUpdated_CE` aceptan `null` o `[]` de forma independiente: puede
  activarse el upsert solo para BusinessPartner, solo para ContactEmployee, o para ambos.
- Los nombres son **campos SAP** (`CardName`, `EmailAddress`, `Name`, `E_Mail`, ...). La propiedad
  de HubSpot correspondiente sale de los `FieldMapping` existentes de cada tenant (recordar la
  semántica del repo: `sourceField` = campo SAP, `targetField` = propiedad HubSpot).
- Default cuando el documento no existe: `{ required: false, fieldsUpdated_BP: [], fieldsUpdated_CE: [] }`.

## Arquitectura

```
findOrCreateBusinessPartner()
  ├─ match por CardCode        -> ya existía; ahora también llama updateBusinessPartnerFields()
  ├─ match por defaultFindSAP  -> idem
  └─ creación                  (sin cambios: el BP recién creado ya trae la data de HubSpot)

updateBusinessPartnerFields({ sapConfig, cardCode, fields, mappedCompany, mappedContact })  (NUEVO)
  ├─ GET /BusinessPartners('cardCode')?$select=CardCode,<fields...>   (lectura propia, aislada)
  ├─ buildBusinessPartnerUpdatePayload()  (upsert-sap-fields.service.js)
  └─ si hay diferencias -> PATCH /BusinessPartners('cardCode')   (no bloqueante, try/catch)

addContactEmployeeIfNeeded()
  └─ rama "existing" (ya matcheó por email o nombre)
       ├─ ya existía: devolvía el InternalCode sin tocar SAP
       └─ NUEVO: buildContactEmployeeUpdatePayload() -> si hay diferencias, PATCH del array
          ContactEmployees completo con la entrada reemplazada (no bloqueante)
```

## Componentes

### 1. `src/infrastructure/config/upsertDataSap.config.js` — nuevo

Mismo patrón que `updateDealStage.config.js`: `UPSERT_DATA_SAP_CONFIG_KEY`,
`DEFAULT_UPSERT_DATA_SAP_CONFIG`, `normalizeUpsertDataSapConfig(value)`,
`getUpsertDataSapConfig({ tenantModels })` con `findOne().lean()`, nunca lanza.

El normalizador:
- Guard estándar: `if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT }`.
- `required = value.required === true || value.required === 'true'`.
- Cada lista (`fieldsUpdated_BP`, `fieldsUpdated_CE`): si no es array → `[]`; si lo es, `trim()`,
  descartar vacíos, descartar nombres que no matcheen `/^[A-Za-z_][A-Za-z0-9_]*$/` (evita paths con
  puntos que romperían el `$select` de la lectura propia), y deduplicar. Referencia:
  `normalizeB1WarehouseFields` en `src/domain/warehouses/strategies/b1-item-warehouse.strategy.js:43`.

### 2. `src/domain/business-partners/upsert-sap-fields.service.js` — nuevo

Lógica pura, sin infraestructura:

- `valuesDiffer(hubspotValue, sapValue)`: `false` si `hubspotValue` es `null`/`undefined`/`''`;
  comparación numérica si ambos lados son numéricos; si no, `String(x).trim()` exacto.
- `buildBusinessPartnerUpdatePayload({ fields, mappedCompany, mappedContact, sapBusinessPartner })`:
  objeto solo con los campos que difieren (`{}` si no hay ninguno). Valor de HubSpot con
  `mappedCompany?.[f] ?? mappedContact?.[f]`.
- `buildContactEmployeeUpdatePayload({ fields, nextEmployee, existingEmployee })`: igual para
  ContactEmployee. Debe respetar el alias que ya aplica `resolveContactEmployeePayload`
  (`SapWebhookOrderAdapter.js:15`): `EmailAddress` se compara y se escribe sobre `E_Mail`, porque
  ContactEmployee no tiene `EmailAddress` en B1.

### 3. Métodos nuevos en `SapWebhookOrderAdapter`

**`updateBusinessPartnerFields({ sapConfig, cardCode, fields, mappedCompany, mappedContact })`**:
1. `GET /BusinessPartners('<cardCode>')?$select=CardCode,<fields...>` — lectura propia, separada
   del `$select` fijo de `findBusinessPartnerByCardCode`. Así un nombre de campo inválido en la
   config rompe solo esta lectura, nunca la resolución del `CardCode` que necesita la orden.
2. `buildBusinessPartnerUpdatePayload(...)`. Si el resultado es `{}` → `{ updated: false }`, sin
   llamar a SAP.
3. `PATCH /BusinessPartners('<cardCode>')` con solo los campos que difieren.
4. Todo en `try/catch`; retorna `{ updated, requestPayload, responsePayload, error }`, nunca lanza.

**Hook en `findOrCreateBusinessPartner`**: nuevo parámetro `upsertConfig` (valor ya resuelto). En
los dos returns tempranos (match por `cardCode` y por `defaultFindSAP`), si
`upsertConfig.required && fieldsUpdated_BP.length`, llamar a `updateBusinessPartnerFields` y
agregar `updateResult` al objeto de retorno.

**Hook en `addContactEmployeeIfNeeded`**: nuevo parámetro `upsertConfig`. En la rama `existing`,
si `upsertConfig.required && fieldsUpdated_CE.length`, construir el diff y, si no está vacío, PATCH
del BusinessPartner con el array `ContactEmployees` completo y la entrada modificada — misma
mecánica que el alta (línea 289), porque B1 reemplaza la colección hija completa. No hace falta un
GET extra: `findBusinessPartnerByCardCode` ya trae los `ContactEmployees` completos.

### 4. Cableado

- `TenantWebhookRuntimeRepository.js`: nuevo `resolveUpsertDataSap(tenantModels)` junto a los
  resolvers existentes (`resolveDefaultFindSAP` está en la línea 202).
- `ProcessHubspotWebhookEvent.js` (línea 64) y `webhookQuotationSupport.js` (línea 127): resolver
  la config **una sola vez por evento** y pasar el valor ya resuelto (`upsertConfig`) a
  `findOrCreateBusinessPartner` y `addContactEmployeeIfNeeded` — no un resolver como los otros
  cinco, para no leer Mongo dos veces por evento. Mismo criterio que `mainDataInUpdate` en
  `SendMappedItemsToHubspot`.
- Audit trail: `auditTrail.payload_SAP.businessPartnerUpdate` / `response_SAP.businessPartnerUpdate`
  y los equivalentes `contactEmployeeUpdate`, al lado de las asignaciones existentes.
- `tenantProvisioning.js` (`ensureTenantConfigurations`, línea 79): sembrar la key con
  `$setOnInsert` + `upsert:true` y `required: false`, igual que `updateDealStage`, para que el
  documento sea visible en la UI admin sin cambiar el comportamiento de ningún tenant existente.
- `configuration_examples.md`: agregar la entrada con el formato de 3 líneas que ya usa el archivo.

## Lo que no cambia

- `ProcessHubspotUpdateQuotation` — no toca BusinessPartner.
- `ProcessHubspotConvertQuotationToOrder` — reusa el `cardCode` del `SapDocumentLink` de la
  cotización, nunca llama a `findOrCreateBusinessPartner`.
- El sync batch `mainDataInUpdate: 'SAP'` (`sapUpdateService.updateBusinessPartnerInSapFromHubspot`)
  — sigue actualizando con todos los `FieldMapping` activos, sin el filtro de `upsertDataSAP`.
- La rama de creación de `findOrCreateBusinessPartner` — un BP recién creado ya trae la data de
  HubSpot, no hay nada que comparar.

## Manejo de errores

- `getUpsertDataSapConfig` nunca lanza; ante fallo de lectura devuelve el default desactivado.
- `updateBusinessPartnerFields` y el hook de `addContactEmployeeIfNeeded` envuelven todo en
  `try/catch`: si el `GET` o el `PATCH` fallan (campo inválido, timeout, etc.), se registra el
  error en el audit trail y el flujo del webhook continúa sin fallar la creación de la
  orden/cotización.

## Testing

**Nuevos**:
- `tests/unit/infrastructure/upsertDataSapConfig.test.js`: default, `required` como string
  `'true'`, listas `null`, dedup, descarte de nombres inválidos (paths con puntos).
- `tests/unit/domain/upsertSapFields.test.js`: sin diferencias → `{}`; valor de HubSpot vacío →
  ignorado; `3` vs `"3"` → sin diff; mayúsculas distintas → sí diff; alias
  `EmailAddress`/`E_Mail` en ContactEmployee; precedencia company/contact.

**Extendidos**:
- `tests/unit/infrastructure/sapWebhookOrderAdapter*.test.js`: config apagada → cero llamadas
  extra; sin diferencias → GET pero no PATCH; con diferencia → PATCH con solo ese campo; error de
  SAP → `updated:false` y el flujo continúa.
- `tests/unit/infrastructure/sapWebhookOrderAdapter.contactEmployee.test.js`: mismos casos para el
  hook de ContactEmployee.
- Tests de `ProcessHubspotWebhookEvent` / `webhookQuotationSupport` que mockean
  `findOrCreateBusinessPartner` / `addContactEmployeeIfNeeded`: ajustar para el nuevo parámetro
  `upsertConfig` y para las nuevas claves del audit trail.

## Verificación

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest
```

Comparar contra el baseline conocido de fallos preexistentes del repo antes de declarar verde.

**End to end** (flujo manual habitual del proyecto: dejar activa solo la config a probar,
`POST /sap-sync/run` no aplica aquí porque esto es webhook, se prueba con el endpoint de webhook):

1. Insertar en `Configurations` del tenant de prueba:
   `{ key: 'upsertDataSAP', value: { required: true, fieldsUpdated_BP: ['EmailAddress','CardName'], fieldsUpdated_CE: ['Name','E_Mail'] } }`.
2. Cambiar el nombre y/o el email de una empresa **ya existente en SAP** en HubSpot.
3. `POST /webhooks/hubspot/createDeal` con el payload de company + contact + deal y correr el
   worker.
4. Verificar en SAP que el `CardName`/`EmailAddress` del BP y el `Name`/`E_Mail` del
   ContactEmployee quedaron actualizados, y que la orden se creó igual.
5. Repetir sin cambiar nada en HubSpot → confirmar en el `WebhookEvent` (audit) que no hubo PATCH.
6. Poner un campo inválido en `fieldsUpdated_BP` → confirmar que la orden se sigue creando y el
   error queda registrado en el audit trail sin fallar el webhook.
7. Poner `required: false` → confirmar que no hay ninguna llamada extra a SAP.

## Fuera de alcance

- Sync batch (`mainDataInUpdate: 'SAP'`).
- SAP S/4HANA (el flujo de webhooks de deal es 100% B1 hoy).
- `ProcessHubspotUpdateQuotation` y `ProcessHubspotConvertQuotationToOrder`.
- UI de administración para editar `upsertDataSAP`.
- Actualización de campos anidados o colecciones distintas de `ContactEmployees` (direcciones,
  `U_*` en subniveles, etc.) — el passthrough cubre cualquier campo plano de `BusinessPartners`,
  pero no estructuras anidadas.
