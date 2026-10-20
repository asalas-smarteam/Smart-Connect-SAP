# Panel — Plan 6: Mapeo de campos (pedido 4p del front, I1 a I4) — Plan de implementación

> **Estado:** aprobado por el usuario ("apruebo plan") y ejecutado. I4 queda pendiente del Paso 0.

**Goal:** vista "Mapeo de campos" del panel, **solo lectura**: todos los mapeos de la empresa,
para cliente y para Smarteam.

**Contrato:** `smartHubPanel/docs/contrato-backend/08-mapeo-campos.md` (I1 a I4). Se copia a este
repo con la respuesta a I4.

**Depende de:** plan 3 (rutas por empresa de Eventos y Syncs, validación de `:tenantKey`).

## Global Constraints

- Solo capa del panel y solo lectura sobre `FieldMappings`. **No cambia el núcleo:**
  - ni el modelo `FieldMapping`, ni sus índices;
  - ni `field-mapping.service`, ni `ManageFieldMappings`, ni las rutas admin de mapeos.
- Sin `PATCH`. La edición (`editable: true`) va en un pedido aparte.
- `main`, sin ramas. Sin `git add`, `commit` ni `push`. Al terminar, dejar en el chat qué cambió,
  en qué archivos y por qué.

## Aplica a qué tenant

A todos (B1 y S4HANA). El contenido depende de los mapeos de cada tenant.

`sourceField` y `sourceContext` son nombres de propiedades del ERP (`QuantityOnStock`, `U_…`,
`ItemWarehouseInfoCollection`) y se muestran tal como están guardados, como pide I2. El nombre
genérico aplica a las claves del JSON, no a los valores.

## Hechos verificados en el código

| Hecho | Dónde |
|---|---|
| Colección `FieldMappings` con `sourceField`, `targetField`, `objectType`, `sourceContext` (default `''`), `clientConfigId`, `hubspotCredentialId` (default `null`), `isActive`, `editable` e `includeInServiceLayerSelect` (default `true`) y `userField` (default `false`) | `src/infrastructure/database/models/tenant/FieldMapping.js` |
| Índice único `{ hubspotCredentialId, objectType, sourceContext, sourceField }` | mismo archivo |
| Las credenciales del CRM son **por tarea** (`ClientConfig`): el OAuth guarda `HubspotCredentials` por `clientConfigId`. `HubspotCredentials` solo tiene `portalId` y tokens; no tiene nombre | `hubspotAuthService.exchangeCodeForTokens`, `HubspotCredentials.js` |
| Tras el OAuth se replican los mapeos por defecto con ese `hubspotCredentialId` | `HandleHubspotOAuthCallback` → `MasterConfigReplicatorAdapter` |
| La integración lee los mapeos con Mongoose: un booleano que falta en el documento toma su default del esquema | `TenantFieldMappingRepository` |
| Permisos por tabla; `/auth/me` devuelve `permissionsFor(...)` | `permissions.js`, `panelUserView.js`, `ResolvePanelSession.js` |
| Patrón de rutas cliente/staff con `requireClientAccount` / `requireStaffAccount` + `requirePermission` | `panelPlugin.js` (`OPERATION_ROUTES`) |

## I4: ¿hay tenants con mapeos de más de una conexión al CRM?

**Desde el código no se puede responder.** El diseño lo permite: hay una credencial por tarea, y
los mapeos se replican por credencial. Hay que mirar los datos. No me conecto a producción.

**Paso 0 (lo corres tú, solo lectura).** Imprime conteos, sin ids ni valores:

```js
// mongosh "<tu MONGODB_URI>" --quiet --eval '<esto>'
db.adminCommand({ listDatabases: 1, nameOnly: true }).databases
  .map((d) => d.name).filter((n) => n.startsWith('sap_integration_'))
  .forEach((n) => {
    const t = db.getSiblingDB(n);
    const byCred = t.FieldMappings.aggregate([
      { $group: { _id: { $ifNull: ['$hubspotCredentialId', null] }, total: { $sum: 1 } } },
    ]).toArray();
    print(n, JSON.stringify({
      mapeos: byCred.reduce((s, g) => s + g.total, 0),
      conexiones: byCred.filter((g) => g._id !== null).length,
      sinConexion: byCred.find((g) => g._id === null)?.total ?? 0,
      credenciales: t.HubspotCredentials.countDocuments(),
      tareas: t.ClientConfigs.countDocuments(),
    }));
  });
```

Según el resultado:

- **A. Todos con `conexiones` ≤ 1:** basta con I2. Es lo que este plan implementa.
- **B. Alguno con `conexiones` > 1:** se agrega a cada ítem `connection: { id, name }`. Es un
  cambio chico sobre este mismo plan y se aprueba aparte.
  - `id` es el id de la **tarea** dueña de la credencial (`HubspotCredentials.clientConfigId`). Es
    el mismo id que ya expone `GET /sync-tasks`.
  - `name` es el nombre de esa tarea (`clientName`).
  - Si la credencial no existe o no tiene tarea: `connection: null`.
  - Así no sale `hubspotCredentialId`, ni el `portalId`, ni los tokens.

## Decisiones (cambiables antes de aprobar)

1. **Rutas** (I1). Mismo patrón que `OPERATION_ROUTES`:
   - `GET /field-mappings`, con `requireClientAccount` + `mappings.read`;
   - `GET /staff/tenants/:tenantKey/field-mappings`, con `requireStaffAccount` + `mappings.read`.
   - El `:tenantKey` se valida contra el directorio de empresas **antes** de abrir la base. Si no
     existe: 404.
