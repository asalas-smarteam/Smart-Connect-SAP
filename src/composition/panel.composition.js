import { assertPort } from '#application/ports/port-validator.js';
import { PanelUserRepositoryPort } from '#application/ports/panel/panel-user-repository.port.js';
import { PasswordHasherPort } from '#application/ports/panel/password-hasher.port.js';
import { SessionTokenPort } from '#application/ports/panel/session-token.port.js';
import { LoginAttemptsPort } from '#application/ports/panel/login-attempts.port.js';
import { TenantDirectoryPort } from '#application/ports/panel/tenant-directory.port.js';
import { TemporaryPasswordGeneratorPort } from '#application/ports/panel/temporary-password-generator.port.js';
import LoginPanelUser from '#application/use-cases/panel/LoginPanelUser.js';
import ResolvePanelSession from '#application/use-cases/panel/ResolvePanelSession.js';
import GetPanelSession from '#application/use-cases/panel/GetPanelSession.js';
import ChangePanelPassword from '#application/use-cases/panel/ChangePanelPassword.js';
import ManagePanelUsers from '#application/use-cases/panel/ManagePanelUsers.js';
import ListPanelTenants from '#application/use-cases/panel/ListPanelTenants.js';
import MongoosePanelUserRepository from '#infrastructure/database/repositories/MongoosePanelUserRepository.js';
import SaaSClientTenantDirectory from '#infrastructure/database/repositories/SaaSClientTenantDirectory.js';
import ScryptPasswordHasher from '#infrastructure/auth/ScryptPasswordHasher.js';
import HmacSessionToken from '#infrastructure/auth/HmacSessionToken.js';
import RedisLoginAttempts from '#infrastructure/auth/RedisLoginAttempts.js';
import RandomTemporaryPassword from '#infrastructure/auth/RandomTemporaryPassword.js';
import MongoosePanelAuditLog from '#infrastructure/database/repositories/MongoosePanelAuditLog.js';
import MongooseRevokedSessionStore from '#infrastructure/database/repositories/MongooseRevokedSessionStore.js';
import { RevokedSessionStorePort } from '#application/ports/panel/revoked-session-store.port.js';
import LogoutPanelSession from '#application/use-cases/panel/LogoutPanelSession.js';
import { PanelAuditLogPort } from '#application/ports/panel/audit-log.port.js';
import panelConfig from '#infrastructure/config/panel.config.js';
import mongoConfig from '#infrastructure/config/mongo.config.js';
import defaultLogger from '#infrastructure/logger/logger.adapter.js';
import { TicketRepositoryPort } from '#application/ports/panel/ticket-repository.port.js';
import { TicketAttachmentStorePort } from '#application/ports/panel/ticket-attachment-store.port.js';
import { TicketContextReaderPort } from '#application/ports/panel/ticket-context-reader.port.js';
import ClientTickets from '#application/use-cases/panel/ClientTickets.js';
import StaffTickets from '#application/use-cases/panel/StaffTickets.js';
import StaffInbox from '#application/use-cases/panel/StaffInbox.js';
import TicketMetrics from '#application/use-cases/panel/TicketMetrics.js';
import MongooseTicketRepository from '#infrastructure/database/repositories/MongooseTicketRepository.js';
import GridFsTicketAttachmentStore from '#infrastructure/database/repositories/GridFsTicketAttachmentStore.js';
import TenantTicketContextReader from '#infrastructure/database/repositories/TenantTicketContextReader.js';
import TenantOperationsReader from '#infrastructure/database/repositories/TenantOperationsReader.js';
import { OperationsReaderPort } from '#application/ports/panel/operations-reader.port.js';
import PanelOperations from '#application/use-cases/panel/PanelOperations.js';
import { FieldMappingReaderPort } from '#application/ports/panel/field-mapping-reader.port.js';
import PanelFieldMappings from '#application/use-cases/panel/PanelFieldMappings.js';
import { ScheduledTaskReaderPort } from '#application/ports/panel/scheduled-task-reader.port.js';
import { ScheduledRunReaderPort } from '#application/ports/panel/scheduled-run-reader.port.js';
import PanelScheduledTasks from '#application/use-cases/panel/PanelScheduledTasks.js';
import BullMqScheduledRunReader from '#infrastructure/queue/BullMqScheduledRunReader.js';

