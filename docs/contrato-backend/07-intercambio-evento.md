# 07. Intercambio del evento (H1)

Pedido del front, plan 4i (`docs/plans/2026-10-14-panel-intercambio-evento.md`). Reglas comunes en
[`00-reglas-generales.md`](00-reglas-generales.md); eventos en [`03-eventos-y-syncs.md`](03-eventos-y-syncs.md).

## H1. Campo `exchange` en el detalle del evento

En `GET /events/:id` (cliente) y `GET /staff/tenants/:tenantKey/events/:id` (Smarteam):

```json
"exchange": {
  "received": { "portalId": "…", "deal": { "…": "…" }, "company": { "…": "…" }, "line_items": [] },
  "sent":     { "businessPartner": null, "contactEmployee": [], "order": { "…": "…" } },
  "response": { "businessPartner": { "…": "…" }, "contactEmployee": [], "order": null }
}
```

- `received` = `payload` del evento; `sent` = `sapAudit.payloadSap`; `response` = `sapAudit.responseSap`.
- Cada parte puede ser `null` (evento en cola o que no llegó a enviarse). `exchange` puede ser `null`.
- **Solo en el detalle**, no en la lista.
- **Vista de cliente:** quitar a cualquier profundidad las claves de credenciales (`Password`,
  `password`, `token`, `secret`, `apiKey`…). En las respuestas del ERP hoy vienen contactos con
  `"Password": "12017"`. Nada de `sapCalls`, rutas ni hosts internos.
- **Vista de Smarteam:** `exchange` puede ir sin sanear; `payload` y `audit` siguen como hoy con
  `staff.events.raw`.
- El front ya está listo: lee `exchange` (opcional) y muestra "Sin datos." en las partes `null`.

## Nota del backend (plan 5c, implementado)

Plan: `docs/superpowers/plans/2026-10-14-panel-intercambio-evento.md`. Lo guardado no cambia: el saneo se hace sobre una copia.

- `exchange` sale solo en el detalle. Con las tres partes en `null`, `exchange` es `null`.
- **Cuenta cliente.** Se quitan, a cualquier profundidad y sin distinguir mayúsculas:
  - claves que **contienen** `password`, `passwd`, `secret`, `token`, `apiKey`/`api_key`, `privateKey`, `credential`;
  - claves que **son** `pwd`, `pass`, `pin`, `auth`, `authorization`, `cookie`, `session`, `sessionId`, `sapCalls`, `path`, `url`, `uri`, `endpoint`, `host`, `hostname`, `baseUrl`, `serviceLayerUrl`;
  - claves que empiezan con `@odata` u `odata.`.
- **Cuenta cliente, textos:**
  - URLs → `[enlace]`; IPs y `host:puerto` → `[servidor]`. Correos, direcciones y nombres no se tocan;
  - textos de más de 5 000 caracteres, arrays de más de 1 000 ítems y profundidad mayor a 20 se cortan con `"[…]"`.
- **Smarteam:** `exchange` sin sanear. De la auditoría nunca se leen las llamadas internas (`sapCalls`); con `staff.events.raw`, `audit` sigue completo como antes.
