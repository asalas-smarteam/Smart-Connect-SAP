# 13. Mapeo de responsables (N1 a N4)

Pedido del front, plan 5b (`docs/plans/2026-11-19-panel-mapeo-responsables.md`). Reglas comunes en
[`00-reglas-generales.md`](00-reglas-generales.md). **Solo lectura.** Fuente: la colección
`OwnerMappings` del tenant (la que usa `ManageOwnerMappings`). Es la misma idea que
[`08-mapeo-campos.md`](08-mapeo-campos.md).

## N1. Endpoints

- Cliente: `GET /owner-mappings` (los de su empresa).
- Smarteam: `GET /staff/tenants/:tenantKey/owner-mappings` (`tenantKey` inexistente → 404, igual
  que Eventos, Syncs, Mapeo de campos y Tareas programadas).
- Sin paginar ni filtros: **todos** los registros de la empresa, activos e inactivos, en
  `{ "items": [...] }`. El front ordena, filtra y pagina.

## N2. Cada registro

Los datos van **tal cual están en la base**, solo con los nombres de campo genéricos (regla de
nombres de `00-reglas-generales.md`: el front no usa nombres de sistemas):

```json
{
  "items": [
    {
      "id": "6a6b94a1cd7c01b21aa58c41",
      "crmOwnerId": "82929225",
      "crmOwnerName": "Erick Figueroa Pavon",
      "crmOwnerEmail": "ventas8@distelsanic.com",
      "erpOwnerId": 53,
      "erpOwnerName": null,
      "erpEmployeeId": 67,
      "active": true,
      "source": "crm_seed",
      "createdAt": "2026-07-03T02:03:51.125Z",
      "updatedAt": "2026-07-03T02:03:51.125Z"
    }
  ]
}
```

| Campo en la base       | Campo en la respuesta | Notas                                                    |
| ---------------------- | --------------------- | -------------------------------------------------------- |
| `_id`                  | `id`                  | Como texto.                                              |
| `hubspotOwnerId`       | `crmOwnerId`          | Texto, tal cual.                                         |
| `hubspotOwnerName`     | `crmOwnerName`        | Texto o `null`.                                          |
| `hubspotOwnerEmail`    | `crmOwnerEmail`       | Texto o `null`.                                          |
| `sapOwnerId`           | `erpOwnerId`          | Número tal cual (o `null` si no tiene). Es el vendedor.   |
| `sapOwnerName`         | `erpOwnerName`        | Texto o `null`.                                          |
| `sapOwnerId_2`         | `erpEmployeeId`       | Número tal cual (o `null`). Es el empleado (digitador).   |
| `active`               | `active`              | Booleano.                                                |
| `source`               | `source`              | `hubspot_seed` → **`crm_seed`**; los demás valores tal cual, siempre que no lleven nombres de sistemas. |
| `createdAt`/`updatedAt`| igual                 | ISO 8601.                                                |

- **No se mandan** `hubspotCredentialId`, `__v` ni ningún otro campo interno.
- Si un campo no existe en el documento, mandarlo como `null` (el front muestra "—").

## N3. Permiso

- Se usa el permiso que ya existe **`mappings.read`** (cliente admin, cliente usuario y
  Smarteam), el mismo de Mapeo de campos: no hace falta un permiso nuevo ni cambiar `/auth/me`.
- Sin el permiso → 403 `forbidden`, como el resto del panel.

## N4. Pruebas que esperamos

- Cliente: solo los de su tenant; Smarteam: los del `tenantKey` pedido; `tenantKey` inexistente → 404.
- Renombre de campos de N2, `hubspot_seed` → `crm_seed`, sin `hubspotCredentialId` ni `__v`.
- Campos ausentes → `null`; activos e inactivos incluidos.
- Sin `mappings.read` → 403.

---

## Ejecución (backend, plan 11)

> **Estado:** ejecutado a pedido del usuario ("ejecuta el plan 2026-11-19-13-mapeo-responsables.md").
> Aplica a todos los tenants (B1 y S4HANA).

Mismo patrón que el mapeo de campos (plan 6). Archivos:

- **Nuevos:**
  - `src/domain/panel/ownerMappingView.js`: renombre de N2, `hubspot_seed` → `crm_seed` y campo
    ausente → `null`;
  - el puerto `src/application/ports/panel/owner-mapping-reader.port.js`;
  - `src/application/use-cases/panel/PanelOwnerMappings.js`, que usa `resolveScopeTenant`;
  - `src/interfaces/http/controllers/panelOwnerMappings.controller.js`.
- **Modificados:**
  - `TenantOperationsReader.listOwnerMappings`: lista blanca, orden
    `hubspotOwnerName, _id`, `maxTimeMS` y tope de 5000;
  - `panelPlugin.js`: las dos rutas, con `mappings.read`;
  - `panel.composition.js`: `buildPanelOwnerMappingUseCases` y el parámetro `ownerMappingReader`.
- **Pruebas:**
  - nuevas: `panelOwnerMappingView`, `panelOwnerMappings`, `panelOwnerMappingsApi` y la
    integración `panelOwnerMappings`, que corrió y pasó;
  - ampliadas: `panelOperationsReader` y `routeAuthWiring`, más un lector falso en
    `operationFakes`.
- Contrato copiado con la nota del backend; README sección 20.

**Desvío respecto del contrato:** N2 dice que `erpOwnerId` y `erpEmployeeId` son números.

- En el modelo (`OwnerMapping.js`) son **texto** y pueden traer varios códigos separados por
  coma (`'113,758,864'`).
- Se mandan tal cual están guardados, como pide la regla general de N2.
- El front debe aceptar texto, número o `null`. Queda anotado en la nota del contrato.