// Nada se construye al importar este módulo: si falta PANEL_JWT_SECRET, el plugin del panel no
// llama a buildPanelUseCases y el arranque del servidor no se entera.

// Sin secreto: la usa también scripts/create-panel-staff.mjs.
export function buildManagePanelUsers({
  userRepository = new MongoosePanelUserRepository(),
  tenantDirectory = new SaaSClientTenantDirectory(),
  passwordHasher = new ScryptPasswordHasher(),
  temporaryPasswordGenerator = new RandomTemporaryPassword(),
  auditLog = new MongoosePanelAuditLog(),
} = {}) {
  return new ManagePanelUsers({
    userRepository: assertPort(userRepository, PanelUserRepositoryPort),
    tenantDirectory: assertPort(tenantDirectory, TenantDirectoryPort),
    passwordHasher: assertPort(passwordHasher, PasswordHasherPort),
    temporaryPasswordGenerator: assertPort(temporaryPasswordGenerator, TemporaryPasswordGeneratorPort),
    auditLog: assertPort(auditLog, PanelAuditLogPort),
  });
}

// Soporte: tickets de cliente, acciones de Smarteam y bandeja. Los adaptadores reales no abren
// ninguna conexión al construirse: lo hacen en el primer uso, con el tenant ya validado.
export function buildPanelTicketUseCases({
  tenantDirectory = new SaaSClientTenantDirectory(),
  ticketRepository = new MongooseTicketRepository(),
  attachmentStore = new GridFsTicketAttachmentStore(),
  contextReader = new TenantTicketContextReader(),
  tenantDbPrefix = mongoConfig.tenantDbPrefix,
  inboxTenantTimeoutMs,
  logger = defaultLogger,
} = {}) {
  assertPort(tenantDirectory, TenantDirectoryPort);
  assertPort(ticketRepository, TicketRepositoryPort);
  assertPort(attachmentStore, TicketAttachmentStorePort);
  assertPort(contextReader, TicketContextReaderPort);

  return {
    clientTickets: new ClientTickets({ ticketRepository, attachmentStore, contextReader, tenantDbPrefix }),
    staffTickets: new StaffTickets({ ticketRepository, attachmentStore, tenantDirectory }),
    staffInbox: new StaffInbox({
      ticketRepository,
      tenantDirectory,
      logger,
      ...(inboxTenantTimeoutMs ? { tenantTimeoutMs: inboxTenantTimeoutMs } : {}),
    }),
    ticketMetrics: new TicketMetrics({
      ticketRepository,
      tenantDirectory,
      logger,
      ...(inboxTenantTimeoutMs ? { tenantTimeoutMs: inboxTenantTimeoutMs } : {}),
    }),
  };
}

// Eventos, syncs y tareas: solo lectura, con el driver nativo sobre la conexión del tenant.
export function buildPanelOperationUseCases({
  tenantDirectory = new SaaSClientTenantDirectory(),
  operationsReader = new TenantOperationsReader(),
  logger = defaultLogger,
} = {}) {
  assertPort(tenantDirectory, TenantDirectoryPort);
  assertPort(operationsReader, OperationsReaderPort);
  return { operations: new PanelOperations({ operationsReader, tenantDirectory, logger }) };
}

// Mapeo de campos (plan 6): solo lectura. TenantOperationsReader también implementa este puerto.
export function buildPanelFieldMappingUseCases({
  tenantDirectory = new SaaSClientTenantDirectory(),
  fieldMappingReader = new TenantOperationsReader(),
  logger = defaultLogger,
} = {}) {
  assertPort(tenantDirectory, TenantDirectoryPort);
  assertPort(fieldMappingReader, FieldMappingReaderPort);
  return { fieldMappings: new PanelFieldMappings({ fieldMappingReader, tenantDirectory, logger }) };
}

