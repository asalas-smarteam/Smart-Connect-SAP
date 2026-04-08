# Examples

## Example 1 — Where should new API code go?

Request:
"Create CRUD for owner mappings"

Decision:
- Model: `src/db/models/tenant/OwnerMapping.js`
- Controller: `src/controllers/ownerMapping.controller.js`
- Route: `src/routes/ownerMapping.routes.js`
- Service: `src/services/ownerMapping.service.js`

Reason:
- model = persistence
- controller = HTTP
- route = endpoint registration
- service = business logic

---

## Example 2 — Should this go to utils?

Code:
- normalizeName(name)
- buildFallbackEmail(baseEmail, code)

Decision:
Move to:
- `src/utils/...`
or feature-local:
- `src/services/hubspot/utils/...`

Reason:
They are pure reusable helpers.

Do NOT move:
- tenant resolution
- DB queries
- API orchestration

---

## Example 3 — Controller style

Bad:
- controller validates everything
- controller calls DB directly
- controller builds external API payloads

Good:
- controller reads request
- controller calls service
- service executes business logic
- controller returns response

---

## Example 4 — "View" in this project

Since this is an API backend, "view" means:
- JSON response shape
- HTTP contract exposed in routes/controllers

Do NOT create:
- `src/views`
- `src/presenters`

Unless explicitly requested by the user.

---

## Example 5 — Refactor a god file

If a large file contains:
- HTTP handling
- business logic
- helper functions
- integration calls

Refactor into:
- controller in `src/controllers`
- service in `src/services`
- pure helpers in `src/utils`

Without adding unnecessary new layers.