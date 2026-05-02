---
name: hexagonal-multitenant-nodejs
description: >
  Implementa arquitectura hexagonal (ports & adapters) combinada con diseño multi-tenant
  en Node.js usando JavaScript. Aplica separación de responsabilidades, bajo acoplamiento,
  dominio desacoplado de infraestructura y soporte para múltiples tenants con aislamiento de datos.
version: 1.0.0
---
tags:
  - architecture
  - hexagonal
  - multi-tenant
  - nodejs
  - backend
  - clean-architecture

skill:
  objective:
    - Implementar arquitectura hexagonal (Ports & Adapters)
    - Diseñar sistema multi-tenant escalable
    - Separar dominio, aplicación e infraestructura
    - Evitar acoplamiento a frameworks

  principles:
    - name: dominio_puro
      rules:
        - No depender de frameworks (Express, Fastify)
        - No depender de base de datos
        - No depender de servicios externos

    - name: inversion_dependencias
      rules:
        - El dominio define interfaces (ports)
        - Infraestructura implementa adapters

    - name: multi_tenant_desacoplado
      rules:
        - El tenant es contexto, no lógica
        - No hardcodear tenant
        - No mezclar tenant en dominio

  structure:
    folders:
      - src/domain/entities
      - src/domain/value-objects
      - src/domain/services
      - src/domain/ports/input
      - src/domain/ports/output
      - src/application/use-cases
      - src/application/dtos
      - src/infrastructure/database
      - src/infrastructure/repositories
      - src/infrastructure/external-services
      - src/infrastructure/config
      - src/interfaces/http/controllers
      - src/interfaces/http/routes
      - src/interfaces/middlewares
      - src/shared/utils
      - src/shared/errors
      - src/main.js

  hexagonal:
    domain_example: |
      // domain/entities/User.js
      export class User {
        constructor({ id, email }) {
          this.id = id;
          this.email = email;
        }

        isValidEmail() {
          return this.email.includes('@');
        }
      }

    port_example: |
      // domain/ports/output/UserRepository.js
      export class UserRepository {
        async save(user) {
          throw new Error('Not implemented');
        }

        async findByEmail(email) {
          throw new Error('Not implemented');
        }
      }

    use_case_example: |
      // application/use-cases/CreateUser.js
      export class CreateUser {
        constructor({ userRepository }) {
          this.userRepository = userRepository;
        }

        async execute(data) {
          const user = new User(data);

          if (!user.isValidEmail()) {
            throw new Error('Invalid email');
          }

          return this.userRepository.save(user);
        }
      }

    adapter_example: |
      // infrastructure/repositories/MongoUserRepository.js
      export class MongoUserRepository {
        constructor({ db }) {
          this.db = db;
        }

        async save(user) {
          return this.db.collection('users').insertOne(user);
        }
      }

    controller_example: |
      // interfaces/http/controllers/UserController.js
      export class UserController {
        constructor({ createUser }) {
          this.createUser = createUser;
        }

        async create(req, reply) {
          const result = await this.createUser.execute(req.body);
          return reply.send(result);
        }
      }

  multi_tenant:
    tenant_context: |
      // shared/context/tenantContext.js
      export function getTenantContext(req) {
        return {
          tenantId: req.headers['x-tenant-id'],
        };
      }

    connection_factory: |
      // infrastructure/database/mongoTenantConnection.js
      const connections = {};

      export function getConnection(tenantId) {
        if (!connections[tenantId]) {
          connections[tenantId] = createMongoConnection(tenantId);
        }
        return connections[tenantId];
      }

    runtime_injection: |
      // main.js
      const tenantId = req.headers['x-tenant-id'];

      const db = getConnection(tenantId);

      const userRepository = new MongoUserRepository({ db });

      const createUser = new CreateUser({ userRepository });

  anti_patterns:
    - No poner lógica en controllers
    - No acceder a DB desde use-cases
    - No usar variables globales para tenant
    - No mezclar tenant en dominio
    - No acoplar dominio a DB

  patterns:
    - Dependency Injection manual
    - Factory pattern para tenant
    - Repository pattern
    - Use case pattern
    - Context per request

  testing:
    example: |
      const fakeRepo = {
        save: async (user) => user,
      };

      const useCase = new CreateUser({ userRepository: fakeRepo });

      await useCase.execute({ email: 'test@test.com' });

  codex_rules:
    - No crear carpetas innecesarias
    - Reutilizar estructura existente
    - Separar domain/application/infrastructure
    - Crear ports antes que adapters
    - Implementar multi-tenant desde inicio
    - No usar TypeScript
    - No sobrevalidar datos

  expected_output:
    - Crear Entity
    - Crear Port
    - Crear Use Case
    - Crear Adapter
    - Crear Controller
    - Mantener bajo acoplamiento
    - Mantener alta cohesión
    - Soporte multi-tenant