// Tareas programadas (plan 7): solo lectura. TenantOperationsReader implementa la lectura de
// ClientConfigs; las próximas ejecuciones salen de BullMQ (Redis), también solo lectura.
export function buildPanelScheduledTaskUseCases({
  tenantDirectory = new SaaSClientTenantDirectory(),
  scheduledTaskReader = new TenantOperationsReader(),
  scheduledRunReader = new BullMqScheduledRunReader(),
  logger = defaultLogger,
} = {}) {
  assertPort(tenantDirectory, TenantDirectoryPort);
  assertPort(scheduledTaskReader, ScheduledTaskReaderPort);
  assertPort(scheduledRunReader, ScheduledRunReaderPort);
  return {
    scheduledTasks: new PanelScheduledTasks({ scheduledTaskReader, scheduledRunReader, tenantDirectory, logger }),
  };
}

export function buildPanelUseCases({
  secret,
  sessionTtlSeconds = panelConfig.sessionTtlSeconds,
  userRepository = new MongoosePanelUserRepository(),
  tenantDirectory = new SaaSClientTenantDirectory(),
  passwordHasher = new ScryptPasswordHasher(),
  temporaryPasswordGenerator = new RandomTemporaryPassword(),
  auditLog = new MongoosePanelAuditLog(),
  revokedSessions = new MongooseRevokedSessionStore(),
  loginAttempts = new RedisLoginAttempts({
    maxAttempts: panelConfig.loginEmailMaxAttempts,
    windowSeconds: panelConfig.loginWindowSeconds,
  }),
  // El límite por IP solo se arma si hay proxies de confianza (lo decide el plugin).
  ipLimitEnabled = false,
  ipLoginAttempts = ipLimitEnabled
    ? new RedisLoginAttempts({
      keyPrefix: 'panel:login:ip:',
      maxAttempts: panelConfig.loginIpMaxAttempts,
      windowSeconds: panelConfig.loginWindowSeconds,
    })
    : null,
  sessionToken = new HmacSessionToken({ secret, ttlSeconds: sessionTtlSeconds }),
  ticketRepository,
  attachmentStore,
  contextReader,
  tenantDbPrefix,
  inboxTenantTimeoutMs,
  logger,
  operationsReader,
  fieldMappingReader,
  scheduledTaskReader,
  scheduledRunReader,
} = {}) {
  assertPort(userRepository, PanelUserRepositoryPort);
  assertPort(tenantDirectory, TenantDirectoryPort);
  assertPort(passwordHasher, PasswordHasherPort);
  assertPort(sessionToken, SessionTokenPort);
  assertPort(loginAttempts, LoginAttemptsPort);
  assertPort(auditLog, PanelAuditLogPort);
  assertPort(revokedSessions, RevokedSessionStorePort);
  if (ipLoginAttempts) {
    assertPort(ipLoginAttempts, LoginAttemptsPort);
  }

  return {
    login: new LoginPanelUser({
      userRepository,
      tenantDirectory,
      passwordHasher,
      sessionToken,
      loginAttempts,
      ipLoginAttempts,
      auditLog,
    }),
    resolveSession: new ResolvePanelSession({ userRepository, sessionToken, revokedSessions }),
    logout: new LogoutPanelSession({ sessionToken, revokedSessions, auditLog }),
    getSession: new GetPanelSession({ userRepository, tenantDirectory }),
    changePassword: new ChangePanelPassword({ userRepository, passwordHasher, sessionToken, auditLog }),
    manageUsers: buildManagePanelUsers({
      userRepository,
      tenantDirectory,
      passwordHasher,
      temporaryPasswordGenerator,
      auditLog,
    }),
    listTenants: new ListPanelTenants({ tenantDirectory }),
    ...buildPanelTicketUseCases({
      tenantDirectory,
      ticketRepository,
      attachmentStore,
      contextReader,
      tenantDbPrefix,
      inboxTenantTimeoutMs,
      logger,
    }),
    ...buildPanelOperationUseCases({ tenantDirectory, operationsReader, logger }),
    ...buildPanelFieldMappingUseCases({ tenantDirectory, fieldMappingReader, logger }),
    ...buildPanelScheduledTaskUseCases({ tenantDirectory, scheduledTaskReader, scheduledRunReader, logger }),
  };
}

export default buildPanelUseCases;
