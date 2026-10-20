# 08. Mapeo de campos (I1 a I4)

Pedido del front, plan 4p (`docs/plans/2026-10-16-panel-mapeo-campos.md`). Reglas comunes en
[`00-reglas-generales.md`](00-reglas-generales.md). Fase 1: **solo lectura**.

## I1. Endpoints

- Cliente: `GET /field-mappings` (los de su empresa).
- Smarteam: `GET /staff/tenants/:tenantKey/field-mappings` (`tenantKey` inexistente → 404, igual
  que Eventos y Syncs).
- Sin paginar ni filtros: devuelve **todos** los mapeos de la empresa, activos e inactivos, en
  `{ "items": [...] }` (mismo formato que `GET /sync-tasks`, E8). El front filtra y pagina.
- Orden sugerido: `objectType`, `sourceContext`, `sourceField`.

## I2. Cada mapeo

```json
{
  "items": [
    {
      "id": "6a6b94a1cd7c01b21aa58c41",
      "sourceField": "QuantityOnStock",
      "targetField": "quantity",
      "objectType": "product",
      "sourceContext": "product",
      "isActive": true,
      "editable": false,
      "includeInSourceQuery": false,
      "userField": false
    }
  ]
}
```

- `id`: el `_id` del documento como texto (para soporte y para la futura edición).
- `sourceField`, `targetField`, `objectType`, `sourceContext`: tal como están guardados (texto o
  `null`; el front muestra "—").
- `isActive`, `editable`, `userField`: tal como están guardados.
- `includeInSourceQuery`: es `includeInServiceLayerSelect` con **nombre genérico** (regla de
  nombres de `00-reglas-generales.md`: el front no usa nombres de sistemas).
- **No se mandan** `clientConfigId` ni `hubspotCredentialId`, ni ningún otro campo interno.
- `editable` hoy solo se muestra; la edición (con `PATCH` y sus validaciones) será otro pedido.

## I3. Permiso

- Permiso nuevo `mappings.read` en `src/domain/panel/permissions.js`: para **admin y usuario**
  del cliente y para Smarteam.
- Sin el permiso → 403 `forbidden`, como el resto del panel. El front oculta el menú sin el
  permiso.

## I4. Pregunta para el backend

El índice único de `FieldMapping` incluye `hubspotCredentialId`: una empresa podría tener mapeos de
más de una conexión al CRM. Si eso pasa hoy en algún tenant, avisar: el front puede agrupar por
conexión si se agrega un campo genérico (por ejemplo `connection: { id, name }`). Si no pasa,
alcanza con I2.

## Nota del backend (plan 6)

Plan: `docs/superpowers/plans/2026-10-16-panel-mapeo-campos.md`. Implementado I1 a I3, solo lectura.

- Rutas, permiso y forma de cada ítem como arriba. `mappings.read` sale en `/auth/me` para admin,
  usuario y Smarteam. Cuenta cliente en la ruta de staff (o al revés) → 403 `forbidden`.
- Textos que faltan **o vienen vacíos** (`''`) → `null`. `sourceContext` tiene `''` por defecto
  en la base, así que puede llegar `null`.
- Booleanos que faltan en el documento → el valor por defecto del modelo (`isActive`, `editable`
  e `includeInSourceQuery` en `true`; `userField` en `false`): es lo que usa la integración.
- Tope de seguridad de 5000 mapeos por empresa; timeout de la consulta (5 s) → 400
  `validation_error`, como en Eventos.
- **I4:** pendiente de datos. El diseño lo permite (las credenciales del CRM son por tarea y los
  mapeos se replican por credencial), pero no se sabe si hoy pasa en algún tenant. Si pasa, se
  agregará `connection: { id, name }` con el id y el nombre de la **tarea** dueña de la conexión
  (los mismos de `GET /sync-tasks`), o `null` si no se encuentra. Hasta entonces, I2 sin
  `connection`.
