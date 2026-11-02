# Panel — Plan 9: métricas de soporte en horario hábil (pedido 4x del front, L1 a L5) — Plan de implementación

> **Estado:** aprobado por el usuario ("apruebo") y ejecutado.

**Goal:** que los tiempos de las métricas de tickets (F7 a F9) cuenten solo el horario hábil:
lunes a viernes, de 8:00 a 17:00, hora de Costa Rica. Los rangos de resolución pasan a días
hábiles de 9 h. **La forma de la respuesta no cambia.**

**Contrato:** `docs/contrato-backend/11-metricas-horario-habil.md`. Ya está en este repo, sin
commit, e igual al del front.

**Depende de:** plan 5 (F7 a F9, `src/domain/panel/ticketMetrics.js`).

## Global Constraints

- Solo el cálculo del dominio del panel. No cambian:
  - rutas, permisos ni lectura de tickets (`TicketMetrics.js`, `listForMetrics`);
  - qué tickets entran en cada período, el agrupado por semana, los conteos ni `period`.
- No toca el núcleo ni los tickets guardados.
- `main`, sin ramas. Sin `git add`, `commit` ni `push`. Al terminar, dejar en el chat qué cambió,
  en qué archivos y por qué.

## Aplica a qué tenant

A todos: las métricas de soporte de cliente (`/tickets/metrics`) y de Smarteam
(`/staff/tickets/metrics`).

## Hechos verificados

| Hecho | Dónde |
|---|---|
| Hoy los tiempos son corridos: `resolvedAt − openedAt` y `firstResponseAt − openedAt`, en segundos | `ticketMetrics.js` (`resolutionSeconds`, `firstResponseSeconds`) |
| Los rangos hoy son 4 h, 24 h y 72 h | `BUCKETS` en el mismo archivo |
| Esas dos funciones alimentan todas las medianas (totales, `byWeek`, `byCategory`, `byTenant`) y los `buckets`. Cambiarlas ahí cubre todo L2 | `metricsRow` y `ticketMetrics` |
| La API simulada del front ya calcula así (`src/mocks/business-time.js`). Su prueba `handlers/metrics.test.js` trae 9 tickets con los números esperados | repo del front (solo lectura) |
| Las expectativas actuales de `panelSummaries.test.js` usan tiempo corrido y **van a cambiar** | ver "Pruebas" |

## Decisiones (cambiables antes de aprobar)

1. **Función pura nueva**: `src/domain/panel/businessTime.js`, con `businessSeconds(fromMs, toMs)`
   y `BUSINESS_DAY_SECONDS = 32400`.
   - Misma lógica que la del contrato y la del front: offset fijo UTC−6 (Costa Rica no tiene
     horario de verano), de 8:00 a 17:00, lunes a viernes, sin feriados.
   - Devuelve 0 si `to` no es posterior a `from`, o si alguna fecha falta o es inválida. Hoy eso
     daría `NaN`.
   - Una prueba confirma con `Intl` que `America/Costa_Rica` es UTC−6 en varias fechas, para
     enterarnos si algún día cambia.
2. **`ticketMetrics.js`:**
   - `resolutionSeconds` y `firstResponseSeconds` usan `businessSeconds`;
   - `BUCKETS` en segundos hábiles: `[0, 14400)`, `[14400, 32400)`, `[32400, 97200)` y
     `[97200, ∞)`, con las mismas claves;
   - el comentario de cabecera pasa de "tiempo corrido" a "horario hábil".
3. **Costo:** el cálculo recorre los días entre las dos fechas. Un ticket abierto un año son unas
   365 vueltas de aritmética; con los topes actuales de `listForMetrics` no hace falta optimizar.
4. **Feriados:** fuera, como dice el contrato. Si después se agregan, sería una lista en esta
   misma función.

## Archivos

| Archivo | Acción |
|---|---|
| `src/domain/panel/businessTime.js` | Crear |
| `src/domain/panel/ticketMetrics.js` | Modificar: tiempos hábiles y rangos |
| `tests/unit/domain/panelBusinessTime.test.js` | Crear: los 10 casos de la tabla L1, fechas inválidas y la prueba de la zona |
| `tests/unit/domain/panelSummaries.test.js` | Modificar las expectativas de F8 (abajo) y agregar la prueba de paridad |
| `docs/contrato-backend/11-metricas-horario-habil.md` | Nota del backend |
| `README.md` | Sección 20, una línea |

## Pruebas

- **`businessSeconds`:** los 10 casos de L1, entre ellos:
  - vie 16:00 → lun 09:00 = 2 h;
  - jue 09:00 → mar 13:00 = 31 h;
  - igual o invertido = 0.
- **Métricas:**
  - viernes 9:00 → jueves siguiente 15:00 = 42 h hábiles (`gt3d`);
  - respondido en domingo = 0 de primera respuesta.
- **Paridad con la API simulada:** los mismos 9 tickets de `handlers/metrics.test.js`, que deben
  dar los mismos números; por ejemplo `medianResolutionSeconds` = 12,5 h, `byWeek` 8 h y 42 h y
  `medianFirstResponseSeconds` 3600.
- **Expectativas que cambian en `panelSummaries.test.js`:**
  - `totals.medianResolutionSeconds`: 90000 → **36000** (2 h y 18 h hábiles);
  - `byWeek[0].medianResolutionSeconds`: 90000 → **36000**;
  - `byCategory` `precios`: 172800 → **64800** (jueves 8:00 → sábado = 18 h hábiles);
  - `documentos` (7200), `medianFirstResponseSeconds` (3600) y los `buckets` no cambian.
- El resto de las pruebas del panel (caso de uso, HTTP y `routeAuthWiring`) deben seguir
  pasando sin cambios.

## Despliegue

Front y backend **juntos**. Si sale solo el front, muestra "días hábiles" sobre tiempos que el
backend todavía calcula corridos.

## Ejecución

Hecho según el plan, sin desvíos:

- **`src/domain/panel/businessTime.js` (nuevo):** `businessSeconds`, `BUSINESS_DAY_SECONDS` y
  `BUSINESS_UTC_OFFSET_MS`.
- **`src/domain/panel/ticketMetrics.js`:** `resolutionSeconds` y `firstResponseSeconds` en horario
  hábil; `BUCKETS` en 4 h, 1 y 3 días hábiles.
- **Pruebas:**
  - nueva: `panelBusinessTime.test.js`, con los casos de L1, el de 42 h, fechas inválidas, el día
    de 9 h y la zona UTC−6 comprobada con `Intl`;
  - `panelSummaries.test.js`:
    - expectativas de F8 actualizadas (90000 → 36000 y 172800 → 64800);
    - paridad con los 9 tickets de la prueba del front;
    - primera respuesta en domingo = 0.
- Contrato con la nota del backend y README sección 20.
