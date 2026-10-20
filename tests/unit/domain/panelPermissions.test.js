import { PANEL_PERMISSIONS, permissionsFor } from '../../../src/domain/panel/permissions.js';
import {
  ACCOUNT_TYPES,
  CLIENT_ROLES,
  isValidEmail,
  normalizeEmail,
} from '../../../src/domain/panel/accounts.js';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validateNewPassword,
} from '../../../src/domain/panel/passwordPolicy.js';
import { PanelEmailTakenError } from '../../../src/domain/panel/errors.js';

const CLIENT_PERMISSIONS = [
  'tickets.read',
  'tickets.create',
  'tickets.reply',
  'tickets.reopen',
  'events.read',
  'syncs.read',
  'mappings.read',
  'tasks.read',
];

const STAFF_PERMISSIONS = [
  'events.read',
  'syncs.read',
  'mappings.read',
  'tasks.read',
  'staff.tickets',
  'staff.users',
  'staff.events.raw',
];

describe('panel permissions', () => {
  it('exposes the phase 1 permission names', () => {
    expect(Object.isFrozen(PANEL_PERMISSIONS)).toBe(true);
    expect(PANEL_PERMISSIONS.STAFF_USERS).toBe('staff.users');
    expect(PANEL_PERMISSIONS.TICKETS_READ).toBe('tickets.read');
    expect(PANEL_PERMISSIONS.STAFF_EVENTS_RAW).toBe('staff.events.raw');
    expect(PANEL_PERMISSIONS.MAPPINGS_READ).toBe('mappings.read');
    expect(PANEL_PERMISSIONS.TASKS_READ).toBe('tasks.read');
  });

  it('gives smarteam accounts the staff permissions and no client ticket permissions', () => {
    const permissions = permissionsFor({ accountType: 'smarteam', role: null });

    expect([...permissions].sort()).toEqual([...STAFF_PERMISSIONS].sort());
    expect(permissions.some((permission) => permission.startsWith('tickets.'))).toBe(false);
  });

  it.each(['admin', 'usuario'])('gives a cliente %s the same phase 1 permissions', (role) => {
    const permissions = permissionsFor({ accountType: 'cliente', role });

    expect([...permissions].sort()).toEqual([...CLIENT_PERMISSIONS].sort());
    expect(permissions.some((permission) => permission.startsWith('staff.'))).toBe(false);
  });

  it.each([
    [{ accountType: 'cliente', role: null }],
    [{ accountType: 'cliente', role: 'jefe' }],
    [{ accountType: 'otro', role: 'admin' }],
    [{}],
  ])('returns no permissions for an unknown combination %o', (input) => {
    expect(permissionsFor(input)).toEqual([]);
  });

  it('returns a fresh array each time so callers cannot mutate the table', () => {
    const first = permissionsFor({ accountType: 'smarteam' });
    first.push('config.edit');

    expect(permissionsFor({ accountType: 'smarteam' })).not.toContain('config.edit');
  });
});

describe('panel accounts', () => {
  it('lists the account types and client roles', () => {
    expect(ACCOUNT_TYPES).toEqual({ SMARTEAM: 'smarteam', CLIENTE: 'cliente' });
    expect(CLIENT_ROLES).toEqual(['admin', 'usuario']);
  });

  it('normalizes emails to trimmed lowercase', () => {
    expect(normalizeEmail('  Ana.Perez@Acme.TEST ')).toBe('ana.perez@acme.test');
    expect(normalizeEmail(undefined)).toBe('');
    expect(normalizeEmail(null)).toBe('');
  });

  it.each([
    ['ana@acme.test', true],
    ['ana.perez+soporte@acme.co.cr', true],
    ['ana@acme', false],
    ['ana acme.test', false],
    ['@acme.test', false],
    ['', false],
    [`${'a'.repeat(250)}@acme.test`, false],
  ])('validates %s as %s', (email, expected) => {
    expect(isValidEmail(email)).toBe(expected);
  });
});

describe('panel password policy', () => {
  it('uses 10 to 200 characters', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    expect(PASSWORD_MAX_LENGTH).toBe(200);
  });

  it('accepts a new password that respects the policy', () => {
    expect(validateNewPassword({ newPassword: 'una-clave-larga', currentPassword: 'Temporal123456' })).toBeNull();
  });

  it('rejects a short password', () => {
    expect(validateNewPassword({ newPassword: 'corta', currentPassword: 'x' }))
      .toBe('Debe tener al menos 10 caracteres.');
  });

  it('rejects a password longer than 200 characters', () => {
    expect(validateNewPassword({ newPassword: 'a'.repeat(201), currentPassword: 'x' }))
      .toBe('Debe tener como máximo 200 caracteres.');
  });

  it('rejects a password equal to the current one', () => {
    expect(validateNewPassword({ newPassword: 'Temporal123456', currentPassword: 'Temporal123456' }))
      .toBe('La contraseña nueva debe ser distinta de la actual.');
  });

  it('rejects a missing password', () => {
    expect(validateNewPassword({ newPassword: undefined, currentPassword: 'x' }))
      .toBe('Debe tener al menos 10 caracteres.');
  });
});

describe('panel errors', () => {
  it('marks a duplicated email with a stable code', () => {
    const error = new PanelEmailTakenError();

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('PANEL_EMAIL_TAKEN');
  });
});