2. **Permiso** (I3). `MAPPINGS_READ: 'mappings.read'` para admin y usuario del cliente y para
   Smarteam. Sale solo en `/auth/me → permissions`. Sin el permiso: 403 `forbidden`.
3. **Lectura:**
   - driver nativo sobre `FieldMappings`, `find({})`;
   - **proyección explícita** solo con los 8 campos de I2 y `_id`; `clientConfigId` y
     `hubspotCredentialId` no salen de la base;
   - orden `objectType, sourceContext, sourceField, _id` y `maxTimeMS` 5000 (timeout → 400, como
     en Eventos);
   - tope de seguridad de 5000 documentos. Si se llega, se registra un aviso en el log; un tenant
     real tiene cientos.
4. **Vista** (I2), igual para cliente y Smarteam:
   - `id` = `_id` como texto;
   - textos tal como están guardados. Si faltan **o son `''`**: `null`. `sourceContext` tiene
     default `''`, y el front muestra "—" con `null`;
   - booleanos tal como están guardados. Si faltan, el default del esquema (`isActive`,
     `editable` e `includeInSourceQuery` en `true`; `userField` en `false`). Es lo mismo que ve
     la integración al leerlos con Mongoose;
   - `includeInSourceQuery` = `includeInServiceLayerSelect`;
   - empresa sin mapeos (o sin la colección): `{ "items": [] }`.
5. **Arquitectura** (replica la existente):
   - **puerto nuevo** `FieldMappingReaderPort` (`listFieldMappings(tenantKey)`);
   - lo implementa `TenantOperationsReader` con **un método nuevo**, para reusar su conexión y
     el manejo de timeout. `OperationsReaderPort` no cambia, ni sus fakes;
   - **caso de uso nuevo** `PanelFieldMappings`, con la misma resolución de tenant que
     `PanelOperations`. `PanelOperations` no se toca.

## Archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `src/domain/panel/permissions.js` | Modificar | + `MAPPINGS_READ` en staff y en los dos roles del cliente |
| `src/domain/panel/fieldMappingView.js` | Crear | `toFieldMappingView(raw)` |
| `src/application/ports/panel/field-mapping-reader.port.js` | Crear | Puerto de lectura |
| `src/infrastructure/database/repositories/TenantOperationsReader.js` | Modificar | + `listFieldMappings(tenantKey)` (proyección, orden, tope, `maxTimeMS`) |
| `src/application/use-cases/panel/PanelFieldMappings.js` | Crear | Resolver tenant, leer, armar `{ items }` |
| `src/interfaces/http/controllers/panelFieldMappings.controller.js` | Crear | Handler único cliente/staff |
| `src/interfaces/http/panel/panelPlugin.js` | Modificar | Las dos rutas |
| `src/composition/panel.composition.js` | Modificar | `buildPanelFieldMappingUseCases` y cableado |
| `docs/contrato-backend/08-mapeo-campos.md` | Copiar + nota | Contrato y respuesta a I4 |
| `README.md` | Modificar | Sección 20 |
| Pruebas | Crear / Modificar | Ver abajo |

## Pruebas

- **Dominio:**
  - vista con todos los campos;
  - textos faltantes o `''` → `null`;
  - booleanos faltantes → defaults del esquema;
  - `includeInSourceQuery`;
  - **nunca** `clientConfigId` ni `hubspotCredentialId`, aunque vengan en el documento;
  - permisos: `mappings.read` en admin, usuario y Smarteam (se actualizan las listas esperadas
    de `panelPermissions` y `sessionUseCases`).
- **Caso de uso:**
  - cliente → su empresa;
  - Smarteam con `tenantKey` válido;
  - `tenantKey` inexistente → 404 sin abrir la base;
  - empresa sin mapeos → `{ items: [] }`;
  - timeout → 400.
- **Lector:**
  - la proyección no incluye `clientConfigId` ni `hubspotCredentialId`;
  - orden, `maxTimeMS` y tope.
- **HTTP:**
  - cliente 200;
  - Smarteam 200 / 404;
  - sin permiso → 403;
  - cuenta de cliente en la ruta de staff y al revés → rechazada, como el resto
    (`routeAuthWiring`).
- **Integración** (Windows): tenant con mapeos activos e inactivos; respuesta ordenada y sin
  campos internos.

## Ejecución

Hecho según el plan, sin desvíos:

- `permissions.js`: `MAPPINGS_READ` para staff, admin y usuario.
- `fieldMappingView.js`, `field-mapping-reader.port.js`, `PanelFieldMappings.js`,
  `panelFieldMappings.controller.js`: nuevos.
- `TenantOperationsReader.listFieldMappings`: proyección explícita, orden, `maxTimeMS` y tope de
  5000 (+1 para detectar el corte).
- `panelPlugin.js`: las dos rutas. `panel.composition.js`: `buildPanelFieldMappingUseCases`,
  nuevo parámetro `fieldMappingReader` en `buildPanelUseCases`.
- Pruebas:
  - nuevas: `panelFieldMappingView`, `panelFieldMappings`, `panelFieldMappingsApi`, y la
    integración `panelFieldMappings` (Windows);
  - ampliadas: `panelOperationsReader`, `routeAuthWiring`;
  - actualizadas por el permiso nuevo: `panelPermissions`, `sessionUseCases`.
- Contrato copiado con la nota del backend; README sección 20.
- I4 sin resolver: falta correr el Paso 0.
