# Changelog

All notable changes to this project will be documented in this file.

This changelog was initialized from the available git history. The repository does not currently have release tags, so the first entry summarizes the current `package.json` version and recent project history.

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
