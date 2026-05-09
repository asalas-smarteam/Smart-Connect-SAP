# Changelog

All notable changes to this project will be documented in this file.

This changelog was initialized from the available git history. The repository does not currently have release tags, so the first entry summarizes the current `package.json` version and recent project history.

## [Unreleased]

### Added

- Add the base hexagonal architecture structure with `application`, `domain`, `ports`, `infrastructure`, `interfaces`, `shared`, and `main` layers.
- Add application use cases for health checks, tenant provisioning, HubSpot OAuth, HubSpot associations, webhook intake and processing, SAP sync, line item price sync, SAP credentials, client configs, and mapping management.
- Add infrastructure adapters for MongoDB repositories, SAP Service Layer operations, HubSpot clients, BullMQ queues, tenant resolution, tenant locks, logging, schedulers, and webhook processing.
- Add active HTTP routes and controllers under `src/interfaces/http` while keeping legacy controller exports as compatibility facades.
- Add interface-level BullMQ job processors for SAP sync and webhook tenant processing.
- Add shared application errors and utility helpers for framework-independent domain and application logic.
- Add centralized app, queue, Redis, Mongo, and infrastructure configuration modules.
- Add a lightweight application container for composing repositories, queues, services, and external adapters.
- Add architecture documentation for the in-place hexagonal multi-tenant migration.
- Add architecture boundary tests that block debug routes, legacy controller imports from active routes, and direct infrastructure dependencies in guarded layers.
- Add a hexagonal line item price synchronization use case with injected SAP, HubSpot, and tenant configuration ports.
- Add infrastructure adapters for tenant line item price configuration, SAP price retrieval, and HubSpot price/stock updates.
- Add unit coverage for line item price synchronization through application-layer fakes.
- Add the `api-design-principles` project skill for API design guidance.
- Add product sync strategies for SAP-to-HubSpot product loading, including default one-to-one sync and one-to-many sync by configured SAP price lists.
- Add tenant configuration loading for `productSyncStrategy` with default `oneToOne_Product` behavior and validation through the product strategy factory.
- Add SAP product price-list adapter support for resolving configured item prices during product sync without changing line item price APIs.

### Changed

- Move active route registration from `src/routes` to `src/interfaces/http/routes`.
- Move active HTTP controller behavior into the interface layer and thin legacy controllers down to re-export facades.
- Move Fastify lifecycle startup for external connections, SAP sync scheduling, and webhook processing into `bootstrap/appLifecycle.bootstrap.js`.
- Refactor server and worker startup to use infrastructure database, queue, tenant database, and logger adapters.
- Refactor SAP sync workers to execute an interface job processor with tenant locking, lock renewal, execution metadata, and structured completion/failure logging.
- Refactor HubSpot webhook queue processing through an interface job processor and infrastructure tenant processor adapter.
- Refactor webhook event batch processing so the existing `webhookProcessor` facade delegates retry, status, and summary handling to the application layer.
- Refactor individual HubSpot webhook event processing into an application use case with domain order building and SAP/HubSpot/webhook reference adapters.
- Refactor `lineItemPrice.service` into a compatibility facade that composes the new hexagonal use case and adapters.
- Refactor mapping, SAP sync, HubSpot sync, and HubSpot association flows behind application services or use cases while retaining legacy service entry points.
- Route only product SAP syncs through the new product strategy factory while keeping contact, company, deal, and line item price flows unchanged.
- Update test fixtures to match the current Service Layer, OAuth, mapping, HubSpot auth, SAP service, and tenant provisioning contracts.
- Harden Mongo-backed integration tests by using valid ObjectId plan IDs, local MongoMemoryServer binding, disabled background webhook cron, and explicit queue/Redis cleanup.

### Removed

- Remove active debug and test HTTP routes for association tests, database tests, echo, HubSpot tests, and legacy test endpoints.
- Remove the legacy `src/routes` route registry from active API startup.

### Fixed

- Validate and queue HubSpot `createDeal` webhook events through tenant-aware application logic, including duplicate-event handling and portal/tenant checks.
- Remove noisy SAP order payload logging from webhook processing.
- Fix test suite reliability by closing queue and Redis resources after integration tests.

## [1.3.19] - 2026-04-30

### Added

- Add multi-tenant MongoDB architecture with master and tenant data models.
- Add tenant provisioning flows with default configuration seeding.
- Add tenant-safe CRUD APIs for mapping entities.
- Add SAP Service Layer URL building with configurable filters.
- Add default SAP filter models, startup seeding, and tenant replication.
- Add Redis-backed SAP session management with tenant locking.
- Add HubSpot webhook intake and processing routes.
- Add webhook processing for creating SAP deals from HubSpot deal events.
- Add BullMQ queues and worker flows for background synchronization tasks.
- Add SAP credential CRUD support.
- Add automatic HubSpot field creation required by the integration.
- Add HubSpot pipeline and deal-stage loading.
- Add source-context-aware mappings, including company contact and employee mapping flows.
- Add product price-list webhook support and stock synchronization features.
- Add synchronization logs for integration activity.

### Changed

- Switch database configuration and model usage from Sequelize/MySQL toward MongoDB/Mongoose.
- Refactor tenant model usage across logging, health checks, and database exports.
- Refactor HubSpot service and mapping logic for clearer service boundaries.
- Decouple service-layer mapping lookup from client configuration records.
- Rename deal-owner mapping modules to owner mapping.
- Enforce unique field mappings and remove direction-flow scaffolding.
- Adjust deal mapping indexes to support nullable SAP keys.
- Extend company synchronization with SAP contacts and nested mappings.
- Add `startswith` support and default Federal Tax ID rules for SAP filters.
- Replace summed stock loading with separate HubSpot stock columns.
- Update product handling to support different prices.
- Update deal price calculation from the price-list webhook flow.
- Update SAP order data to use `DocDueDate` where required.
- Update Docker and Redis-related configuration for the current runtime.

### Fixed

- Fix SAP business partner loading.
- Fix SAP order creation and HubSpot-to-SAP order sending issues.
- Fix HubSpot webhook insertion and processing issues.
- Fix contact and company update flows.
- Fix SAP filter URL generation.
- Fix BullMQ queue behavior and avoid loading duplicate tasks.
- Fix refresh-token handling.
- Fix price-list API edge cases.
- Fix duplicate `ClientConfig` creation during OAuth initialization.
- Fix tenant resolver hook style and tenant ID fallback behavior.
- Fix mapping defaults for companies and contact-employee flows.
- Fix webhook controller errors.

### Notes

- No release tags were available when this changelog was created. Future entries should be added under `Unreleased` first, then moved under a dated version heading when a release is cut.
