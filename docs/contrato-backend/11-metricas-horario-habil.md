# 11. Métricas de soporte en horario hábil (L1 a L5)

Pedido del front, plan 4x (`docs/plans/2026-11-02-panel-metricas-horario-habil.md`). Reglas
comunes en [`00-reglas-generales.md`](00-reglas-generales.md). Cambia **cómo se calculan** los
tiempos de [`05-tableros-y-metricas.md`](05-tableros-y-metricas.md) (F7 a F9), **no la forma** de
la respuesta.

## L1. Regla del horario hábil

Solo cuenta el tiempo de **lunes a viernes, de 8:00 a 17:00, hora de Costa Rica**
(`America/Costa_Rica`). No cuentan:

- sábados ni domingos;
- antes de las 8:00 ni desde las 17:00;
- feriados: **no se descuentan por ahora** (un feriado entre semana cuenta como día hábil).

Costa Rica no tiene horario de verano (siempre UTC−6), así que alcanza con un offset fijo; si se
usa la zona horaria con una librería, mejor.

Ejemplos (hora de Costa Rica):

| Desde              | Hasta              | Tiempo hábil | Por qué                                 |
| ------------------ | ------------------ | ------------ | --------------------------------------- |
| mié 09:00          | mié 11:30          | 2 h 30       | dentro del horario                      |
| mié 06:00          | mié 19:00          | 9 h          | solo cuenta de 8:00 a 17:00             |
| mié 18:00          | mié 22:00          | 0            | todo fuera de horario                   |
| vie 16:00          | lun 09:00          | 2 h          | 1 h del viernes + 1 h del lunes         |
| sáb 10:00          | lun 10:00          | 2 h          | empieza a contar el lunes a las 8:00    |
| sáb 08:00          | dom 18:00          | 0            | fin de semana                           |
| mar 17:30          | mié 08:30          | 30 min       | solo la media hora del miércoles        |
| lun 08:00          | vie 17:00          | 45 h         | 5 días de 9 h                           |
| jue 09:00          | mar 13:00          | 31 h         | 8 + 9 + (fin de semana) + 9 + 5         |
| igual o invertido  |                    | 0            | nunca negativo                          |

Función pura sugerida, en `domain/panel/` y con estos casos como test:

```js
// Segundos hábiles entre dos instantes (ms). 0 si `to` no es posterior a `from`.
export function businessSeconds(fromMs, toMs) {
  if (!(toMs > fromMs)) return 0;
  const OFFSET = -6 * HOUR_MS; // Costa Rica, sin horario de verano
  const start = fromMs + OFFSET;
  const end = toMs + OFFSET;
  let total = 0;
  for (let day = Math.floor(start / DAY_MS) * DAY_MS; day < end; day += DAY_MS) {
    const weekday = new Date(day).getUTCDay(); // 0 domingo, 6 sábado
    if (weekday === 0 || weekday === 6) continue;
    const counted = Math.min(end, day + 17 * HOUR_MS) - Math.max(start, day + 8 * HOUR_MS);
    if (counted > 0) total += counted;
  }
  return total / 1000;
}
```

(Es la misma que usa la API simulada del front: `src/mocks/business-time.js`.)

## L2. Dónde se aplica

En `ticketMetrics.js`, `resolutionSeconds` y `firstResponseSeconds` pasan a
`businessSeconds(openedAt, resolvedAt)` y `businessSeconds(openedAt, firstResponseAt)`. Con eso
cambian, en `/tickets/metrics` y `/staff/tickets/metrics`:

- `totals.medianFirstResponseSeconds` y `totals.medianResolutionSeconds`;
- `byWeek[].medianResolutionSeconds`;
- `byCategory[].medianResolutionSeconds`;
- `byTenant[].medianFirstResponseSeconds` y `byTenant[].medianResolutionSeconds`;
- `buckets` (L3).

No cambian: qué tickets entran en cada período, el agrupado por semana (por la fecha de
resolución en la zona pedida), los conteos ni `period`.

## L3. Rangos de resolución (`buckets`)

En tiempo hábil, con **un día hábil = 9 h**. Las claves se mantienen:

| Clave    | Antes (tiempo corrido) | Ahora (tiempo hábil)     | Límites en segundos |
| -------- | ---------------------- | ------------------------ | ------------------- |
| `lt4h`   | < 4 h                  | < 4 h                    | `[0, 14400)`        |
| `4h_24h` | 4 a 24 h               | 4 h a 1 día hábil        | `[14400, 32400)`    |
| `1d_3d`  | 1 a 3 días             | 1 a 3 días hábiles       | `[32400, 97200)`    |
| `gt3d`   | > 3 días               | más de 3 días hábiles    | `[97200, ∞)`        |

## L4. Respuesta

Misma forma que F8: siguen siendo segundos (ahora hábiles). El front los muestra con días de 9 h
("2 d 2 h" = 20 h hábiles) y una nota "Tiempos en horario hábil: lunes a viernes de 8:00 a 17:00
(hora de Costa Rica)".

## L5. Pruebas que esperamos

- `businessSeconds` con todos los casos de la tabla de L1.
- Métricas con tickets de prueba: un ticket abierto el viernes 9:00 y resuelto el jueves
  siguiente 15:00 da 42 h hábiles (`gt3d`); uno respondido el domingo da 0 de primera
  respuesta; las medianas y los rangos usan los segundos hábiles.
- Los datos de ejemplo de la API simulada (`src/mocks/handlers/metrics.test.js`) sirven de
  referencia: con los mismos tickets, el backend debería dar los mismos números.

## Despliegue

Front y backend juntos: si sale solo el front, muestra "días hábiles" sobre tiempos que el backend
aún calcula corridos.

## Nota del backend (plan 9)

Plan: `docs/superpowers/plans/2026-11-02-panel-metricas-horario-habil.md`. Implementado L1 a L5.
La forma de la respuesta no cambió.

- `businessSeconds` vive en `src/domain/panel/businessTime.js`. Es la misma regla que
  `src/mocks/business-time.js`: UTC−6 fijo, de 8:00 a 17:00, lunes a viernes y sin feriados.
- Si una fecha falta o no es válida, cuenta 0 (antes daba `NaN`).
- **Paridad:** los 9 tickets de `src/mocks/handlers/metrics.test.js` dan los mismos números en
  el backend (prueba en `tests/unit/domain/panelSummaries.test.js`).
- Front y backend salen juntos.
