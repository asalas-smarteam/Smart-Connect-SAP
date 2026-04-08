# API MVC Expert for This Project

## Purpose
Design and implement APIs in this project using pragmatic MVC with best practices.

This skill is specialized for the current project structure and MUST reuse existing folders instead of creating new architecture layers.

## Project structure to respect

- Models:
  - src/db/models/global/*
  - src/db/models/tenant/*
- Controllers:
  - src/controllers/*
  - src/controllers/master/*
- Routes:
  - src/routes/*
- Services:
  - src/services/*
  - src/services/master/*
  - src/services/tenant/*
  - src/services/hubspot/*
- Middleware:
  - src/middleware/*
- Utils:
  - src/utils/*
  - src/services/hubspot/utils/*
- Config/bootstrap/core:
  - src/config/*
  - src/bootstrap/*
  - src/core/*

## MVC interpretation for this project

Because this is an API backend, "View" should be interpreted as the HTTP response contract exposed through routes/controllers, not as server-rendered HTML.

Use this mapping:

- Model:
  - Mongoose/DB models in `src/db/models/...`
- View:
  - Route contract + response shape returned by controllers
- Controller:
  - HTTP layer in `src/controllers/...`
- Service:
  - Business logic and integrations in `src/services/...`

## Core principles

1. Reuse the existing folders.
2. Do not create new folders if an existing one already fits.
3. Keep controllers thin.
4. Keep services focused on business logic.
5. Keep models only for persistence/schema concerns.
6. Move reusable pure helpers to `src/utils` or feature-local `utils`.
7. Avoid over-validation and defensive code that adds noise without real value.
8. Avoid over-engineering and unnecessary layers.
9. Keep naming explicit and aligned with the current project.
10. Preserve compatibility with existing routing and service patterns.

## Responsibilities by layer

### Models
Use existing model folders only:
- `src/db/models/global`
- `src/db/models/tenant`

A model should:
- define schema
- define indexes
- define defaults
- define persistence-related concerns

A model should NOT:
- orchestrate integrations
- perform HTTP logic
- contain large business workflows

### Controllers
Use:
- `src/controllers/...`

A controller should:
- read params/body/query
- call the service
- return HTTP response
- map expected status codes

A controller should NOT:
- contain large business logic
- contain data transformation logic that belongs to services/utils
- call external APIs directly if a service already exists

### View in API context
For this backend, the "view" is:
- the route contract
- the shape of the JSON response
- the public API behavior

Prefer:
- consistent response shapes
- clear status codes
- simple payloads

Do NOT create a `views/` folder.

### Services
Use:
- `src/services/...`

A service should:
- encapsulate business logic
- orchestrate repositories/models
- integrate with external APIs
- reuse shared utils

A service should NOT:
- own HTTP concerns
- directly parse Fastify request/reply objects

### Routes
Use:
- `src/routes/...`

Routes should:
- register endpoints
- connect middleware
- call controllers
- declare schema when practical

Do not move business logic into routes.

### Utils
Use:
- `src/utils/*`
- `src/services/hubspot/utils/*` for feature-local helpers

Move to utils only if logic is:
- pure
- reusable
- not tied to request context
- not tied to persistence

Examples:
- string normalization
- email fallback generation
- retry helpers
- batch helpers

Do NOT move logic to utils if it contains:
- DB access
- orchestration
- tenant resolution
- business workflows

## API design rules

- Follow REST-style naming where it fits the current codebase.
- Keep endpoints predictable.
- Prefer one controller per resource area.
- Prefer one service per business capability.
- Keep responses consistent.
- Add validation where it truly protects the boundary.
- Do not add excessive validation for already controlled internal flows.
- Reuse middleware for auth/tenant concerns.
- Reuse existing logger and config modules.

## Preferred implementation style

- functions and plain objects over unnecessary classes
- simple composition over abstraction-heavy patterns
- explicit code over “magic”
- modular files over god files

## Anti-patterns to avoid

- creating new architectural layers without need
- fat controllers
- god services
- duplicated validation everywhere
- helper functions mixed into large orchestration files
- creating `repositories`, `presenters`, `views`, `domain`, or `use-cases` folders unless explicitly requested
- moving too much into utils

## When generating new API code

Always decide:

1. Is this persistence? -> model
2. Is this HTTP input/output? -> controller/route
3. Is this business logic or integration? -> service
4. Is this pure reusable helper? -> utils

## Expected output when asked to create/refactor APIs

Provide:
- files to create/update
- final location of each responsibility
- concise explanation of why each piece belongs there
- code aligned to existing project structure