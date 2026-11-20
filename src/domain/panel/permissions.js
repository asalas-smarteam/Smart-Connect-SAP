import { ACCOUNT_TYPES, isClientRole } from './accounts.js';

// Las rutas del panel se protegen por permiso, no por nombre de rol: cuando en la Fase 2 el
// admin del cliente gane acciones que el usuario no tiene, solo cambia esta tabla.
export const PANEL_PERMISSIONS = Object.freeze({
  TICKETS_READ: 'tickets.read',
  TICKETS_CREATE: 'tickets.create',
  TICKETS_REPLY: 'tickets.reply',
  TICKETS_REOPEN: 'tickets.reopen',
  EVENTS_READ: 'events.read',
  SYNCS_READ: 'syncs.read',
  // Plan 6 (contrato 08): vista de mapeo de campos, solo lectura.
  MAPPINGS_READ: 'mappings.read',
  // Plan 7 (contrato 09): vista de tareas programadas, solo lectura.
  TASKS_READ: 'tasks.read',
  // Plan 12 (contrato 14, O1): editar códigos del ERP del mapeo de responsables y traer del CRM
  // los que faltan. Smarteam y el admin del cliente; el usuario del cliente no.
  OWNERS_WRITE: 'owners.write',
  STAFF_TICKETS: 'staff.tickets',
  STAFF_USERS: 'staff.users',
  STAFF_EVENTS_RAW: 'staff.events.raw',
});

const P = PANEL_PERMISSIONS;

const STAFF_PERMISSIONS = Object.freeze([
  P.EVENTS_READ,
  P.SYNCS_READ,
  P.MAPPINGS_READ,
  P.TASKS_READ,
  P.OWNERS_WRITE,
  P.STAFF_TICKETS,
  P.STAFF_USERS,
  P.STAFF_EVENTS_RAW,
]);

// Fase 1 compartía todo; desde el plan 12 el admin del cliente además puede editar el mapeo de
// responsables (owners.write). El usuario se queda con la lectura.
const CLIENT_PERMISSIONS_BY_ROLE = Object.freeze({
  admin: Object.freeze([
    P.TICKETS_READ,
    P.TICKETS_CREATE,
    P.TICKETS_REPLY,
    P.TICKETS_REOPEN,
    P.EVENTS_READ,
    P.SYNCS_READ,
    P.MAPPINGS_READ,
    P.TASKS_READ,
    P.OWNERS_WRITE,
  ]),
  usuario: Object.freeze([
    P.TICKETS_READ,
    P.TICKETS_CREATE,
    P.TICKETS_REPLY,
    P.TICKETS_REOPEN,
    P.EVENTS_READ,
    P.SYNCS_READ,
    P.MAPPINGS_READ,
    P.TASKS_READ,
  ]),
});

export function permissionsFor({ accountType, role } = {}) {
  if (accountType === ACCOUNT_TYPES.SMARTEAM) {
    return [...STAFF_PERMISSIONS];
  }

  if (accountType === ACCOUNT_TYPES.CLIENTE && isClientRole(role)) {
    return [...CLIENT_PERMISSIONS_BY_ROLE[role]];
  }

  return [];
}
